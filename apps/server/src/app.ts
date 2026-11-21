import { parseServerConfig, type ServerConfig } from "@astrowallet/domain";
import type {
  D1Database,
  DurableObjectNamespace,
  KVNamespace,
} from "@cloudflare/workers-types";
import { webhookCallback } from "grammy";
import { Hono, type Context, type Next } from "hono";
import { createTelegramBot } from "./bot.js";
import { createD1Repository, type ServerRepository } from "./db/repository.js";
import { createIndexerRoutes } from "./routes/indexer.js";
import { createIntentRoutes, type IntentRoutesDeps } from "./routes/intents.js";
import { createProxyRoutes } from "./routes/proxy.js";
import { createRelayRoutes } from "./routes/relay.js";
import { createTgAuthRoutes } from "./routes/tg-auth.js";
import type { FetchLike } from "./stellar-verifier.js";

export interface WorkerBindings {
  DB?: D1Database;
  CACHE?: KVNamespace;
  CHAIN_WATCHER?: DurableObjectNamespace;
  [key: string]: unknown;
}

export interface ServerDeps extends IntentRoutesDeps {
  createRepo?: ((env: WorkerBindings) => ServerRepository) | undefined;
  fetchFn?: FetchLike | undefined;
}

type AppEnv = {
  Bindings: WorkerBindings;
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function createApp(deps: ServerDeps = {}): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // 1. Validate env via Zod on startup/request (zero hardcoding, fail fast)
  app.use("*", async (c, next) => {
    let config: ServerConfig;
    try {
      config = parseServerConfig(c.env as Record<string, unknown>);
    } catch (err) {
      return c.json(
        {
          error: "Server environment misconfigured",
          message: err instanceof Error ? err.message : "Invalid configuration",
        },
        500,
      );
    }
    c.set("config", config);

    // 2. Strict CORS allowlist (never wildcard '*')
    const origin = c.req.header("Origin");
    if (origin) {
      if (!config.allowedOrigins.includes(origin)) {
        return c.json({ error: "Origin not allowed" }, 403);
      }
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Vary", "Origin");
      c.header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
      c.header("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (c.req.method === "OPTIONS") {
        return c.body(null, 204);
      }
    }

    await next();
    return undefined;
  });

  app.get("/health", (c) => {
    const config = c.get("config");
    return c.json({
      status: "ok",
      network: config.network,
      timestamp: new Date().toISOString(),
    });
  });

  // Repository middleware for stateful routes (/tg/webhook and /v1/intents/*)
  const attachRepo = async (c: Context<AppEnv>, next: Next) => {
    if (deps.createRepo) {
      c.set("repo", deps.createRepo(c.env));
    } else if (c.env.DB) {
      c.set("repo", createD1Repository(c.env.DB));
    } else {
      return c.json({ error: "D1 binding DB is not configured" }, 500);
    }
    await next();
    return undefined;
  };

  const attachOptionalRepo = async (c: Context<AppEnv>, next: Next) => {
    if (deps.createRepo) {
      c.set("repo", deps.createRepo(c.env));
    } else if (c.env.DB) {
      c.set("repo", createD1Repository(c.env.DB));
    }
    await next();
    return undefined;
  };

  app.use("/tg/webhook", attachRepo);
  app.use("/v1/tg/*", attachRepo);
  app.use("/v1/intents/*", attachRepo);
  app.use("/v1/relay/*", attachOptionalRepo);
  app.use("/v1/proxy/*", attachOptionalRepo);
  app.use("/webhooks/indexer", attachRepo);
  app.use("/webhooks/indexer/*", attachRepo);

  app.post("/tg/webhook", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");
    const secretHeader = c.req.header("X-Telegram-Bot-Api-Secret-Token");
    if (!secretHeader || !constantTimeEqual(secretHeader, config.tgWebhookSecret)) {
      return c.json({ error: "Unauthorized Telegram webhook request" }, 401);
    }

    if (c.env.CHAIN_WATCHER) {
      const id = c.env.CHAIN_WATCHER.idFromName(`watcher:${config.network}`);
      const stub = c.env.CHAIN_WATCHER.get(id);
      c.executionCtx.waitUntil(
        stub.fetch("https://chain-watcher.internal/ensure", { method: "POST" }).catch(() => {}),
      );
    }

    // Deduplicate retried Telegram webhooks atomically using update_id before entering handlers
    let updateId: number | undefined;
    try {
      const bodyCopy = (await c.req.raw.clone().json()) as { update_id?: unknown };
      if (typeof bodyCopy.update_id === "number" && Number.isInteger(bodyCopy.update_id)) {
        updateId = bodyCopy.update_id;
      }
    } catch {
      // Let grammY reject malformed JSON payloads
    }
    if (updateId !== undefined) {
      const claimed = await repo.claimTelegramUpdateId(updateId);
      if (!claimed) {
        return c.json({ ok: true, duplicate: true }, 200);
      }
    }

    const bot = createTelegramBot(config, repo, {
      fetchFn: deps.fetchFn,
      cache: c.env.CACHE,
    });
    const handler = webhookCallback(bot, "hono");
    return handler(c);
  });

  app.route("/v1/tg", createTgAuthRoutes());

  app.route(
    "/v1/intents",
    createIntentRoutes({
      fetchFn: deps.fetchFn,
      verifyTxFn: deps.verifyTxFn,
      telegramApiDeps: deps.telegramApiDeps,
    }),
  );

  app.route("/v1/proxy", createProxyRoutes({ fetchFn: deps.fetchFn }));
  app.route("/v1/relay", createRelayRoutes({ fetchFn: deps.fetchFn }));
  app.route(
    "/webhooks/indexer",
    createIndexerRoutes({ telegramApiDeps: deps.telegramApiDeps }),
  );

  return app;
}
