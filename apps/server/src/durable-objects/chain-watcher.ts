import { decimalToStroops7 } from "@astrowallet/defi";
import { parseServerConfig } from "@astrowallet/domain";
import { fetchSep42VerifiedAssets } from "@astrowallet/security-shield";
import type { DurableObjectState } from "@cloudflare/workers-types";
import {
  buildMiniAppWebAppUrl,
  formatIncomingAlertCard,
} from "@astrowallet/tg-protocol";
import type { WorkerBindings } from "../app.js";
import { createD1Repository } from "../db/repository.js";
import { fetchIncomingPaymentsSince, fetchLatestPaymentCursor } from "../stellar-verifier.js";
import { sendTelegramMessage } from "../telegram-api.js";

const POLL_INTERVAL_MS = 5_000;
const BATCH_SIZE = 15;
const MIN_NATIVE_ALERT_STROOPS = 500_000n; // 0.05 XLM dust spam filter
const MIN_ISSUED_ALERT_STROOPS = 10_000n; // 0.001 issued asset dust spam filter
const MAX_ALERT_AGE_MS = 15 * 60 * 1000; // Ignore any payment older than 15 minutes
const MAX_ALERTS_PER_ACCOUNT_PER_POLL = 3; // Cap burst spam per poll

interface WatcherStatus {
  lastLedger: number;
  updatedAt: number;
}

/**
 * Cloudflare Durable Object maintaining Stellar Horizon/RPC polling cursors
 * for real-time Testnet/self-hosted Telegram payment alerts.
 */
export class ChainWatcherDO {
  private readonly state: DurableObjectState;
  private readonly env: WorkerBindings;

  constructor(state: DurableObjectState, env: WorkerBindings) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/status" && request.method === "GET") {
      const status =
        (await this.state.storage.get<WatcherStatus>("cursor")) ?? {
          lastLedger: 0,
          updatedAt: 0,
        };
      const alarmAt = await this.state.storage.getAlarm();
      return Response.json({ status: alarmAt ? "watching" : "idle", alarmAt, ...status });
    }

    if (url.pathname === "/ensure" && request.method === "POST") {
      const currentAlarm = await this.state.storage.getAlarm();
      if (!currentAlarm) {
        await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
      }
      return Response.json({ ok: true, scheduled: true });
    }

    if (url.pathname === "/cursor" && request.method === "POST") {
      const body = (await request.json()) as { lastLedger?: unknown };
      if (
        typeof body.lastLedger !== "number" ||
        !Number.isInteger(body.lastLedger) ||
        body.lastLedger < 0
      ) {
        return Response.json({ error: "Invalid lastLedger" }, { status: 400 });
      }
      const next: WatcherStatus = {
        lastLedger: body.lastLedger,
        updatedAt: Date.now(),
      };
      await this.state.storage.put("cursor", next);
      return Response.json({ ok: true, ...next });
    }

    return Response.json({ error: "Not found" }, { status: 404 });
  }

  async alarm(): Promise<void> {
    if (!this.env.DB) return;

    let config;
    try {
      config = parseServerConfig(this.env as Record<string, unknown>);
    } catch {
      return;
    }

    try {
      const repo = createD1Repository(this.env.DB);
      const watched = await repo.listWatchedAccounts();
      if (watched.length === 0) {
        return;
      }

      const verifiedAssets =
        config.sep42AssetListUrls.length > 0
          ? await fetchSep42VerifiedAssets(config.sep42AssetListUrls).catch(() => [])
          : [];

      const savedOffset = (await this.state.storage.get<number>("batch_offset")) ?? 0;
      const start = savedOffset >= watched.length ? 0 : savedOffset;
      const batch = watched.slice(start, start + BATCH_SIZE);
      const nextOffset = start + BATCH_SIZE >= watched.length ? 0 : start + BATCH_SIZE;
      await this.state.storage.put("batch_offset", nextOffset);

      for (const entry of batch) {
        if (entry.address.startsWith("C")) {
          continue;
        }

        const cursorKey = `pay_cursor:${config.network}:${entry.address}`;
        const savedCursor = await this.state.storage.get<string>(cursorKey);

        try {
          if (!savedCursor) {
            // Initialize baseline cursor at HEAD (order=desc&limit=1) without replaying historical transactions
            const latestToken = await fetchLatestPaymentCursor(config, entry.address);
            await this.state.storage.put(cursorKey, latestToken);
            continue;
          }

          const effectiveCursor =
            savedCursor === "empty_init" || savedCursor === "now" ? undefined : savedCursor;
          const incoming = await fetchIncomingPaymentsSince(
            config,
            entry.address,
            effectiveCursor,
            5,
          );

          let newestCursor = savedCursor;
          let sentCount = 0;
          let sawStaleRecord = false;
          const nowMs = Date.now();

          for (const ev of incoming) {
            newestCursor = ev.pagingToken;

            if (ev.createdAt) {
              const createdMs = Date.parse(ev.createdAt);
              if (Number.isFinite(createdMs) && nowMs - createdMs > MAX_ALERT_AGE_MS) {
                sawStaleRecord = true;
                continue;
              }
            }

            const minThreshold =
              ev.assetCode === "XLM" && !ev.assetIssuer
                ? MIN_NATIVE_ALERT_STROOPS
                : MIN_ISSUED_ALERT_STROOPS;
            try {
              if (decimalToStroops7(ev.amount) < minThreshold) {
                continue;
              }
            } catch {
              continue;
            }

            if (sentCount >= MAX_ALERTS_PER_ACCOUNT_PER_POLL) {
              continue;
            }

            const isVerifiedAsset =
              ev.assetCode === "XLM" && !ev.assetIssuer
                ? true
                : Boolean(
                    ev.assetIssuer &&
                      verifiedAssets.some(
                        (v) =>
                          v.code.toUpperCase() === ev.assetCode.toUpperCase() &&
                          v.issuer === ev.assetIssuer,
                      ),
                  );

            const dedupKey = `alert:${config.network}:${ev.txHash.toLowerCase()}:${entry.address}:${entry.telegramUserId}`;
            const claimed = await repo.claimAlertDedupKey(dedupKey);
            if (!claimed) {
              continue;
            }
            await sendTelegramMessage(
              {
                botToken: config.tgBotToken,
                chatId: entry.telegramUserId,
                text: formatIncomingAlertCard({
                  addressLabel: entry.label,
                  address: entry.address,
                  amount: ev.amount,
                  assetCode: ev.assetCode,
                  assetIssuer: ev.assetIssuer,
                  isVerifiedAsset,
                  fromAddress: ev.from,
                  txHash: ev.txHash,
                  network: config.network,
                  botUsername: config.tgBotUsername,
                }),
                replyMarkup: {
                  inline_keyboard: [
                    [
                      {
                        text: "🔍 Inspect Tx",
                        web_app: {
                          url: buildMiniAppWebAppUrl(config.pwaOrigin, {
                            inspectTx: ev.txHash,
                            net: config.network,
                          }),
                        },
                      },
                      {
                        text: "👤 Account",
                        web_app: {
                          url: buildMiniAppWebAppUrl(config.pwaOrigin, {
                            inspectAddr: entry.address,
                            net: config.network,
                          }),
                        },
                      },
                    ],
                  ],
                },
              },
              { apiOrigin: config.telegramApiOrigin },
            );
            sentCount += 1;
          }

          if (sawStaleRecord) {
            const headCursor = await fetchLatestPaymentCursor(config, entry.address);
            await this.state.storage.put(cursorKey, headCursor);
          } else if (newestCursor !== savedCursor) {
            await this.state.storage.put(cursorKey, newestCursor);
          }
        } catch {
          // Keep polling remaining accounts even if one account query fails transiently
        }
      }
    } finally {
      await this.state.storage.setAlarm(Date.now() + POLL_INTERVAL_MS);
    }
  }
}
