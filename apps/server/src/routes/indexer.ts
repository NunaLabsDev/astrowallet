import type { ServerConfig } from "@astrowallet/domain";
import { formatIncomingAlertCard } from "@astrowallet/tg-protocol";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import { sendTelegramMessage, type TelegramApiDeps } from "../telegram-api.js";

export interface IndexerRoutesDeps {
  telegramApiDeps?: TelegramApiDeps | undefined;
}

type IndexerRouteEnv = {
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

const RawIndexerEventSchema = z.object({
  txHash: z.string().min(8).optional(),
  transaction_hash: z.string().min(8).optional(),
  from: z.string().min(8).optional(),
  from_address: z.string().min(8).optional(),
  to: z.string().min(8).optional(),
  to_address: z.string().min(8).optional(),
  amount: z.union([z.string(), z.number()]),
  assetCode: z.string().min(1).max(16).optional(),
  asset_code: z.string().min(1).max(16).optional(),
  ledger: z.number().int().nonnegative().optional(),
});

interface NormalizedIndexerEvent {
  txHash: string;
  from: string;
  to: string;
  amount: string;
  assetCode: string;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function verifyHmacSha256Hex(
  secret: string,
  payload: string,
  providedHeader: string,
): Promise<boolean> {
  const normalizedHex = providedHeader.trim().replace(/^sha256=/i, "").toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalizedHex)) {
    return false;
  }

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sigBytes = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload)),
  );
  const expectedHex = Array.from(sigBytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return constantTimeEqual(normalizedHex, expectedHex);
}

function normalizeEvents(rawJson: unknown): NormalizedIndexerEvent[] {
  const rawList: unknown[] = Array.isArray(rawJson)
    ? rawJson
    : rawJson && typeof rawJson === "object" && Array.isArray((rawJson as { events?: unknown }).events)
      ? (rawJson as { events: unknown[] }).events
      : rawJson && typeof rawJson === "object" && Array.isArray((rawJson as { data?: unknown }).data)
        ? (rawJson as { data: unknown[] }).data
        : [rawJson];

  const out: NormalizedIndexerEvent[] = [];
  for (const item of rawList) {
    const parsed = RawIndexerEventSchema.parse(item);
    const txHash = parsed.txHash ?? parsed.transaction_hash;
    const from = parsed.from ?? parsed.from_address;
    const to = parsed.to ?? parsed.to_address;
    if (!txHash || !from || !to) {
      throw new Error("Indexer event requires txHash, from, and to fields");
    }
    const rawCode = parsed.assetCode ?? parsed.asset_code ?? "XLM";
    const assetCode = rawCode.toLowerCase() === "native" ? "XLM" : rawCode;
    out.push({
      txHash,
      from,
      to,
      amount: String(parsed.amount),
      assetCode,
    });
  }
  return out;
}

/**
 * Mounts `POST /webhooks/indexer` for Goldsky Turbo Pipelines / Mercury real-time Stellar alerts.
 */
export function createIndexerRoutes(deps: IndexerRoutesDeps = {}): Hono<IndexerRouteEnv> {
  const router = new Hono<IndexerRouteEnv>();

  router.post("/", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");

    if (!config.indexerWebhookSecret) {
      return c.json({ error: "INDEXER_WEBHOOK_SECRET is not configured" }, 503);
    }

    const rawBody = await c.req.text();
    const secretHeader =
      c.req.header("X-Indexer-Secret") ??
      c.req.header("X-Webhook-Secret") ??
      c.req.header("Authorization")?.replace(/^Bearer\s+/i, "");

    const sigHeader =
      c.req.header("X-Webhook-Signature") ??
      c.req.header("X-Goldsky-Signature") ??
      c.req.header("X-Mercury-Signature");

    let authorized = false;
    if (secretHeader && constantTimeEqual(secretHeader.trim(), config.indexerWebhookSecret)) {
      authorized = true;
    } else if (sigHeader) {
      authorized = await verifyHmacSha256Hex(
        config.indexerWebhookSecret,
        rawBody,
        sigHeader,
      );
    }

    if (!authorized) {
      return c.json({ error: "Unauthorized indexer webhook request" }, 401);
    }

    let events: NormalizedIndexerEvent[];
    try {
      const parsedJson = JSON.parse(rawBody) as unknown;
      events = normalizeEvents(parsedJson);
    } catch (err) {
      return c.json(
        {
          error: "Invalid indexer event payload",
          details: err instanceof Error ? err.message : undefined,
        },
        400,
      );
    }

    const watched = await repo.listWatchedAccounts();
    const watchedByAddress = new Map<string, typeof watched>();
    for (const acc of watched) {
      const list = watchedByAddress.get(acc.address);
      if (list) {
        watchedByAddress.set(acc.address, [...list, acc]);
      } else {
        watchedByAddress.set(acc.address, [acc]);
      }
    }

    let alertsSent = 0;
    for (const ev of events) {
      const matches = watchedByAddress.get(ev.to);
      if (!matches) continue;
      for (const recipient of matches) {
        const dedupKey = `alert:${config.network}:${ev.txHash.toLowerCase()}:${recipient.address}:${recipient.telegramUserId}`;
        const claimed = await repo.claimAlertDedupKey(dedupKey);
        if (!claimed) continue;

        const ok = await sendTelegramMessage(
          {
            botToken: config.tgBotToken,
            chatId: recipient.telegramUserId,
            text: formatIncomingAlertCard({
              addressLabel: recipient.label,
              address: recipient.address,
              amount: ev.amount,
              assetCode: ev.assetCode,
              fromAddress: ev.from,
              txHash: ev.txHash,
              network: config.network,
            }),
          },
          deps.telegramApiDeps,
        );
        if (ok) {
          alertsSent += 1;
        }
      }
    }

    return c.json({
      ok: true,
      processed: events.length,
      alertsSent,
    });
  });

  return router;
}
