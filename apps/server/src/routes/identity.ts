import type { ServerConfig } from "@astrowallet/domain";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import type { ServerRepository, TelegramUserRecord } from "../db/repository.js";
import { checkRateLimit, clientKeyFromHeaders } from "../rate-limit.js";

export type IdentityRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    config: ServerConfig;
    repo: ServerRepository;
  };
};

/**
 * Public read-only AstroID SSO directory (`/v1/identity/resolve`).
 * Returns strictly public G.../C... addresses and @username — never encrypted vault backups.
 */
export function createIdentityRoutes(): Hono<IdentityRouteEnv> {
  const router = new Hono<IdentityRouteEnv>();

  router.get("/resolve", async (c) => {
    const config = c.get("config");
    const repo = c.get("repo");

    const clientKey = clientKeyFromHeaders(c.req.raw.headers);
    const rate = await checkRateLimit({
      repository: repo,
      scope: "identity",
      clientKey,
      limitPerMin: config.proxyRateLimitPerMin,
    });
    if (!rate.allowed) {
      c.header("Retry-After", String(rate.retryAfterSeconds));
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    const rawQuery = c.req.query("q") ?? "";
    const q = rawQuery.trim().replace(/^@/, "");
    if (!q || q.length > 64) {
      return c.json({ error: "Valid query parameter ?q=<tgUserId|@username|G...|C...> is required" }, 400);
    }

    let user: TelegramUserRecord | null = null;
    let telegramUserId: string | undefined;

    if (/^\d{1,20}$/.test(q)) {
      telegramUserId = q;
      user = await repo.getUserById(q);
    } else if (/^[GC][A-Z2-7]{55}$/.test(q)) {
      if (repo.getUserByLinkedAddress) {
        user = await repo.getUserByLinkedAddress(q);
        if (user) {
          telegramUserId = user.telegramUserId;
        }
      } else {
        const watched = await repo.listWatchedAccounts();
        const match = watched.find((item) => item.address === q);
        if (match) {
          telegramUserId = match.telegramUserId;
          user = await repo.getUserById(match.telegramUserId);
        }
      }
    } else if (/^[a-zA-Z0-9_]{3,32}$/.test(q)) {
      user = await repo.getUserByUsername(q.toLowerCase());
      if (user) {
        telegramUserId = user.telegramUserId;
      }
    } else {
      return c.json({ error: "Unsupported AstroID query format" }, 400);
    }

    if (!telegramUserId) {
      return c.json({ ok: true, found: false, accounts: [] });
    }

    const accounts = await repo.listLinkedAddresses(telegramUserId);
    const firstAccount = accounts[0];
    if (!firstAccount) {
      return c.json({ ok: true, found: false, accounts: [] });
    }

    const primaryAddress = accounts.find((a) => a.isDefault)?.address ?? firstAccount.address;

    let preferredNetwork: "mainnet" | "testnet" | undefined;
    let activeAddress: string | undefined;
    if (c.env.CACHE) {
      try {
        const rawPref = await c.env.CACHE.get(`eco_pref:${telegramUserId}`);
        if (rawPref) {
          const parsedPref = JSON.parse(rawPref) as {
            preferredNetwork?: unknown;
            activeAddress?: unknown;
          };
          if (parsedPref.preferredNetwork === "mainnet" || parsedPref.preferredNetwork === "testnet") {
            preferredNetwork = parsedPref.preferredNetwork;
          }
          if (
            typeof parsedPref.activeAddress === "string" &&
            accounts.some((a) => a.address === parsedPref.activeAddress)
          ) {
            activeAddress = parsedPref.activeAddress;
          }
        }
      } catch {
        // Ignore malformed KV preference entry
      }
    }

    return c.json({
      ok: true,
      found: true,
      telegramUserId: user?.telegramUserId ?? firstAccount.telegramUserId,
      username: user?.usernameLower,
      primaryAddress,
      ...(preferredNetwork ? { preferredNetwork } : {}),
      ...(activeAddress ? { activeAddress } : {}),
      accounts: accounts.map((a) => ({
        address: a.address,
        kind: a.kind,
        label: a.label,
        isDefault: a.isDefault,
      })),
    });
  });

  return router;
}
