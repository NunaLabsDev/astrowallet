import {
  AccountKindSchema,
  ClassicAddressSchema,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  formatPaymentIntentCard,
  verifyConnectSignature,
  verifyIntentToken,
} from "@astrowallet/tg-protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import {
  verifyTransactionConfirmed,
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
        config: Pick<ServerConfig, "horizonUrls">,
        txHash: string,
      ) => Promise<TxVerificationResult>)
    | undefined;
  telegramApiDeps?: TelegramApiDeps | undefined;
}

const ConnectAccountSubmissionSchema = z.object({
  address: ClassicAddressSchema,
  kind: AccountKindSchema,
  label: z.string().trim().min(1).max(32),
  isDefault: z.boolean().optional(),
  signatureBase64: z.string().min(16),
});

const ConnectIntentBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  accounts: z.array(ConnectAccountSubmissionSchema).min(1).max(10),
});

const ConfirmIntentBodySchema = z.object({
  sig: z.string().regex(/^[a-f0-9]{64}$/i),
  txHash: z.string().regex(/^[a-fA-F0-9]{64}$/),
});

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

    let payload: unknown = {};
    try {
      payload = JSON.parse(intent.payloadJson);
    } catch {
      payload = {};
    }

    return c.json({
      intentId: intent.intentId,
      network: intent.network,
      actionType: intent.actionType,
      status: intent.status,
      payload,
      txHash: intent.txHash,
      expiresAt: intent.expiresAt,
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
      const ok = await verifyConnectSignature({
        address: acc.address,
        message: storedPayload.message,
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

    if (intent.status === "confirmed" && intent.txHash === parsedBody.txHash) {
      return c.json({ ok: true, status: "confirmed", txHash: intent.txHash });
    }
    if (intent.status !== "pending") {
      return c.json({ error: `Intent already ${intent.status}` }, 409);
    }

    const verifyFn =
      deps.verifyTxFn ??
      ((cfg, hash) => verifyTransactionConfirmed(cfg, hash, deps.fetchFn));

    const txCheck = await verifyFn(config, parsedBody.txHash);
    if (!txCheck.confirmed) {
      return c.json({ error: txCheck.reason }, 409);
    }

    const updated = await repo.markIntentConfirmed(intent.intentId, parsedBody.txHash);
    const payload = JSON.parse(intent.payloadJson) as {
      amount?: string;
      assetCode?: string;
      senderLabel?: string;
      recipientLabel?: string;
      memo?: string;
    };

    let cardUpdated = false;
    if (intent.inlineMessageId || (intent.chatId && intent.messageId)) {
      cardUpdated = await editTelegramMessage(
        {
          botToken: config.tgBotToken,
          target: {
            chatId: intent.chatId,
            messageId: intent.messageId,
            inlineMessageId: intent.inlineMessageId,
          },
          text: formatPaymentIntentCard({
            status: "confirmed",
            amount: payload.amount ?? "?",
            assetCode: payload.assetCode ?? "XLM",
            senderLabel: payload.senderLabel ?? "Sender",
            recipientLabel: payload.recipientLabel ?? "Recipient",
            memo: payload.memo,
            network: config.network,
            txHash: parsedBody.txHash,
          }),
        },
        deps.telegramApiDeps,
      );
    }

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
