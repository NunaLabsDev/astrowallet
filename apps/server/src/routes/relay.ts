import { ClassicAddressSchema, type ServerConfig } from "@astrowallet/domain";
import {
  decodeHostFunctionXdr,
  decodeTransactionEnvelope,
  evaluateDecodedTransaction,
} from "@astrowallet/security-shield";
import { verifyConnectSignature, verifyIntentToken } from "@astrowallet/tg-protocol";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import { checkRateLimit, clientKeyFromHeaders } from "../rate-limit.js";
import type { FetchLike } from "../stellar-verifier.js";

export interface RelayRoutesDeps {
  fetchFn?: FetchLike | undefined;
}

export type RelayRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    config: ServerConfig;
    repo?: ServerRepository;
  };
};

const IntentAuthSchema = z.object({
  intentId: z.string().min(8).max(64),
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
});

const WalletAuthSchema = z.object({
  address: ClassicAddressSchema,
  timestamp: z.number().int().positive(),
  nonce: z.string().trim().min(8).max(64),
  payloadHash: z.string().regex(/^[a-f0-9]{64}$/i),
  signatureBase64: z.string().min(16),
});

const RelaySubmitSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("soroban"),
    funcXdrBase64: z.string().min(8),
    authEntriesXdrBase64: z.array(z.string().min(8)).default([]),
    intentAuth: IntentAuthSchema.optional(),
    walletAuth: WalletAuthSchema.optional(),
  }),
  z.object({
    mode: z.literal("feebump"),
    signedTxXdrBase64: z.string().min(16),
    intentAuth: IntentAuthSchema.optional(),
    walletAuth: WalletAuthSchema.optional(),
  }),
]);

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Policy-gated proxy to OpenZeppelin Stellar Channels (sponsors transaction gas fees,
 * distinct from Classic CAP-33 account reserves).
 *
 * Gates (fail closed): non-empty contract allowlist, per-IP rate limit, cryptographic
 * intentAuth or SEP-53 walletAuth (linked address + anti-replay nonce), op/fee ceilings,
 * Scan & Shield verdict, and atomic daily budget cap.
 */
export function createRelayRoutes(deps: RelayRoutesDeps = {}): Hono<RelayRouteEnv> {
  const router = new Hono<RelayRouteEnv>();
  const fetchFn = deps.fetchFn ?? fetch;

  router.post("/submit", async (c) => {
    const config = c.get("config");
    if (!config.ozChannelsApiUrl) {
      return c.json(
        { error: "OpenZeppelin Channels relayer URL (OZ_CHANNELS_API_URL) is not configured" },
        503,
      );
    }
    if (config.relayAllowedContracts.length === 0) {
      return c.json(
        { error: "RELAY_ALLOWED_CONTRACTS allowlist must be configured before relaying" },
        503,
      );
    }

    const repo = c.get("repo");
    const limit = await checkRateLimit({
      repository: repo,
      cache: c.env.CACHE,
      scope: "relay",
      clientKey: clientKeyFromHeaders(c.req.raw.headers),
      limitPerMin: config.relayRateLimitPerMin,
    });
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return c.json({ error: "Relay rate limit exceeded" }, 429);
    }

    let body: z.infer<typeof RelaySubmitSchema>;
    try {
      body = RelaySubmitSchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid relay payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    // Cryptographic authentication only (Origin header is spoofable and never sufficient).
    let authorized = false;
    const nowSec = Math.floor(Date.now() / 1000);

    if (body.intentAuth) {
      const intent = repo ? await repo.getSignedIntent(body.intentAuth.intentId) : null;
      if (intent && intent.network === config.network && intent.status === "pending") {
        const check = await verifyIntentToken(
          {
            intentId: intent.intentId,
            network: intent.network,
            telegramUserId: intent.creatorTelegramUserId,
            expiresAt: intent.expiresAt,
          },
          body.intentAuth.sig,
          config.intentHmacSecret,
        );
        authorized = check.valid;
      }
    }

    if (!authorized && body.walletAuth) {
      const w = body.walletAuth;
      const rawPayload = body.mode === "soroban" ? body.funcXdrBase64 : body.signedTxXdrBase64;
      const expectedPayloadHash = await sha256Hex(rawPayload);
      if (
        constantTimeEqual(w.payloadHash.toLowerCase(), expectedPayloadHash) &&
        Math.abs(nowSec - w.timestamp) <= 120 &&
        repo &&
        (await repo.isAddressLinked(w.address))
      ) {
        const challengeMsg = `astrowallet-relay:v1:${config.network}:${body.mode}:${expectedPayloadHash}:${w.timestamp}:${w.nonce}`;
        const sigValid = await verifyConnectSignature({
          address: w.address,
          message: challengeMsg,
          signatureBase64: w.signatureBase64,
        });
        if (sigValid) {
          const nonceClaimed = await repo.claimAlertDedupKey(
            `relay-nonce:${w.address}:${w.nonce}`,
          );
          authorized = nonceClaimed;
        }
      }
    }

    if (!authorized) {
      return c.json(
        { error: "Relay requires a valid signed intentAuth or linked walletAuth proof" },
        403,
      );
    }

    // Payload policy gates
    let estimatedFeeStroops = config.relayMaxFeeStroops;
    const maxFeeAllowed = BigInt(config.relayMaxFeeStroops);

    if (body.mode === "feebump") {
      let decoded;
      try {
        decoded = decodeTransactionEnvelope(body.signedTxXdrBase64, config.networkPassphrase);
      } catch {
        return c.json({ error: "signedTxXdrBase64 is not a valid transaction envelope" }, 400);
      }
      if (decoded.operations.length > config.relayMaxOperations) {
        return c.json(
          { error: `Relay accepts at most ${config.relayMaxOperations} operations` },
          403,
        );
      }
      if (/^\d+$/.test(decoded.feeStroops) && BigInt(decoded.feeStroops) > maxFeeAllowed) {
        return c.json({ error: "Transaction fee exceeds relay ceiling" }, 403);
      }
      estimatedFeeStroops = /^\d+$/.test(decoded.feeStroops)
        ? decoded.feeStroops
        : config.relayMaxFeeStroops;

      for (const op of decoded.operations) {
        if (op.soroban) {
          if (
            !op.soroban.contractId ||
            !config.relayAllowedContracts.includes(op.soroban.contractId)
          ) {
            return c.json({ error: "Contract in feebump is not on the relay allowlist" }, 403);
          }
        }
      }

      const report = evaluateDecodedTransaction(decoded, {
        networkPassphrase: config.networkPassphrase,
      });
      if (report.verdict === "malicious" || report.findings.some((f) => f.blocksSigning)) {
        return c.json(
          {
            error: "Scan & Shield blocked relay of a malicious transaction",
            findings: report.findings.map((f) => f.code),
          },
          403,
        );
      }
    } else {
      let hostFn;
      try {
        hostFn = decodeHostFunctionXdr(body.funcXdrBase64);
      } catch {
        return c.json({ error: "funcXdrBase64 is not a valid HostFunction XDR" }, 400);
      }
      if (
        hostFn.type !== "hostFunctionTypeInvokeContract" ||
        !hostFn.contractId ||
        !config.relayAllowedContracts.includes(hostFn.contractId)
      ) {
        return c.json({ error: "Contract is not on the relay allowlist" }, 403);
      }
    }

    if (repo) {
      const dayUtc = new Date(nowSec * 1000).toISOString().slice(0, 10);
      const budget = await repo.tryConsumeRelayBudget({
        dayUtc,
        feeStroops: estimatedFeeStroops,
        dailyBudgetStroops: config.relayDailyBudgetStroops,
      });
      if (!budget.allowed) {
        return c.json({ error: "Daily sponsored relay fee budget exceeded" }, 429);
      }
    }

    const upstreamPayload =
      body.mode === "soroban"
        ? { func: body.funcXdrBase64, auth: body.authEntriesXdrBase64 }
        : { xdr: body.signedTxXdrBase64 };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (config.ozChannelsApiKey) {
      headers.Authorization = `Bearer ${config.ozChannelsApiKey}`;
    }

    const cleanUrl = config.ozChannelsApiUrl.replace(/\/+$/, "");
    const res = await fetchFn(cleanUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(upstreamPayload),
    });

    if (!res.ok) {
      const errText = await res.text();
      return c.json(
        { error: `Relayer rejected transaction (${res.status})`, details: errText.slice(0, 500) },
        502,
      );
    }

    const data = (await res.json()) as { hash?: string; txHash?: string; status?: string };
    return c.json({
      ok: true,
      mode: body.mode,
      hash: data.hash ?? data.txHash ?? "",
      status: data.status ?? "submitted",
    });
  });

  return router;
}
