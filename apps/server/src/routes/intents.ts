import {
  ClassicAddressSchema,
  ContractAddressSchema,
  type ClaimLink,
  type ClassicAddress,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  buildIntentDeepLink,
  deriveClaimId,
  formatClaimLinkCard,
  formatPaymentIntentCard,
  formatRequestCard,
  formatSplitCard,
  formatSwapQuoteCard,
  verifyConnectSignature,
  verifyIntentToken,
  verifySmartAccountGuardianSignature,
} from "@astrowallet/tg-protocol";
import { Hono } from "hono";
import { z } from "zod";
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

const ClassicAccountSubmissionSchema = z.object({
  address: ClassicAddressSchema,
  kind: z.literal("classic"),
  label: z.string().trim().min(1).max(32),
  isDefault: z.boolean().optional(),
  signatureBase64: z.string().min(16),
});

const SmartAccountSubmissionSchema = z.object({
  address: ContractAddressSchema,
  kind: z.literal("smart"),
  label: z.string().trim().min(1).max(32),
  isDefault: z.boolean().optional(),
  guardianAddress: ClassicAddressSchema,
  signatureBase64: z.string().min(16),
});

const ConnectAccountSubmissionSchema = z.union([
  ClassicAccountSubmissionSchema,
  SmartAccountSubmissionSchema,
]);

const ConnectIntentBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  accounts: z.array(ConnectAccountSubmissionSchema).min(1).max(10),
});

const ConfirmIntentBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
  stage: z.enum(["funded", "claimed"]).optional(),
  payerAddress: z.string().min(8).max(100).optional(),
  senderAddress: ClassicAddressSchema.optional(),
  expiresAt: z.number().int().positive().optional(),
});

interface IntentPayload {
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
  claimId?: string | undefined;
}

function parsePayload(raw: string): IntentPayload {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as IntentPayload) : {};
  } catch {
    return {};
  }
}

async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export type IntentRouteEnv = {
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

export function createIntentRoutes(deps: IntentRoutesDeps = {}): Hono<IntentRouteEnv> {
  const router = new Hono<IntentRouteEnv>();

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

    return c.json({
      intentId: intent.intentId,
      network: intent.network,
      actionType: intent.actionType,
      status: intent.status,
      payload,
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
    if (intent.status !== "pending") {
      return c.json({ error: `Intent already ${intent.status}` }, 409);
    }

    const storedPayload = JSON.parse(intent.payloadJson) as {
      message?: string;
      challenge?: { usernameLower?: string };
    };
    if (!storedPayload.message) {
      return c.json({ error: "Corrupted challenge state" }, 500);
    }

    const verifiedInputs = [];
    for (const acc of parsedBody.accounts) {
      const ok =
        acc.kind === "classic"
          ? await verifyConnectSignature({
              address: acc.address,
              message: storedPayload.message,
              signatureBase64: acc.signatureBase64,
            })
          : await verifySmartAccountGuardianSignature({
              contractAddress: acc.address,
              guardianAddress: acc.guardianAddress,
              challengeMessage: storedPayload.message,
              signatureBase64: acc.signatureBase64,
            });
      if (!ok) {
        return c.json(
          { error: `Cryptographic signature failed for ${acc.address}` },
          401,
        );
      }
      verifiedInputs.push({
        address: acc.address,
        kind: acc.kind,
        label: acc.label,
        isDefault: acc.isDefault,
        verifiedSigHash: await sha256Hex(acc.signatureBase64),
      });
    }

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
        },
        deps.telegramApiDeps,
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
        deps.telegramApiDeps,
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

      if (stage === "funded" && (intent.status !== "pending" || existingClaim !== null)) {
        return c.json({ error: `Claim link already funded or ${intent.status}` }, 409);
      }
      if (
        stage === "claimed" &&
        intent.status !== "signed" &&
        existingClaim?.status !== "open"
      ) {
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

      const expected: ExpectedTxMatch = {
        minCreatedAtUnix: intent.createdAt,
        allowSorobanRpcFallback: true,
        sorobanInvoke: {
          contractId: escrowParsed.data,
          functionName: stage === "funded" ? "create_claim" : "claim",
          firstArgHex: claimId,
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
          expiresAt: parsedBody.expiresAt ?? intent.expiresAt,
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

      await repo.markClaimLinkStatus(claimId, "claimed");
      const updated = await repo.markIntentConfirmed(intent.intentId, parsedBody.txHash);
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

      const { paidCount } = await repo.recordSplitPayment({
        intentId: intent.intentId,
        payerAddress: parsedBody.payerAddress,
        txHash: parsedBody.txHash,
        amount: payload.amount ?? "0",
      });
      const allTxHashes = await repo.listSplitPaymentTxHashes(intent.intentId);
      const isComplete = paidCount >= participantCount;
      if (isComplete) {
        await repo.markIntentConfirmed(intent.intentId, parsedBody.txHash);
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
                  url: buildIntentDeepLink(config.pwaOrigin, intent.intentId, intent.hmacSig),
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

    const expected: ExpectedTxMatch = {
      minCreatedAtUnix: intent.createdAt,
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
          ? { allowSorobanRpcFallback: true }
          : {}),
    };

    const txCheck = await verifyFn(config, parsedBody.txHash, expected);
    if (!txCheck.confirmed) {
      return c.json({ error: txCheck.reason }, 409);
    }

    const updated = await repo.markIntentConfirmed(intent.intentId, parsedBody.txHash);

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
      });
    } else if (intent.actionType === "swap") {
      cardText = formatSwapQuoteCard({
        status: "confirmed",
        fromAsset: payload.fromAsset ?? "",
        toAsset: payload.toAsset ?? "",
        inputAmount: payload.amount ?? "0",
        expectedOutputAmount: payload.expectedOutputAmount ?? "0",
        provider: payload.provider ?? "soroswap",
        priceImpactPct: payload.priceImpactPct ?? "0",
        network: config.network,
        txHash: parsedBody.txHash,
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
