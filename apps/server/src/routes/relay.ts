import { ClassicAddressSchema, type ServerConfig } from "@astrowallet/domain";
import {
  decodeHostFunctionXdr,
  decodeTransactionEnvelope,
  evaluateDecodedTransaction,
} from "@astrowallet/security-shield";
import { verifyConnectSignature, verifyIntentToken } from "@astrowallet/tg-protocol";
import type { DurableObjectNamespace, KVNamespace } from "@cloudflare/workers-types";
import {
  BASE_FEE,
  Keypair,
  Operation,
  TransactionBuilder,
} from "@stellar/stellar-sdk";
import { Hono } from "hono";
import { constantTimeEqual, sha256Hex } from "../lib/crypto-utils.js";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import { checkRateLimit, clientKeyFromHeaders } from "../rate-limit.js";
import type { FetchLike } from "../stellar-verifier.js";
import { authenticateMiniAppSession } from "./tg-auth.js";

export interface RelayRoutesDeps {
  fetchFn?: FetchLike | undefined;
}

export type RelayRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    CHANNEL_POOL?: DurableObjectNamespace;
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

    let intentAuthRecord: {
      intentId: string;
      actionType: string;
      status: string;
      payloadJson: string;
    } | null = null;
    let intentAuthExpiredClaim = false;

    if (body.intentAuth) {
      const intent = repo ? await repo.getSignedIntent(body.intentAuth.intentId) : null;
      const allowSignedClaim =
        intent?.actionType === "claim" && intent.status === "signed";
      const isExpiredSignedClaim = Boolean(allowSignedClaim && nowSec > intent.expiresAt);
      if (
        intent &&
        intent.actionType !== "connect" &&
        intent.network === config.network &&
        (intent.status === "pending" || allowSignedClaim)
      ) {
        const check = await verifyIntentToken(
          {
            intentId: intent.intentId,
            network: intent.network,
            telegramUserId: intent.creatorTelegramUserId,
            expiresAt: intent.expiresAt,
          },
          body.intentAuth.sig,
          config.intentHmacSecret,
          isExpiredSignedClaim ? intent.expiresAt - 1 : undefined,
        );
        if (check.valid) {
          if (intent.actionType === "claim") {
            const escrowContract = config.claimEscrowContractId;
            authorized = Boolean(
              escrowContract &&
                config.relayAllowedContracts.includes(escrowContract),
            );
          } else {
            authorized = true;
          }
          if (authorized) {
            intentAuthRecord = intent;
            intentAuthExpiredClaim = isExpiredSignedClaim;
          }
        }
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

    let claimedStageKey: string | null = null;
    const releaseStageKey = async () => {
      if (claimedStageKey && repo?.releaseAlertDedupKey) {
        const key = claimedStageKey;
        claimedStageKey = null;
        await repo.releaseAlertDedupKey(key).catch(() => undefined);
      }
    };

    if (body.mode === "feebump") {
      let decoded;
      try {
        decoded = decodeTransactionEnvelope(body.signedTxXdrBase64, config.networkPassphrase);
      } catch {
        return c.json({ error: "signedTxXdrBase64 is not a valid transaction envelope" }, 400);
      }
      if (decoded.isFeeBump) {
        return c.json({ error: "Nested FeeBumpTransaction is not permitted in feebump mode" }, 400);
      }
      if (decoded.operations.length === 0) {
        return c.json({ error: "Transaction must contain at least one operation" }, 400);
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
      const parsedInnerFee = /^\d+$/.test(decoded.feeStroops)
        ? BigInt(decoded.feeStroops)
        : maxFeeAllowed;
      const hasSorobanOp = decoded.operations.some((op) => Boolean(op.soroban));
      const minAccountingFloor = BigInt(
        Math.max(hasSorobanOp ? 100_000 : 100, decoded.operations.length * 100),
      );
      const boundedFloor =
        minAccountingFloor > maxFeeAllowed ? maxFeeAllowed : minAccountingFloor;
      estimatedFeeStroops = (
        parsedInnerFee >= boundedFloor ? parsedInnerFee : boundedFloor
      ).toString();

      for (const op of decoded.operations) {
        if (op.soroban) {
          if (
            !op.soroban.contractId ||
            !config.relayAllowedContracts.includes(op.soroban.contractId)
          ) {
            return c.json({ error: "Contract in feebump is not on the relay allowlist" }, 403);
          }
        } else if (intentAuthRecord?.actionType === "claim") {
          return c.json(
            { error: "Claim intentAuth only permits Soroban ClaimEscrow operations" },
            403,
          );
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

      if (intentAuthRecord?.actionType === "claim" && config.claimEscrowContractId) {
        const hasEscrowOp = decoded.operations.some(
          (op) => op.soroban?.contractId === config.claimEscrowContractId,
        );
        if (!hasEscrowOp) {
          return c.json({ error: "Relay payload does not invoke ClaimEscrow contract" }, 403);
        }
        if (intentAuthExpiredClaim) {
          const allRefundOps = decoded.operations.every(
            (op) =>
              Boolean(
                op.soroban &&
                  op.soroban.contractId === config.claimEscrowContractId &&
                  (op.soroban.functionName === "refund_expired" ||
                    op.soroban.functionName === "refund_expired_to"),
              ),
          );
          if (!allRefundOps) {
            return c.json(
              { error: "Expired signed claim intents may only relay refund_expired operations" },
              403,
            );
          }
        }
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
      if (
        intentAuthRecord?.actionType === "claim" &&
        config.claimEscrowContractId &&
        hostFn.contractId !== config.claimEscrowContractId
      ) {
        return c.json({ error: "Relay payload does not invoke ClaimEscrow contract" }, 403);
      }
      if (
        intentAuthExpiredClaim &&
        hostFn.functionName !== "refund_expired" &&
        hostFn.functionName !== "refund_expired_to"
      ) {
        return c.json(
          { error: "Expired signed claim intents may only relay refund_expired operations" },
          403,
        );
      }
    }

    if (intentAuthRecord && repo) {
      const stageKey = `relay-intent:${intentAuthRecord.intentId}:${intentAuthRecord.status}`;
      const claimed = await repo.claimAlertDedupKey(stageKey);
      if (!claimed) {
        return c.json({ error: "Intent relay authorization already consumed" }, 409);
      }
      claimedStageKey = stageKey;
    }

    if (repo) {
      const dayUtc = new Date(nowSec * 1000).toISOString().slice(0, 10);
      const budget = await repo.tryConsumeRelayBudget({
        dayUtc,
        feeStroops: estimatedFeeStroops,
        dailyBudgetStroops: config.relayDailyBudgetStroops,
      });
      if (!budget.allowed) {
        await releaseStageKey();
        return c.json({ error: "Daily sponsored relay fee budget exceeded" }, 429);
      }
    }

    const upstreamPayload =
      body.mode === "soroban"
        ? { func: body.funcXdrBase64, auth: body.authEntriesXdrBase64 }
        : { xdr: body.signedTxXdrBase64 };

    const cleanUrl = config.ozChannelsApiUrl.replace(/\/+$/, "");
    const poolStub =
      c.env.CHANNEL_POOL && config.relayChannelAccounts.length > 0
        ? c.env.CHANNEL_POOL.get(
            c.env.CHANNEL_POOL.idFromName(`channel-pool:${config.network}`),
          )
        : null;

    const acquireChannel = async (exclude: string[] = []) => {
      if (!poolStub) return null;
      const leaseRes = await poolStub.fetch(
        new Request("https://channel-pool.internal/acquire", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            channels: config.relayChannelAccounts,
            exclude,
          }),
        }),
      );
      if (!leaseRes.ok) {
        return { errorStatus: leaseRes.status, errorText: await leaseRes.text() } as const;
      }
      return (await leaseRes.json()) as { leaseId: string; channelAddress: string };
    };

    const releaseChannel = async (leaseId: string | undefined) => {
      if (!poolStub || !leaseId) return;
      await poolStub
        .fetch(
          new Request("https://channel-pool.internal/release", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ leaseId }),
          }),
        )
        .catch(() => undefined);
    };

    const submitWithChannel = async (channelAddress?: string) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.ozChannelsApiKey) {
        headers.Authorization = `Bearer ${config.ozChannelsApiKey}`;
      }
      if (channelAddress) {
        headers["X-Channel-Account"] = channelAddress;
      }
      return fetchFn(cleanUrl, {
        method: "POST",
        headers,
        body: JSON.stringify(upstreamPayload),
        signal: AbortSignal.timeout(10_000),
      });
    };

    let res: Response;
    try {
      if (poolStub) {
        const excluded: string[] = [];
        let lease = await acquireChannel(excluded);
        if (lease && "errorStatus" in lease) {
          await releaseStageKey();
          return c.json(
            { error: "All relay channel accounts are busy; retry shortly" },
            429,
          );
        }
        try {
          res = await submitWithChannel(lease?.channelAddress);
          if (!res.ok) {
            const errText = await res.text();
            if (
              /tx_bad_seq/i.test(errText) &&
              lease &&
              config.relayChannelAccounts.length > 1
            ) {
              excluded.push(lease.channelAddress);
              await releaseChannel(lease.leaseId);
              lease = await acquireChannel(excluded);
              if (lease && !("errorStatus" in lease)) {
                res = await submitWithChannel(lease.channelAddress);
              } else {
                await releaseStageKey();
                return c.json(
                  { error: `Relayer rejected transaction (${res.status})`, details: errText.slice(0, 500) },
                  502,
                );
              }
            } else {
              await releaseStageKey();
              return c.json(
                { error: `Relayer rejected transaction (${res.status})`, details: errText.slice(0, 500) },
                502,
              );
            }
          }
        } finally {
          if (lease && !("errorStatus" in lease)) {
            await releaseChannel(lease.leaseId);
          }
        }
      } else {
        res = await submitWithChannel();
      }

      if (!res.ok) {
        const errText = await res.text();
        await releaseStageKey();
        return c.json(
          { error: `Relayer rejected transaction (${res.status})`, details: errText.slice(0, 500) },
          502,
        );
      }
    } catch (err) {
      await releaseStageKey();
      return c.json(
        {
          error: err instanceof Error ? `Relayer request failed: ${err.message}` : "Relayer unavailable",
        },
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

  const BootstrapBodySchema = z.object({
    address: ClassicAddressSchema,
    mode: z.enum(["sponsored_reserve", "direct"]).default("sponsored_reserve"),
    timestamp: z.number().int().positive(),
    nonce: z.string().trim().min(8).max(64),
    signatureBase64: z.string().min(16),
  });

  /**
   * Sponsored CAP-33 / direct activation for unfunded new Classic G... accounts.
   * Fail-closed: requires RELAY_SPONSOR_SECRET, verified Mini App session, SEP-53
   * ownership proof, Horizon unfunded check, and 1-per-user + 1-per-address D1 dedup.
   */
  router.post("/bootstrap", async (c) => {
    const config = c.get("config");
    if (!config.relaySponsorSecret) {
      return c.json(
        { error: "Sponsored account bootstrapping (RELAY_SPONSOR_SECRET) is not configured" },
        503,
      );
    }

    const session = await authenticateMiniAppSession(c);
    if (!session.ok) {
      return c.json({ error: session.error }, session.status);
    }

    const repo = c.get("repo");
    const limit = await checkRateLimit({
      repository: repo,
      cache: c.env.CACHE,
      scope: "relay_bootstrap",
      clientKey: clientKeyFromHeaders(c.req.raw.headers),
      limitPerMin: Math.min(config.relayRateLimitPerMin, 5),
    });
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return c.json({ error: "Bootstrap rate limit exceeded" }, 429);
    }

    let body: z.infer<typeof BootstrapBodySchema>;
    try {
      body = BootstrapBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid bootstrap payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const nowSec = Math.floor(Date.now() / 1000);
    if (Math.abs(nowSec - body.timestamp) > 120) {
      return c.json({ error: "Bootstrap signature timestamp expired" }, 403);
    }

    const challengeMsg = `astrowallet-bootstrap:v1:${config.network}:${body.address}:${body.timestamp}:${body.nonce}`;
    const sigValid = await verifyConnectSignature({
      address: body.address,
      message: challengeMsg,
      signatureBase64: body.signatureBase64,
    });
    if (!sigValid) {
      return c.json({ error: "Invalid SEP-53 ownership signature for bootstrap address" }, 403);
    }

    // Check Horizon: reject if target account is already funded, fail closed if Horizon unreachable
    let confirmedUnfunded = false;
    for (const hBase of config.horizonUrls) {
      try {
        const acctRes = await fetchFn(
          `${hBase.replace(/\/+$/, "")}/accounts/${encodeURIComponent(body.address)}`,
          {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(6_000),
          },
        );
        if (acctRes.status === 200) {
          return c.json({ error: "Target Stellar account is already funded on-ledger" }, 409);
        }
        if (acctRes.status === 404) {
          confirmedUnfunded = true;
          break;
        }
      } catch {
        // Try next Horizon URL
      }
    }
    if (!confirmedUnfunded) {
      return c.json({ error: "Unable to verify target account status on Horizon" }, 503);
    }

    const userDedupKey = `bootstrap:tg:${config.network}:${session.claims.telegramUserId}`;
    const addrDedupKey = `bootstrap:addr:${config.network}:${body.address}`;
    if (repo) {
      const dayUtc = `bootstrap:${new Date(nowSec * 1000).toISOString().slice(0, 10)}`;
      const budget = await repo.tryConsumeRelayBudget({
        dayUtc,
        feeStroops: "100000",
        dailyBudgetStroops: String(BigInt(config.relayBootstrapDailyLimit) * 100_000n),
      });
      if (!budget.allowed) {
        return c.json({ error: "Daily sponsored bootstrap limit reached" }, 429);
      }

      const claimedUser = await repo.claimAlertDedupKey(userDedupKey);
      if (!claimedUser) {
        return c.json({ error: "This Telegram account has already used its sponsored activation" }, 409);
      }
      const claimedAddr = await repo.claimAlertDedupKey(addrDedupKey);
      if (!claimedAddr) {
        await repo.releaseAlertDedupKey?.(userDedupKey);
        return c.json({ error: "This Stellar address has already been bootstrapped" }, 409);
      }
    }

    const rollbackDedup = async () => {
      if (!repo?.releaseAlertDedupKey) return;
      await Promise.all([
        repo.releaseAlertDedupKey(userDedupKey).catch(() => undefined),
        repo.releaseAlertDedupKey(addrDedupKey).catch(() => undefined),
      ]);
    };

    let sponsorKeypair: Keypair;
    let sponsorAddress: string;
    let sponsorSignedXdr: string;
    try {
      sponsorKeypair = Keypair.fromSecret(config.relaySponsorSecret);
      sponsorAddress = sponsorKeypair.publicKey();

      let sponsorSequence: string | undefined;
      for (const hBase of config.horizonUrls) {
        try {
          const sRes = await fetchFn(
            `${hBase.replace(/\/+$/, "")}/accounts/${encodeURIComponent(sponsorAddress)}`,
            {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(6_000),
            },
          );
          if (!sRes.ok) continue;
          const sJson = (await sRes.json()) as { sequence?: string };
          if (sJson.sequence) {
            sponsorSequence = sJson.sequence;
            break;
          }
        } catch {
          // Try next Horizon URL
        }
      }
      if (!sponsorSequence) {
        await rollbackDedup();
        return c.json({ error: "Sponsor account sequence unavailable on Horizon" }, 502);
      }

      const sponsorAccount = {
        accountId: () => sponsorAddress,
        sequenceNumber: () => sponsorSequence!,
        incrementSequenceNumber: () => {
          sponsorSequence = (BigInt(sponsorSequence!) + 1n).toString();
        },
      };

      const builder = new TransactionBuilder(sponsorAccount, {
        fee: String(Number(BASE_FEE) * 4),
        networkPassphrase: config.networkPassphrase,
      });

      if (body.mode === "sponsored_reserve") {
        builder
          .addOperation(
            Operation.beginSponsoringFutureReserves({
              sponsoredId: body.address,
            }),
          )
          .addOperation(
            Operation.createAccount({
              destination: body.address,
              startingBalance: "0",
            }),
          )
          .addOperation(
            Operation.endSponsoringFutureReserves({
              source: body.address,
            }),
          );
      } else {
        builder.addOperation(
          Operation.createAccount({
            destination: body.address,
            startingBalance: config.relayBootstrapStartingBalanceXlm,
          }),
        );
      }

      const tx = builder.setTimeout(180).build();
      tx.sign(sponsorKeypair);
      sponsorSignedXdr = tx.toXDR();
    } catch {
      await rollbackDedup();
      return c.json({ error: "Failed to construct sponsor bootstrap transaction" }, 500);
    }

    if (body.mode === "sponsored_reserve") {
      return c.json({
        ok: true,
        mode: "sponsored_reserve",
        sponsorAddress,
        sponsorSignedXdr,
      });
    }

    // Direct mode: submit sponsor-signed createAccount directly to Horizon
    for (const hBase of config.horizonUrls) {
      try {
        const submitRes = await fetchFn(
          `${hBase.replace(/\/+$/, "")}/transactions`,
          {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ tx: sponsorSignedXdr }).toString(),
            signal: AbortSignal.timeout(8_000),
          },
        );
        if (submitRes.ok) {
          const submitted = (await submitRes.json().catch(() => ({}))) as {
            hash?: string;
            ledger?: number;
          };
          return c.json({
            ok: true,
            mode: "direct",
            sponsorAddress,
            hash: submitted.hash ?? "",
            ledger: submitted.ledger,
          });
        }
      } catch {
        // Try next Horizon URL
      }
    }

    await rollbackDedup();
    return c.json({ error: "Horizon rejected direct bootstrap transaction" }, 502);
  });

  return router;
}
