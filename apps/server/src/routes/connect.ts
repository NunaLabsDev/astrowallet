import {
  ClassicAddressSchema,
  ConnectAccountSummarySchema,
  ConnectAppMetadataSchema,
  ConnectAuthPayloadSchema,
  ConnectResultSchema,
  ConnectSignMessagePayloadSchema,
  ConnectSignXdrPayloadSchema,
  type ConnectAppMetadata,
  type ConnectAppTrustTier,
  type ConnectAuthPayload,
  type ConnectResult,
  type ConnectSignMessagePayload,
  type ConnectSignXdrPayload,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  buildSafeTelegramReturnUrl,
  buildTelegramMiniAppConnectLink,
  formatAstroAuthMessage,
  signConnectRequestToken,
  verifyAstroConnectAuthProof,
  verifyConnectRequestToken,
  verifyConnectSignature,
} from "@astrowallet/tg-protocol";
import type { KVNamespace } from "@cloudflare/workers-types";
import { FeeBumpTransaction, Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { constantTimeEqual, sha256Hex } from "../lib/crypto-utils.js";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import { checkRateLimit, clientKeyFromHeaders } from "../rate-limit.js";
import {
  verifyTransactionConfirmed,
  type ExpectedTxMatch,
  type FetchLike,
  type TxVerificationResult,
} from "../stellar-verifier.js";
import { runScanTarget } from "./proxy.js";
import { authenticateMiniAppSession } from "./tg-auth.js";

export interface ConnectRoutesDeps {
  fetchFn?: FetchLike | undefined;
  verifyTxFn?:
    | ((
        config: Pick<ServerConfig, "horizonUrls" | "rpcUrls" | "networkPassphrase">,
        txHash: string,
        expected?: ExpectedTxMatch,
      ) => Promise<TxVerificationResult>)
    | undefined;
}

export type ConnectRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

const CreateConnectRequestBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("auth"),
    app: ConnectAppMetadataSchema,
    payload: ConnectAuthPayloadSchema,
    ttlSeconds: z.number().int().min(60).max(300).optional(),
  }),
  z.object({
    action: z.literal("sign_message"),
    app: ConnectAppMetadataSchema,
    payload: ConnectSignMessagePayloadSchema,
    ttlSeconds: z.number().int().min(60).max(300).optional(),
  }),
  z.object({
    action: z.literal("sign_xdr"),
    app: ConnectAppMetadataSchema,
    payload: ConnectSignXdrPayloadSchema,
    ttlSeconds: z.number().int().min(60).max(300).optional(),
  }),
]);

const CompleteConnectRequestBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{32}$/i),
  status: z.enum(["approved", "rejected"]),
  reason: z.string().trim().max(280).optional(),
  address: ClassicAddressSchema.optional(),
  accounts: z.array(ConnectAccountSummarySchema).max(10).optional(),
  signatureBase64: z.string().trim().min(16).max(256).optional(),
  signedXdr: z.string().trim().min(16).max(49_152).optional(),
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/).optional(),
  ledger: z.number().int().positive().optional(),
});

function randomHex(byteCount: number): string {
  const bytes = new Uint8Array(byteCount);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function resolveTrustTier(
  config: ServerConfig,
  app: ConnectAppMetadata,
  ecosystemSecretHeader: string,
): ConnectAppTrustTier {
  if (
    config.ecosystemSharedIntentSecret &&
    ecosystemSecretHeader &&
    constantTimeEqual(ecosystemSecretHeader, config.ecosystemSharedIntentSecret)
  ) {
    return "official";
  }
  if (config.connectVerifiedBots.includes(app.botUsername.toLowerCase())) {
    return "verified";
  }
  return "external";
}

function safeParseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

export function createConnectRoutes(deps: ConnectRoutesDeps = {}): Hono<ConnectRouteEnv> {
  const router = new Hono<ConnectRouteEnv>();

  router.post("/requests", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");

    const clientKey = clientKeyFromHeaders(c.req.raw.headers);
    const rate = await checkRateLimit({
      repository: repo,
      scope: "connect_create",
      clientKey,
      limitPerMin: config.proxyRateLimitPerMin,
    });
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    let body: z.infer<typeof CreateConnectRequestBodySchema>;
    try {
      body = CreateConnectRequestBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        {
          error: "Invalid AstroConnect request payload",
          details: err instanceof Error ? err.message : undefined,
        },
        400,
      );
    }

    if (body.action === "sign_xdr") {
      const computedSha = await sha256Hex(body.payload.unsignedXdr);
      if (!constantTimeEqual(computedSha, body.payload.xdrSha256.toLowerCase())) {
        return c.json({ error: "payload.xdrSha256 does not match unsignedXdr" }, 400);
      }
    }

    const now = Math.floor(Date.now() / 1000);
    const ttl = Math.max(60, Math.min(300, body.ttlSeconds ?? 300));
    const expiresAt = now + ttl;
    const requestId = `ac_${randomHex(6)}`;
    const resultToken = randomHex(24);
    const resultTokenHash = await sha256Hex(resultToken);

    let storedPayload: Record<string, unknown>;
    let challengeMessage: string | undefined;
    if (body.action === "auth") {
      challengeMessage = formatAstroAuthMessage({
        appName: body.app.name,
        botUsername: body.app.botUsername,
        network: config.network,
        requestId,
        nonce: body.payload.nonce,
        issuedAt: now,
        expiresAt,
        domain: body.payload.domain,
        statement: body.payload.statement,
      });
      storedPayload = {
        ...body.payload,
        challengeMessage,
      };
    } else {
      storedPayload = body.payload;
    }

    const ecosystemSecret = c.req.header("X-Ecosystem-Secret")?.trim() ?? "";
    const trustTier = resolveTrustTier(config, body.app, ecosystemSecret);
    const sig = await signConnectRequestToken(
      { requestId, network: config.network, expiresAt },
      config.intentHmacSecret,
    );

    await repo.createConnectRequest({
      requestId,
      network: config.network,
      action: body.action,
      status: "pending",
      trustTier,
      hmacSig: sig,
      resultTokenHash,
      appJson: JSON.stringify(body.app),
      payloadJson: JSON.stringify(storedPayload),
      expiresAt,
      createdAt: now,
      updatedAt: now,
    });

    const deepLink = buildTelegramMiniAppConnectLink({
      botUsername: config.tgBotUsername,
      shortName: config.tgMiniAppShortName,
      pwaOrigin: config.pwaOrigin,
      requestId,
      sig,
    });

    return c.json(
      {
        ok: true,
        requestId,
        network: config.network,
        action: body.action,
        trustTier,
        sig,
        resultToken,
        expiresAt,
        deepLink,
        ...(challengeMessage ? { challengeMessage } : {}),
      },
      201,
    );
  });

  router.get("/requests/:requestId", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const requestId = c.req.param("requestId");

    const record = await repo.getConnectRequest(requestId);
    if (!record) {
      return c.json({ error: "Connect request not found" }, 404);
    }

    const now = Math.floor(Date.now() / 1000);
    const connectToken = c.req.header("X-Connect-Token")?.trim();
    if (connectToken) {
      const tokenHash = await sha256Hex(connectToken);
      if (!constantTimeEqual(tokenHash, record.resultTokenHash)) {
        return c.json({ error: "Invalid X-Connect-Token" }, 401);
      }

      let effectiveStatus = record.status;
      if (effectiveStatus === "pending" && record.expiresAt <= now) {
        effectiveStatus = "expired";
        await repo.completeConnectRequest({
          requestId: record.requestId,
          status: "expired",
          updatedAt: now,
        });
      }

      const parsedResult = safeParseJson<ConnectResult>(record.resultJson);
      return c.json({
        ok: true,
        requestId: record.requestId,
        network: record.network,
        action: record.action,
        status: effectiveStatus,
        trustTier: record.trustTier,
        expiresAt: record.expiresAt,
        ...(parsedResult ? { result: parsedResult } : {}),
      });
    }

    const sig = c.req.query("sig") ?? "";
    const check = await verifyConnectRequestToken(
      {
        requestId: record.requestId,
        network: record.network,
        expiresAt: record.expiresAt,
      },
      sig,
      config.intentHmacSecret,
      now,
    );
    if (!check.valid) {
      if (check.reason === "expired" && record.status === "pending") {
        await repo.completeConnectRequest({
          requestId: record.requestId,
          status: "expired",
          updatedAt: now,
        });
      }
      return c.json(
        { error: `Connect request token ${check.reason}` },
        check.reason === "expired" ? 410 : 401,
      );
    }

    if (record.network !== config.network) {
      return c.json({ error: "Cross-network connect request rejected" }, 409);
    }

    const app = safeParseJson<ConnectAppMetadata>(record.appJson);
    const payload = safeParseJson<Record<string, unknown>>(record.payloadJson);
    if (!app || !payload) {
      return c.json({ error: "Corrupted connect request state" }, 500);
    }

    const returnUrl = buildSafeTelegramReturnUrl(app, `ac_${record.requestId}`);
    const parsedResult = safeParseJson<ConnectResult>(record.resultJson);

    return c.json({
      ok: true,
      requestId: record.requestId,
      network: record.network,
      action: record.action,
      status: record.status,
      trustTier: record.trustTier,
      app,
      payload,
      expiresAt: record.expiresAt,
      returnUrl,
      ...(parsedResult ? { result: parsedResult } : {}),
    });
  });

  router.post("/requests/:requestId/complete", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const requestId = c.req.param("requestId");

    let body: z.infer<typeof CompleteConnectRequestBodySchema>;
    try {
      body = CompleteConnectRequestBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        {
          error: "Invalid connect completion payload",
          details: err instanceof Error ? err.message : undefined,
        },
        400,
      );
    }

    const record = await repo.getConnectRequest(requestId);
    if (!record) {
      return c.json({ error: "Connect request not found" }, 404);
    }

    const now = Math.floor(Date.now() / 1000);
    const check = await verifyConnectRequestToken(
      {
        requestId: record.requestId,
        network: record.network,
        expiresAt: record.expiresAt,
      },
      body.sig,
      config.intentHmacSecret,
      now,
    );
    if (!check.valid) {
      if (check.reason === "expired" && record.status === "pending") {
        await repo.completeConnectRequest({
          requestId: record.requestId,
          status: "expired",
          updatedAt: now,
        });
      }
      return c.json(
        { error: `Connect request token ${check.reason}` },
        check.reason === "expired" ? 410 : 401,
      );
    }

    if (record.network !== config.network) {
      return c.json({ error: "Cross-network connect request rejected" }, 409);
    }
    if (record.status !== "pending") {
      return c.json({ error: `Connect request already ${record.status}` }, 409);
    }

    let responderTelegramUserId: string | undefined;
    let responderUsername: string | undefined;
    if (c.req.header("Authorization")?.trim()) {
      const session = await authenticateMiniAppSession(c);
      if (!session.ok) {
        return c.json({ error: session.error }, session.status);
      }
      responderTelegramUserId = session.claims.telegramUserId;
      responderUsername = session.claims.usernameLower;
    }

    const app = safeParseJson<ConnectAppMetadata>(record.appJson);
    if (!app) {
      return c.json({ error: "Corrupted app metadata" }, 500);
    }
    const returnUrl = buildSafeTelegramReturnUrl(app, `ac_${record.requestId}`);

    if (body.status === "rejected") {
      const rejectedResult = ConnectResultSchema.parse({
        status: "rejected",
        ...(body.reason ? { reason: body.reason } : {}),
        ...(responderTelegramUserId ? { telegramUserId: responderTelegramUserId } : {}),
        ...(responderUsername ? { username: responderUsername } : {}),
        completedAt: now,
      });

      const updated = await repo.completeConnectRequest({
        requestId: record.requestId,
        status: "rejected",
        resultJson: JSON.stringify(rejectedResult),
        responderTelegramUserId,
        updatedAt: now,
      });
      if (!updated) {
        return c.json({ error: "Connect request already completed" }, 409);
      }

      return c.json({
        ok: true,
        requestId: record.requestId,
        status: "rejected",
        completedAt: now,
        returnUrl,
      });
    }

    let resultPayload: ConnectResult;

    if (record.action === "auth") {
      const authPayload = safeParseJson<ConnectAuthPayload>(record.payloadJson);
      if (!authPayload?.challengeMessage) {
        return c.json({ error: "Corrupted auth challenge payload" }, 500);
      }
      if (!body.address || !body.signatureBase64) {
        return c.json(
          { error: "address and signatureBase64 are required for auth approval" },
          400,
        );
      }
      const sigOk = await verifyAstroConnectAuthProof({
        address: body.address,
        challengeMessage: authPayload.challengeMessage,
        signatureBase64: body.signatureBase64,
      });
      if (!sigOk) {
        return c.json({ error: "Invalid SEP-53 Ed25519 signature for auth challenge" }, 400);
      }

      resultPayload = ConnectResultSchema.parse({
        status: "approved",
        address: body.address,
        ...(authPayload.includeAccounts && body.accounts ? { accounts: body.accounts } : {}),
        ...(responderTelegramUserId ? { telegramUserId: responderTelegramUserId } : {}),
        ...(responderUsername ? { username: responderUsername } : {}),
        signedMessage: authPayload.challengeMessage,
        signatureBase64: body.signatureBase64,
        completedAt: now,
      });
    } else if (record.action === "sign_message") {
      const msgPayload = safeParseJson<ConnectSignMessagePayload>(record.payloadJson);
      if (!msgPayload?.message) {
        return c.json({ error: "Corrupted sign_message payload" }, 500);
      }
      if (!body.address || !body.signatureBase64) {
        return c.json(
          { error: "address and signatureBase64 are required for sign_message approval" },
          400,
        );
      }
      const sigOk = await verifyConnectSignature({
        address: body.address,
        message: msgPayload.message,
        signatureBase64: body.signatureBase64,
      });
      if (!sigOk) {
        return c.json({ error: "Invalid SEP-53 Ed25519 signature for message" }, 400);
      }

      resultPayload = ConnectResultSchema.parse({
        status: "approved",
        address: body.address,
        ...(responderTelegramUserId ? { telegramUserId: responderTelegramUserId } : {}),
        ...(responderUsername ? { username: responderUsername } : {}),
        signedMessage: msgPayload.message,
        signatureBase64: body.signatureBase64,
        completedAt: now,
      });
    } else {
      const xdrPayload = safeParseJson<ConnectSignXdrPayload>(record.payloadJson);
      if (!xdrPayload) {
        return c.json({ error: "Corrupted sign_xdr payload" }, 500);
      }
      let expectedUnsignedHashHex: string | null = null;
      try {
        const parsedUnsigned = TransactionBuilder.fromXDR(
          xdrPayload.unsignedXdr,
          config.networkPassphrase,
        );
        expectedUnsignedHashHex = Buffer.from(parsedUnsigned.hash())
          .toString("hex")
          .toLowerCase();
      } catch {
        return c.json({ error: "Invalid stored unsignedXdr" }, 500);
      }

      const shouldSubmit = xdrPayload.submit !== false;
      if (shouldSubmit) {
        if (!body.txHash) {
          return c.json({ error: "txHash is required when submit=true" }, 400);
        }
        const verifyFn =
          deps.verifyTxFn ??
          ((cfg, hash, expected) => verifyTransactionConfirmed(cfg, hash, deps.fetchFn, expected));
        const txCheck = await verifyFn(config, body.txHash, {
          minCreatedAtUnix: record.createdAt,
          allowSorobanRpcFallback: true,
          ...(expectedUnsignedHashHex ? { expectedTxHash: expectedUnsignedHashHex } : {}),
          ...(body.address ? { expectedSourceAccount: body.address } : {}),
        });
        if (!txCheck.confirmed) {
          return c.json({ error: txCheck.reason }, 409);
        }

        resultPayload = ConnectResultSchema.parse({
          status: "approved",
          ...(body.address ? { address: body.address } : {}),
          ...(responderTelegramUserId ? { telegramUserId: responderTelegramUserId } : {}),
          ...(responderUsername ? { username: responderUsername } : {}),
          txHash: body.txHash,
          ...(txCheck.ledger ?? body.ledger
            ? { ledger: txCheck.ledger ?? body.ledger }
            : {}),
          ...(body.signedXdr ? { signedXdr: body.signedXdr } : {}),
          completedAt: now,
        });
      } else {
        if (!body.signedXdr) {
          return c.json({ error: "signedXdr is required when submit=false" }, 400);
        }
        try {
          const parsedSigned = TransactionBuilder.fromXDR(
            body.signedXdr,
            config.networkPassphrase,
          );
          const signedInnerHash =
            parsedSigned instanceof FeeBumpTransaction
              ? Buffer.from(parsedSigned.innerTransaction.hash()).toString("hex").toLowerCase()
              : Buffer.from(parsedSigned.hash()).toString("hex").toLowerCase();
          if (signedInnerHash !== expectedUnsignedHashHex) {
            return c.json({ error: "signedXdr does not match requested unsignedXdr" }, 400);
          }
          if (body.address) {
            const kp = Keypair.fromPublicKey(body.address);
            const sigMatch = parsedSigned.signatures.some((decSig) =>
              kp.verify(
                Buffer.from(parsedSigned.hash()),
                decSig.signature as unknown as Buffer,
              ),
            );
            if (!sigMatch) {
              return c.json({ error: "signedXdr lacks valid signature from signer address" }, 400);
            }
          }
        } catch {
          return c.json({ error: "Invalid signedXdr envelope" }, 400);
        }
        resultPayload = ConnectResultSchema.parse({
          status: "approved",
          ...(body.address ? { address: body.address } : {}),
          ...(responderTelegramUserId ? { telegramUserId: responderTelegramUserId } : {}),
          ...(responderUsername ? { username: responderUsername } : {}),
          signedXdr: body.signedXdr,
          completedAt: now,
        });
      }
    }

    const updated = await repo.completeConnectRequest({
      requestId: record.requestId,
      status: "approved",
      resultJson: JSON.stringify(resultPayload),
      responderTelegramUserId,
      updatedAt: now,
    });
    if (!updated) {
      return c.json({ error: "Connect request already completed" }, 409);
    }
    await repo.incrementProductEvent({
      dayUtc: new Date().toISOString().slice(0, 10),
      network: config.network,
      eventType: "astro_connect_approved",
    });

    return c.json({
      ok: true,
      requestId: record.requestId,
      status: "approved",
      completedAt: now,
      returnUrl,
    });
  });

  router.post("/scan", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const rate = await checkRateLimit({
      repository: repo,
      cache: c.env.CACHE,
      scope: "connect_scan",
      clientKey: clientKeyFromHeaders(c.req.raw.headers),
      limitPerMin: config.proxyRateLimitPerMin,
    });
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    let body: { target?: unknown };
    try {
      body = (await c.req.json()) as { target?: unknown };
    } catch {
      return c.json({ error: "Invalid scan payload" }, 400);
    }
    const target = typeof body.target === "string" ? body.target.trim() : "";
    if (target.length < 10) {
      return c.json({ error: "Invalid scan payload" }, 400);
    }

    const result = await runScanTarget({
      config,
      cache: c.env.CACHE,
      target,
      fetchFn: deps.fetchFn,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.body);
  });

  return router;
}
