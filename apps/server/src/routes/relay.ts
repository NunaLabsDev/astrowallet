import type { ServerConfig } from "@astrowallet/domain";
import {
  decodeHostFunctionXdr,
  decodeTransactionEnvelope,
  evaluateDecodedTransaction,
} from "@astrowallet/security-shield";
import { verifyIntentToken } from "@astrowallet/tg-protocol";
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

const MAX_RELAY_OPERATIONS = 5;
const MAX_RELAY_FEE_STROOPS = 2_000_000n;

const IntentAuthSchema = z.object({
  intentId: z.string().min(8).max(64),
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
});

const RelaySubmitSchema = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("soroban"),
    funcXdrBase64: z.string().min(8),
    authEntriesXdrBase64: z.array(z.string().min(8)).default([]),
    intentAuth: IntentAuthSchema.optional(),
  }),
  z.object({
    mode: z.literal("feebump"),
    signedTxXdrBase64: z.string().min(16),
    intentAuth: IntentAuthSchema.optional(),
  }),
]);

/**
 * Policy-gated proxy to OpenZeppelin Stellar Channels (sponsors transaction gas fees,
 * distinct from Classic CAP-33 account reserves).
 *
 * Gates (fail closed): per-IP rate limit, allowlisted Origin or a valid HMAC intent token,
 * decodable XDR, operation/fee ceilings, Scan & Shield verdict and optional contract allowlist.
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

    const limit = await checkRateLimit({
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

    // Authentication: allowlisted browser Origin (already enforced by CORS middleware) or HMAC intent.
    const origin = c.req.header("Origin");
    let authorized = Boolean(origin && config.allowedOrigins.includes(origin));
    if (!authorized && body.intentAuth) {
      const repo = c.get("repo");
      const intent = repo ? await repo.getSignedIntent(body.intentAuth.intentId) : null;
      if (intent && intent.network === config.network) {
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
    if (!authorized) {
      return c.json({ error: "Relay requires an allowed Origin or a valid intent token" }, 403);
    }

    // Payload policy gates
    if (body.mode === "feebump") {
      let decoded;
      try {
        decoded = decodeTransactionEnvelope(body.signedTxXdrBase64, config.networkPassphrase);
      } catch {
        return c.json({ error: "signedTxXdrBase64 is not a valid transaction envelope" }, 400);
      }
      if (decoded.operations.length > MAX_RELAY_OPERATIONS) {
        return c.json({ error: `Relay accepts at most ${MAX_RELAY_OPERATIONS} operations` }, 403);
      }
      if (/^\d+$/.test(decoded.feeStroops) && BigInt(decoded.feeStroops) > MAX_RELAY_FEE_STROOPS) {
        return c.json({ error: "Transaction fee exceeds relay ceiling" }, 403);
      }
      const report = evaluateDecodedTransaction(decoded, {
        networkPassphrase: config.networkPassphrase,
      });
      if (report.verdict === "malicious") {
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
      if (config.relayAllowedContracts.length > 0) {
        if (
          hostFn.type !== "hostFunctionTypeInvokeContract" ||
          !hostFn.contractId ||
          !config.relayAllowedContracts.includes(hostFn.contractId)
        ) {
          return c.json({ error: "Contract is not on the relay allowlist" }, 403);
        }
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
