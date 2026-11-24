import {
  ClassicAddressSchema,
  ContractAddressSchema,
  StellarAddressSchema,
  type ClaimLink,
  type ClassicAddress,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  buildTelegramMiniAppLink,
  deriveClaimId,
  formatClaimLinkCard,
  formatPaymentIntentCard,
  formatRequestCard,
  formatSplitCard,
  formatSwapQuoteCard,
  signIntentToken,
  verifyIntentToken,
} from "@astrowallet/tg-protocol";
import { TransactionBuilder } from "@stellar/stellar-sdk";
import { Hono, type Context } from "hono";
import { z } from "zod";
import type { WorkerBindings } from "../app.js";
import type { ServerRepository } from "../db/repository.js";
import {
  verifyTransactionConfirmed,
  type ExpectedTxMatch,
  type FetchLike,
  type TxVerificationResult,
} from "../stellar-verifier.js";
import {
  editTelegramMessage,
  sendTelegramMessage,
  type TelegramApiDeps,
} from "../telegram-api.js";
import { checkRateLimit, clientKeyFromHeaders } from "../rate-limit.js";
import {
  ConnectAccountSubmissionSchema,
  verifyConnectAccountSubmissions,
} from "./connect-verifier.js";
import { authenticateMiniAppSession } from "./tg-auth.js";

const CREATOR_ONLY_INTENTS = new Set([
  "connect",
  "pay",
  "swap",
  "reclaim_reserve",
  "sign_xdr",
]);

export interface IntentRoutesDeps {
  fetchFn?: FetchLike | undefined;
  verifyTxFn?:
    | ((
        config: Pick<ServerConfig, "horizonUrls" | "rpcUrls" | "networkPassphrase">,
        txHash: string,
        expected?: ExpectedTxMatch,
      ) => Promise<TxVerificationResult>)
    | undefined;
  telegramApiDeps?: TelegramApiDeps | undefined;
}

const ConnectIntentBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  confirmCode: z.string().trim().min(4).max(16).optional(),
  accounts: z.array(ConnectAccountSubmissionSchema).min(1).max(10),
});

const ConfirmIntentBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  stage: z.enum(["funded", "claimed", "cancelled", "refunded"]).optional(),
  payerAddress: z.string().min(8).max(100).optional(),
  senderAddress: z.string().regex(/^[GC][A-Z2-7]{55}$/).optional(),
  expiresAt: z.number().int().positive().optional(),
});

const CrossAppIntentEnvelopeSchema = z.object({
  version: z.literal(1).optional(),
  originApp: z.enum(["astrodex", "astrogate"]),
  sourceAddress: StellarAddressSchema.optional(),
  originConfirmSig: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
  subAction: z.string().trim().min(1).max(64),
  humanSummary: z.string().trim().min(1).max(400),
  unsignedXdr: z.string().trim().min(16).max(32_768),
  xdrSha256: z.string().regex(/^[a-f0-9]{64}$/i),
  returnStartAppParam: z.string().trim().max(128).optional(),
  fromAsset: z.string().trim().max(128).optional(),
  toAsset: z.string().trim().max(128).optional(),
  amount: z.string().trim().max(64).optional(),
  expectedOutputAmount: z.string().trim().max(64).optional(),
  provider: z.string().trim().max(64).optional(),
  priceImpactPct: z.string().trim().max(32).optional(),
});

const ExternalIntentBodySchema = z.object({
  intentId: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_-]{8,64}$/)
    .optional(),
  telegramUserId: z.string().regex(/^\d{1,20}$/),
  actionType: z.enum(["swap", "sign_xdr"]),
  envelope: CrossAppIntentEnvelopeSchema,
  expiresAt: z.number().int().positive().optional(),
});

interface IntentPayload {
  originApp?: "astrodex" | "astrogate" | undefined;
  sourceAddress?: string | undefined;
  originConfirmSig?: string | undefined;
  subAction?: string | undefined;
  humanSummary?: string | undefined;
  xdrSha256?: string | undefined;
  returnStartAppParam?: string | undefined;
  amount?: string | undefined;
  totalAmount?: string | undefined;
  participantCount?: number | undefined;
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  destination?: string | undefined;
  senderLabel?: string | undefined;
  recipientLabel?: string | undefined;
  recipientUsername?: string | undefined;
  memo?: string | undefined;
  fromAsset?: string | undefined;
  toAsset?: string | undefined;
  expectedOutputAmount?: string | undefined;
  provider?: string | undefined;
  priceImpactPct?: string | undefined;
  unsignedXdr?: string | undefined;
  escrowContractId?: string | undefined;
  escrowExpiresAt?: number | undefined;
  claimId?: string | undefined;
  confirmCode?: string | undefined;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function parsePayload(raw: string): IntentPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as IntentPayload) : {};
  } catch {
    return {};
  }
}

async function authorizeOptionalCreatorSession(
  c: Context<IntentRouteEnv>,
  intent: { actionType: string; creatorTelegramUserId: string },
): Promise<{ hasSession: boolean; denial?: Response }> {
  if (!c.req.header("Authorization")?.trim()) {
    return { hasSession: false };
  }
  const session = await authenticateMiniAppSession(c);
  if (!session.ok) {
    return {
      hasSession: false,
      denial: c.json({ error: session.error }, session.status),
    };
  }
  if (
    CREATOR_ONLY_INTENTS.has(intent.actionType) &&
    session.claims.telegramUserId !== intent.creatorTelegramUserId
  ) {
    return {
      hasSession: true,
      denial: c.json({ error: "Intent belongs to another Telegram user" }, 403),
    };
  }
  return { hasSession: true };
}

export type IntentRouteEnv = {
  Bindings: WorkerBindings;
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

export function createIntentRoutes(deps: IntentRoutesDeps = {}): Hono<IntentRouteEnv> {
  const router = new Hono<IntentRouteEnv>();

  router.post("/external", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");

    if (!config.ecosystemSharedIntentSecret) {
      return c.json({ error: "External ecosystem intents are not enabled" }, 503);
    }

    const secretHeader = c.req.header("X-Ecosystem-Secret")?.trim() ?? "";
    if (!secretHeader || !constantTimeEqual(secretHeader, config.ecosystemSharedIntentSecret)) {
      return c.json({ error: "Unauthorized ecosystem intent request" }, 401);
    }

    let body: z.infer<typeof ExternalIntentBodySchema>;
    try {
      body = ExternalIntentBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid external intent payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const computedSha = await sha256Hex(body.envelope.unsignedXdr);
    if (!constantTimeEqual(computedSha, body.envelope.xdrSha256.toLowerCase())) {
      return c.json({ error: "envelope.xdrSha256 does not match unsignedXdr" }, 400);
    }

    const intentId = body.intentId ?? `ext_${crypto.randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const existing = await repo.getSignedIntent(intentId);
    if (existing) {
      return c.json({ error: "Intent ID already exists" }, 409);
    }

    const now = Math.floor(Date.now() / 1000);
    const requestedExpiresAt = body.expiresAt ?? now + 300;
    const expiresAt = Math.max(now + 30, Math.min(now + 300, requestedExpiresAt));

    const sig = await signIntentToken(
      {
        intentId,
        network: config.network,
        telegramUserId: body.telegramUserId,
        expiresAt,
      },
      config.intentHmacSecret,
    );

    await repo.createSignedIntent({
      intentId,
      network: config.network,
      creatorTelegramUserId: body.telegramUserId,
      actionType: body.actionType,
      payloadJson: JSON.stringify(body.envelope),
      hmacSig: sig,
      status: "pending",
      expiresAt,
      createdAt: now,
    });

    const deepLink = buildTelegramMiniAppLink({
      botUsername: config.tgBotUsername,
      shortName: config.tgMiniAppShortName,
      pwaOrigin: config.pwaOrigin,
      intentId,
      sig,
    });

    return c.json({
      ok: true,
      intentId,
      sig,
      expiresAt,
      deepLink,
    });
  });

  router.get("/:intentId", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const intentId = c.req.param("intentId");
    const sig = c.req.query("sig") ?? "";

    const intent = await repo.getSignedIntent(intentId);
    if (!intent) {
      return c.json({ error: "Intent not found" }, 404);
    }

    const check = await verifyIntentToken(
      {
        intentId: intent.intentId,
        network: intent.network,
        telegramUserId: intent.creatorTelegramUserId,
        expiresAt: intent.expiresAt,
      },
      sig,
      config.intentHmacSecret,
    );

    if (!check.valid) {
      if (check.reason === "expired" && intent.status === "pending") {
        await repo.markIntentStatus(intent.intentId, "expired");
      }
      return c.json(
        { error: `Intent token ${check.reason}` },
        check.reason === "expired" ? 410 : 401,
      );
    }

    if (intent.network !== config.network) {
      return c.json({ error: "Cross-network intent rejected" }, 409);
    }

    const authCheck = await authorizeOptionalCreatorSession(c, intent);
    if (authCheck.denial) return authCheck.denial;

    const payload = parsePayload(intent.payloadJson);
    let claimDetails:
      | {
          claimId: string;
          claimStatus: "pending_funding" | ClaimLink["status"];
          escrowContractId?: string | undefined;
        }
      | undefined;

    if (intent.actionType === "claim") {
      const claimId = await deriveClaimId(intent.intentId);
      const claimLink = await repo.getClaimLink(claimId);
      claimDetails = {
        claimId,
        claimStatus: claimLink?.status ?? "pending_funding",
        escrowContractId:
          claimLink?.escrowContractId ??
          payload.escrowContractId ??
          config.claimEscrowContractId,
      };
    }

    const paidCount =
      intent.actionType === "split"
        ? await repo.countSplitPayments(intent.intentId)
        : undefined;

    const { confirmCode: _omittedConfirmCode, ...publicPayload } = payload;

    return c.json({
      intentId: intent.intentId,
      network: intent.network,
      actionType: intent.actionType,
      status: intent.status,
      payload: publicPayload,
      txHash: intent.txHash,
      expiresAt: intent.expiresAt,
      ...(claimDetails ?? {}),
      ...(paidCount !== undefined ? { paidCount } : {}),
    });
  });

  router.post("/:intentId/connect", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const intentId = c.req.param("intentId");

    const connectLimit = await checkRateLimit({
      repository: repo,
      cache: c.env.CACHE,
      scope: `intent_connect:${intentId}`,
      clientKey: clientKeyFromHeaders(c.req.raw.headers),
      limitPerMin: 10,
    });
    if (!connectLimit.allowed) {
      c.header("Retry-After", String(connectLimit.retryAfterSeconds));
      return c.json({ error: "Too many connect attempts; wait a minute before retrying" }, 429);
    }

    let parsedBody: z.infer<typeof ConnectIntentBodySchema>;
    try {
      parsedBody = ConnectIntentBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid connect payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const intent = await repo.getSignedIntent(intentId);
    if (!intent) {
      return c.json({ error: "Intent not found" }, 404);
    }
    if (intent.actionType !== "connect") {
      return c.json({ error: "Intent is not a connect challenge" }, 400);
    }

    const check = await verifyIntentToken(
      {
        intentId: intent.intentId,
        network: intent.network,
        telegramUserId: intent.creatorTelegramUserId,
        expiresAt: intent.expiresAt,
      },
      parsedBody.sig,
      config.intentHmacSecret,
    );
    if (!check.valid) {
      return c.json(
        { error: `Intent token ${check.reason}` },
        check.reason === "expired" ? 410 : 401,
      );
    }
    if (intent.network !== config.network) {
      return c.json({ error: "Cross-network intent rejected" }, 409);
    }

    const authCheck = await authorizeOptionalCreatorSession(c, intent);
    if (authCheck.denial) return authCheck.denial;
    if (intent.status !== "pending") {
      return c.json({ error: `Intent already ${intent.status}` }, 409);
    }

    const storedPayload = parsePayload(intent.payloadJson) as {
      message?: string;
      confirmCode?: string;
      challenge?: { usernameLower?: string };
    };
    if (!storedPayload.message) {
      return c.json({ error: "Corrupted challenge state" }, 500);
    }

    if (
      !authCheck.hasSession &&
      (!parsedBody.confirmCode ||
        !storedPayload.confirmCode ||
        !constantTimeEqual(
          parsedBody.confirmCode.trim().toUpperCase(),
          storedPayload.confirmCode.trim().toUpperCase(),
        ))
    ) {
      return c.json({ error: "Invalid Telegram confirmation code" }, 403);
    }

    const verification = await verifyConnectAccountSubmissions({
      config,
      repo,
      telegramUserId: intent.creatorTelegramUserId,
      challengeMessage: storedPayload.message,
      accounts: parsedBody.accounts,
    });
    if (!verification.ok) {
      return c.json({ error: verification.error }, verification.status);
    }
    const verifiedInputs = verification.verifiedInputs;

    const linked = await repo.linkVerifiedAddresses({
      telegramUserId: intent.creatorTelegramUserId,
      usernameLower: storedPayload.challenge?.usernameLower,
      accounts: verifiedInputs,
    });
    await repo.markIntentConfirmed(intent.intentId);

    if (intent.chatId) {
      await sendTelegramMessage(
        {
          botToken: config.tgBotToken,
          chatId: intent.chatId,
          text: `✅ <b>Wallet Connected!</b> Linked ${verifiedInputs.length} account(s) on <code>${config.network.toUpperCase()}</code>. Run /balance or /accounts anytime.`,
          replyMarkup: {
            inline_keyboard: [[{ text: "Not me — Unlink", callback_data: "unlink_self" }]],
          },
        },
        { apiOrigin: config.telegramApiOrigin, ...(deps.telegramApiDeps ?? {}) },
      );
    }

    return c.json({
      ok: true,
      linkedCount: linked.length,
      accounts: linked,
    });
  });

  router.post("/:intentId/confirm", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const intentId = c.req.param("intentId");

    let parsedBody: z.infer<typeof ConfirmIntentBodySchema>;
    try {
      parsedBody = ConfirmIntentBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid confirm payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    const intent = await repo.getSignedIntent(intentId);
    if (!intent) {
      return c.json({ error: "Intent not found" }, 404);
    }

    const check = await verifyIntentToken(
      {
        intentId: intent.intentId,
        network: intent.network,
        telegramUserId: intent.creatorTelegramUserId,
        expiresAt: intent.expiresAt,
      },
      parsedBody.sig,
      config.intentHmacSecret,
    );
    if (!check.valid) {
      return c.json(
        { error: `Intent token ${check.reason}` },
        check.reason === "expired" ? 410 : 401,
      );
    }
    if (intent.network !== config.network) {
      return c.json({ error: "Cross-network intent rejected" }, 409);
    }

    const authCheck = await authorizeOptionalCreatorSession(c, intent);
    if (authCheck.denial) return authCheck.denial;

    const verifyFn =
      deps.verifyTxFn ??
      ((cfg, hash, expected) => verifyTransactionConfirmed(cfg, hash, deps.fetchFn, expected));

    const payload = parsePayload(intent.payloadJson);
    const txHashLower = parsedBody.txHash.toLowerCase();

    const maybeEditCard = async (text: string, replyMarkup?: unknown): Promise<boolean> => {
      if (!intent.inlineMessageId && !(intent.chatId && intent.messageId)) {
        return false;
      }
      return editTelegramMessage(
        {
          botToken: config.tgBotToken,
          target: {
            chatId: intent.chatId,
            messageId: intent.messageId,
            inlineMessageId: intent.inlineMessageId,
          },
          text,
          replyMarkup,
        },
        { apiOrigin: config.telegramApiOrigin, ...(deps.telegramApiDeps ?? {}) },
      );
    };

    // Branch A: 2-stage Soroban Claim Link (funded -> open claim_link; claimed -> confirmed)
    if (intent.actionType === "claim") {
      const claimId = await deriveClaimId(intent.intentId);
      const existingClaim = await repo.getClaimLink(claimId);
      const stage =
        parsedBody.stage ??
        (existingClaim?.status === "open" || intent.status === "signed" ? "claimed" : "funded");

      if (stage === "funded" && intent.status === "signed") {
        const recorded = await repo.listSplitPaymentTxHashes(intent.intentId);
        if (recorded.includes(txHashLower)) {
          return c.json({
            ok: true,
            status: "signed",
            stage: "funded",
            claimId,
            txHash: parsedBody.txHash,
          });
        }
      }
      if (
        stage === "claimed" &&
        intent.status === "confirmed" &&
        intent.txHash?.toLowerCase() === txHashLower
      ) {
        return c.json({
          ok: true,
          status: "confirmed",
          stage: "claimed",
          claimId,
          txHash: parsedBody.txHash,
        });
      }

      if (
        (stage === "cancelled" || stage === "refunded") &&
        intent.status === "cancelled" &&
        existingClaim?.status === "refunded"
      ) {
        const recorded = await repo.listSplitPaymentTxHashes(intent.intentId);
        if (recorded.includes(txHashLower)) {
          return c.json({
            ok: true,
            status: "cancelled",
            stage,
            claimId,
            txHash: parsedBody.txHash,
          });
        }
      }

      if (stage === "funded" && (intent.status !== "pending" || existingClaim !== null)) {
        return c.json({ error: `Claim link already funded or ${intent.status}` }, 409);
      }
      if (
        (stage === "claimed" || stage === "cancelled" || stage === "refunded") &&
        intent.status !== "signed" &&
        existingClaim?.status !== "open"
      ) {
        if (existingClaim?.status === "claimed" || intent.status === "confirmed") {
          return c.json({ error: "Claim link has already been claimed" }, 409);
        }
        return c.json({ error: `Claim link is not open (${intent.status})` }, 409);
      }

      if (await repo.isTxHashUsed(parsedBody.txHash)) {
        return c.json({ error: "Transaction hash already used for another intent" }, 409);
      }

      const escrowParsed = ContractAddressSchema.safeParse(
        payload.escrowContractId ?? existingClaim?.escrowContractId ?? config.claimEscrowContractId,
      );
      if (!escrowParsed.success) {
        return c.json({ error: "CLAIM_ESCROW_CONTRACT_ID is not configured" }, 503);
      }

      const sorobanFn =
        stage === "funded"
          ? "create_claim"
          : stage === "claimed"
            ? "claim"
            : stage === "cancelled"
              ? "cancel_claim"
              : "refund_expired";

      const expected: ExpectedTxMatch = {
        minCreatedAtUnix: intent.createdAt,
        allowSorobanRpcFallback: true,
        sorobanInvoke: {
          contractId: escrowParsed.data,
          functionName: sorobanFn,
          firstArgHex: claimId,
          ...(stage === "funded"
            ? {
                expectedAmount: payload.amount,
                expectedAssetCode: payload.assetCode ?? "XLM",
                expectedAssetIssuer: payload.assetIssuer,
              }
            : {}),
        },
      };
      const txCheck = await verifyFn(config, parsedBody.txHash, expected);
      if (!txCheck.confirmed) {
        return c.json({ error: txCheck.reason }, 409);
      }

      if (stage === "funded") {
        let senderAddress: ClassicAddress | undefined = parsedBody.senderAddress;
        if (!senderAddress) {
          const linked = await repo.listLinkedAddresses(intent.creatorTelegramUserId);
          const firstClassic = linked.find(
            (a) => a.kind === "classic" && ClassicAddressSchema.safeParse(a.address).success,
          );
          if (firstClassic) {
            senderAddress = firstClassic.address as ClassicAddress;
          }
        }
        if (!senderAddress) {
          return c.json({ error: "senderAddress is required to record escrow funding" }, 400);
        }

        const recipientUsernameLower = (payload.recipientUsername ?? "recipient")
          .replace(/^@/, "")
          .toLowerCase();

        await repo.createClaimLink({
          claimId,
          network: config.network,
          senderAddress,
          recipientUsernameLower,
          assetCode: payload.assetCode ?? "XLM",
          assetIssuer: payload.assetIssuer as ClassicAddress | undefined,
          amount: payload.amount ?? "0",
          escrowContractId: escrowParsed.data,
          status: "open",
          expiresAt: parsedBody.expiresAt ?? payload.escrowExpiresAt ?? intent.expiresAt,
        });
        await repo.recordSplitPayment({
          intentId: intent.intentId,
          payerAddress: senderAddress,
          txHash: parsedBody.txHash,
          amount: payload.amount ?? "0",
        });
        await repo.markIntentStatus(intent.intentId, "signed");

        const cardUpdated = await maybeEditCard(
          formatClaimLinkCard({
            status: "open",
            amount: payload.amount ?? "?",
            assetCode: payload.assetCode ?? "XLM",
            senderLabel: payload.senderLabel ?? "Sender",
            recipientUsername: recipientUsernameLower,
            network: config.network,
            txHash: parsedBody.txHash,
          }),
        );

        return c.json({
          ok: true,
          status: "signed",
          stage: "funded",
          claimId,
          txHash: parsedBody.txHash,
          ledger: txCheck.ledger,
          telegramCardUpdated: cardUpdated,
        });
      }

      if (stage === "cancelled" || stage === "refunded") {
        await repo.recordSplitPayment({
          intentId: intent.intentId,
          txHash: parsedBody.txHash,
          amount: "0",
        });
        await repo.markClaimLinkStatus(claimId, "refunded");
        await repo.markIntentStatus(intent.intentId, "cancelled");

        const cardUpdated = await maybeEditCard(
          formatClaimLinkCard({
            status: "refunded",
            amount: payload.amount ?? "?",
            assetCode: payload.assetCode ?? "XLM",
            senderLabel: payload.senderLabel ?? "Sender",
            recipientUsername: payload.recipientUsername ?? "recipient",
            network: config.network,
            txHash: parsedBody.txHash,
          }),
        );

        return c.json({
          ok: true,
          status: "cancelled",
          stage,
          claimId,
          txHash: parsedBody.txHash,
          ledger: txCheck.ledger,
          telegramCardUpdated: cardUpdated,
        });
      }

      await repo.markClaimLinkStatus(claimId, "claimed");
      const updated = await repo.markIntentConfirmed(intent.intentId, parsedBody.txHash);
      await Promise.all([
        repo.recordVerifiedTx({
          txHash: parsedBody.txHash.toLowerCase(),
          network: config.network,
          actionType: "claim_claimed",
          assetCode: payload.assetCode,
          amountEst: payload.amount,
        }),
        repo.incrementProductEvent({
          dayUtc: new Date().toISOString().slice(0, 10),
          network: config.network,
          eventType: "intent_confirmed",
        }),
      ]);
      const cardUpdated = await maybeEditCard(
        formatClaimLinkCard({
          status: "claimed",
          amount: payload.amount ?? "?",
          assetCode: payload.assetCode ?? "XLM",
          senderLabel: payload.senderLabel ?? "Sender",
          recipientUsername: payload.recipientUsername ?? "recipient",
          network: config.network,
          txHash: parsedBody.txHash,
        }),
      );

      return c.json({
        ok: true,
        status: updated?.status ?? "confirmed",
        stage: "claimed",
        claimId,
        txHash: parsedBody.txHash,
        ledger: txCheck.ledger,
        telegramCardUpdated: cardUpdated,
      });
    }

    // Branch B: Multi-payer group split (remains pending until paidCount >= participantCount)
    if (intent.actionType === "split") {
      const existingHashes = await repo.listSplitPaymentTxHashes(intent.intentId);
      const participantCount = payload.participantCount ?? 2;
      if (existingHashes.includes(txHashLower)) {
        return c.json({
          ok: true,
          status: intent.status,
          txHash: parsedBody.txHash,
          paidCount: existingHashes.length,
          participantCount,
        });
      }
      if (intent.status !== "pending") {
        return c.json({ error: `Intent already ${intent.status}` }, 409);
      }
      if (await repo.isTxHashUsed(parsedBody.txHash)) {
        return c.json({ error: "Transaction hash already used for another intent" }, 409);
      }

      const expected: ExpectedTxMatch = {
        destination: payload.destination,
        amount: payload.amount,
        assetCode: payload.assetCode,
        assetIssuer: payload.assetIssuer,
        memo: payload.memo,
        minCreatedAtUnix: intent.createdAt,
        allowSorobanRpcFallback: Boolean(payload.destination?.startsWith("C")),
      };
      const txCheck = await verifyFn(config, parsedBody.txHash, expected);
      if (!txCheck.confirmed) {
        return c.json({ error: txCheck.reason }, 409);
      }

      let paidCount: number;
      try {
        const recorded = await repo.recordSplitPayment({
          intentId: intent.intentId,
          payerAddress: parsedBody.payerAddress,
          txHash: parsedBody.txHash,
          amount: payload.amount ?? "0",
        });
        paidCount = recorded.paidCount;
      } catch {
        return c.json({ error: "Duplicate split participant or payment already recorded" }, 409);
      }
      const allTxHashes = await repo.listSplitPaymentTxHashes(intent.intentId);
      const isComplete = paidCount >= participantCount;
      if (isComplete) {
        await Promise.all([
          repo.markIntentConfirmed(intent.intentId, parsedBody.txHash),
          repo.recordVerifiedTx?.({
            txHash: parsedBody.txHash.toLowerCase(),
            network: config.network,
            actionType: intent.actionType,
            assetCode: payload.assetCode,
            amountEst: payload.totalAmount ?? payload.amount,
          }) ?? Promise.resolve(),
          repo.incrementProductEvent?.({
            dayUtc: new Date().toISOString().slice(0, 10),
            network: config.network,
            eventType: "intent_confirmed",
          }) ?? Promise.resolve(),
        ]);
      }

      const shareAmount = payload.amount ?? "?";
      const assetCode = payload.assetCode ?? "XLM";
      const replyMarkup = isComplete
        ? undefined
        : {
            inline_keyboard: [
              [
                {
                  text: `Pay Share (${shareAmount} ${assetCode})`,
                  url: buildTelegramMiniAppLink({
                    botUsername: config.tgBotUsername,
                    shortName: config.tgMiniAppShortName,
                    pwaOrigin: config.pwaOrigin,
                    intentId: intent.intentId,
                    sig: intent.hmacSig,
                  }),
                },
              ],
            ],
          };

      const cardUpdated = await maybeEditCard(
        formatSplitCard({
          amountPerPerson: shareAmount,
          totalAmount: payload.totalAmount ?? "?",
          assetCode,
          participantCount,
          requesterLabel: payload.recipientLabel ?? "Requester",
          recipientAddress: payload.destination ?? "",
          network: config.network,
          paidCount,
          status: isComplete ? "confirmed" : "pending",
          txHashes: allTxHashes,
        }),
        replyMarkup,
      );

      return c.json({
        ok: true,
        status: isComplete ? "confirmed" : "pending",
        txHash: parsedBody.txHash,
        ledger: txCheck.ledger,
        paidCount,
        participantCount,
        telegramCardUpdated: cardUpdated,
      });
    }

    // Branch C: Single-settlement intents (pay, request, swap, reclaim_reserve, sign_xdr)
    if (intent.status === "confirmed" && intent.txHash?.toLowerCase() === txHashLower) {
      return c.json({ ok: true, status: "confirmed", txHash: intent.txHash });
    }
    if (intent.status !== "pending") {
      return c.json({ error: `Intent already ${intent.status}` }, 409);
    }
    if (await repo.isTxHashUsed(parsedBody.txHash)) {
      return c.json({ error: "Transaction hash already used for another intent" }, 409);
    }

    let expectedSignXdrHash: string | undefined;
    if (intent.actionType === "sign_xdr" && payload.unsignedXdr) {
      try {
        const parsedUnsigned = TransactionBuilder.fromXDR(
          payload.unsignedXdr,
          config.networkPassphrase,
        );
        expectedSignXdrHash = Buffer.from(parsedUnsigned.hash()).toString("hex").toLowerCase();
      } catch {
        // Ignore if unparseable
      }
    }
    const resolvedSourceAccount = parsedBody.payerAddress ?? payload.sourceAddress;
    const expected: ExpectedTxMatch = {
      minCreatedAtUnix: intent.createdAt,
      ...(resolvedSourceAccount ? { expectedSourceAccount: resolvedSourceAccount } : {}),
      ...(intent.actionType === "pay" || intent.actionType === "request"
        ? {
            destination: payload.destination,
            amount: payload.amount,
            assetCode: payload.assetCode,
            assetIssuer: payload.assetIssuer,
            memo: payload.memo,
            allowSorobanRpcFallback: Boolean(payload.destination?.startsWith("C")),
          }
        : intent.actionType === "swap"
          ? { allowSorobanRpcFallback: true, expectedActionType: "swap" }
          : intent.actionType === "sign_xdr"
            ? {
                allowSorobanRpcFallback: true,
                ...(expectedSignXdrHash ? { expectedTxHash: expectedSignXdrHash } : {}),
              }
            : intent.actionType === "reclaim_reserve"
              ? { expectedActionType: "reclaim_reserve" }
              : {}),
    };

    const txCheck = await verifyFn(config, parsedBody.txHash, expected);
    if (!txCheck.confirmed) {
      return c.json({ error: txCheck.reason }, 409);
    }

    const updated = await repo.markIntentConfirmed(intent.intentId, parsedBody.txHash);
    const derivedAssetLabel =
      payload.assetCode ??
      (payload.fromAsset && payload.toAsset
        ? `${payload.fromAsset.split(":")[0]}->${payload.toAsset.split(":")[0]}`
        : undefined);
    await Promise.all([
      repo.recordVerifiedTx?.({
        txHash: parsedBody.txHash.toLowerCase(),
        network: config.network,
        actionType: intent.actionType,
        assetCode: derivedAssetLabel,
        amountEst: payload.amount,
      }) ?? Promise.resolve(),
      repo.incrementProductEvent?.({
        dayUtc: new Date().toISOString().slice(0, 10),
        network: config.network,
        eventType: "intent_confirmed",
      }) ?? Promise.resolve(),
    ]);

    if (payload.originApp === "astrodex" || payload.originApp === "astrogate") {
      const isGate = payload.originApp === "astrogate";
      const callbackBody = JSON.stringify({
        sig: payload.originConfirmSig ?? parsedBody.sig,
        txHash: parsedBody.txHash,
      });
      const callbackHeaders: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (config.ecosystemSharedIntentSecret) {
        callbackHeaders["X-Ecosystem-Secret"] = config.ecosystemSharedIntentSecret;
      }
      const dispatchBoomerangConfirm = async () => {
        if (!isGate && c.env?.ASTRODEX) {
          await c.env.ASTRODEX.fetch(
            new Request(
              `https://astrodex.internal/v1/intents/${encodeURIComponent(intent.intentId)}/confirm`,
              {
                method: "POST",
                headers: callbackHeaders,
                body: callbackBody,
              },
            ),
          );
        } else if (isGate && c.env?.ASTROGATE) {
          await c.env.ASTROGATE.fetch(
            new Request(
              `https://astrogate.internal/v1/intents/${encodeURIComponent(intent.intentId)}/confirm`,
              {
                method: "POST",
                headers: callbackHeaders,
                body: callbackBody,
              },
            ),
          );
        } else {
          const rawBase = isGate ? config.astrogateApiBaseUrl : config.astrodexApiBaseUrl;
          if (!rawBase) return;
          const base = rawBase.replace(/\/+$/, "");
          const fetchImpl = deps.fetchFn ?? fetch;
          await fetchImpl(
            `${base}/v1/intents/${encodeURIComponent(intent.intentId)}/confirm`,
            {
              method: "POST",
              headers: callbackHeaders,
              body: callbackBody,
            },
          );
        }
      };
      const callbackPromise = dispatchBoomerangConfirm().catch(() => undefined);
      try {
        c.executionCtx.waitUntil(callbackPromise);
      } catch {
        await callbackPromise;
      }
    }

    let cardText: string;
    if (intent.actionType === "request") {
      cardText = formatRequestCard({
        status: "confirmed",
        amount: payload.amount ?? "?",
        assetCode: payload.assetCode ?? "XLM",
        requesterLabel: payload.recipientLabel ?? "Requester",
        recipientAddress: payload.destination ?? "",
        memo: payload.memo,
        network: config.network,
        txHash: parsedBody.txHash,
        botUsername: config.tgBotUsername,
      });
    } else if (intent.actionType === "swap") {
      cardText = formatSwapQuoteCard({
        status: "confirmed",
        fromAsset: payload.fromAsset ?? "",
        toAsset: payload.toAsset ?? "",
        inputAmount: payload.amount ?? "0",
        expectedOutputAmount: payload.expectedOutputAmount ?? "0",
        provider: payload.provider ?? "soroswap",
        priceImpactPct: payload.priceImpactPct ?? "N/A",
        network: config.network,
        txHash: parsedBody.txHash,
        botUsername: config.tgBotUsername,
      });
    } else {
      cardText = formatPaymentIntentCard({
        status: "confirmed",
        amount: payload.amount ?? "?",
        assetCode: payload.assetCode ?? "XLM",
        senderLabel: payload.senderLabel ?? "Sender",
        recipientLabel: payload.recipientLabel ?? "Recipient",
        memo: payload.memo,
        network: config.network,
        txHash: parsedBody.txHash,
        botUsername: config.tgBotUsername,
      });
    }

    const cardUpdated = await maybeEditCard(cardText);

    return c.json({
      ok: true,
      status: updated?.status ?? "confirmed",
      txHash: parsedBody.txHash,
      ledger: txCheck.ledger,
      telegramCardUpdated: cardUpdated,
    });
  });

  return router;
}
