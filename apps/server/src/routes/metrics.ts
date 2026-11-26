import type { ServerConfig } from "@astrowallet/domain";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import { clientKeyFromHeaders } from "../rate-limit.js";
import { authenticateMiniAppSession } from "./tg-auth.js";

const EventBodySchema = z.object({
  eventType: z.enum([
    "app_open",
    "wallet_created",
    "wallet_imported",
    "wallet_linked",
    "tx_sent",
    "swap_executed",
    "trustline_added",
    "token_inspected",
    "nft_viewed",
    "stats_viewed",
    "intent_confirmed",
    "astro_connect_approved",
  ]),
  platform: z.string().trim().max(32).optional(),
  lang: z.string().trim().max(16).optional(),
  txHash: z
    .string()
    .trim()
    .regex(/^[a-f0-9]{64}$/i)
    .optional(),
  assetCode: z.string().trim().max(12).optional(),
  amountEst: z.string().trim().max(32).optional(),
});

export function utcDayString(nowMs = Date.now()): string {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/**
 * Computes a monthly-salted SHA-256 user hash so DAU/WAU/MAU can be measured
 * over a rolling 30-day window without ever storing or exposing raw Telegram IDs.
 */
export async function computeMonthlyUserHash(
  telegramUserId: string,
  secret: string,
  dayUtc = utcDayString(),
): Promise<string> {
  const month = dayUtc.slice(0, 7);
  const raw = `astro_dau:${telegramUserId}:${month}:${secret}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 24);
}

export type MetricsRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

function escapeXml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function createMetricsRoutes(): Hono<MetricsRouteEnv> {
  const router = new Hono<MetricsRouteEnv>();

  router.get("/public", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const cacheKey = `metrics_public:${config.network}`;
    let snapshot: Awaited<ReturnType<typeof repo.getPublicMetricsSnapshot>> | null = null;
    if (c.env.CACHE) {
      try {
        const cached = await c.env.CACHE.get(cacheKey);
        if (cached) {
          snapshot = JSON.parse(cached) as Awaited<ReturnType<typeof repo.getPublicMetricsSnapshot>>;
        }
      } catch {
        snapshot = null;
      }
    }
    if (!snapshot) {
      snapshot = await repo.getPublicMetricsSnapshot(config.network);
      if (c.env.CACHE) {
        await c.env.CACHE.put(cacheKey, JSON.stringify(snapshot), { expirationTtl: 60 }).catch(() => {});
      }
    }

    c.header("Cache-Control", "public, max-age=120, stale-while-revalidate=600");
    return c.json({
      ok: true,
      service: "astrowallet",
      network: config.network,
      generatedAt: new Date().toISOString(),
      privacy: {
        cookies: false,
        thirdPartyTrackers: false,
        piiExposed: false,
        hashing: "monthly-salted-sha256",
      },
      ecosystem: {
        astroDexApiBaseUrl: config.astrodexApiBaseUrl ?? null,
        tgBotUsername: config.tgBotUsername ?? "AstroWalletAppBot",
      },
      metrics: snapshot,
    });
  });

  router.get("/badge.svg", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const snapshot = await repo.getPublicMetricsSnapshot(config.network);
    const active = snapshot.mau > 0 ? snapshot.mau : snapshot.totalRegisteredUsers;
    const label = "AstroWallet MAU";
    const value = `${active} (${config.network})`;
    const leftW = 104;
    const rightW = Math.max(78, value.length * 7 + 16);
    const totalW = leftW + rightW;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20" role="img" aria-label="${escapeXml(label)}: ${escapeXml(value)}">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#fff" stop-opacity=".12"/><stop offset="1" stop-opacity=".12"/></linearGradient>
  <clipPath id="r"><rect width="${totalW}" height="20" rx="4" fill="#fff"/></clipPath>
  <g clip-path="url(#r)">
    <rect width="${leftW}" height="20" fill="#172C69"/>
    <rect x="${leftW}" width="${rightW}" height="20" fill="#8050C8"/>
    <rect width="${totalW}" height="20" fill="url(#s)"/>
  </g>
  <g fill="#fff" text-anchor="middle" font-family="Verdana,Geneva,DejaVu Sans,sans-serif" font-size="11">
    <text x="${leftW / 2}" y="14">${escapeXml(label)}</text>
    <text x="${leftW + rightW / 2}" y="14" font-weight="bold">${escapeXml(value)}</text>
  </g>
</svg>`;

    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    c.header("Cache-Control", "public, max-age=300, stale-while-revalidate=600");
    return c.body(svg, 200);
  });

  router.post("/event", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const rl = await repo.incrementRateLimit({
      key: `metrics_ev:${clientKeyFromHeaders(c.req.raw.headers)}`,
      windowSec: 60,
      limit: 60,
    });
    if (!rl.allowed) {
      c.header("Retry-After", String(rl.retryAfterSeconds));
      return c.json({ error: "Telemetry rate limit exceeded" }, 429);
    }

    let body: z.infer<typeof EventBodySchema>;
    try {
      body = EventBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        {
          error: "Invalid telemetry event",
          details: err instanceof Error ? err.message : undefined,
        },
        400,
      );
    }

    const session = await authenticateMiniAppSession(c).catch(() => ({
      ok: false as const,
      status: 401 as const,
      error: "Unauthorized",
    }));
    if (!session.ok) {
      return c.json({ error: session.error }, session.status);
    }

    const dayUtc = utcDayString();
    const userHash = await computeMonthlyUserHash(
      session.claims.telegramUserId,
      config.intentHmacSecret,
      dayUtc,
    );
    await Promise.all([
      repo.incrementProductEvent({
        dayUtc,
        network: config.network,
        eventType: body.eventType,
      }),
      repo.recordDailyUserActivity({
        dayUtc,
        userHash,
        network: config.network,
        platform: body.platform ?? "unknown",
        lang: body.lang ?? "en",
      }),
    ]);

    return c.json({ ok: true });
  });

  return router;
}
