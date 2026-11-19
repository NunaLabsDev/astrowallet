import {
  createHorizonPathSwapAdapter,
} from "@astrowallet/defi";
import {
  StellarAddressSchema,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  createSecurityShield,
  decodeTransactionEnvelope,
  type DirectoryTagEntry,
} from "@astrowallet/security-shield";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import type { FetchLike } from "../stellar-verifier.js";

export interface ProxyRoutesDeps {
  fetchFn?: FetchLike | undefined;
}

export type ProxyRouteEnv = {
  Bindings: {
    CACHE?: KVNamespace;
    [key: string]: unknown;
  };
  Variables: {
    config: ServerConfig;
  };
};

const SwapQuoteBodySchema = z.object({
  fromAsset: z.string().min(1).max(80),
  toAsset: z.string().min(1).max(80),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  slippageBps: z.number().int().min(1).max(5000).default(50),
});

const ScanBodySchema = z.object({
  target: z.string().trim().min(10),
});

const SAFE_PUBLIC_DOMAIN_REGEX =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;

export async function lookupDirectoryTag(
  config: ServerConfig,
  cache: KVNamespace | undefined,
  address: string,
  fetchFn: FetchLike = fetch,
): Promise<DirectoryTagEntry | null> {
  const cacheKey = `dir:${config.network}:${address}`;
  if (cache) {
    const hit = await cache.get(cacheKey);
    if (hit) {
      try {
        return JSON.parse(hit) as DirectoryTagEntry;
      } catch {
        // Ignore corrupted cache item
      }
    }
  }

  if (!config.stellarExpertApiBase) {
    return null;
  }

  const netSlug = config.network === "mainnet" ? "public" : "testnet";
  const base = config.stellarExpertApiBase.replace(/\/+$/, "");
  const res = await fetchFn(
    `${base}/explorer/${netSlug}/directory/${encodeURIComponent(address)}`,
    { headers: { Accept: "application/json" } },
  );
  if (res.status === 404 || !res.ok) {
    return null;
  }

  const raw = (await res.json()) as {
    address?: string;
    name?: string;
    tags?: string[];
  };
  const entry: DirectoryTagEntry = {
    address: raw.address ?? address,
    name: raw.name,
    tags: Array.isArray(raw.tags) ? raw.tags : [],
    memoRequired: Array.isArray(raw.tags) && raw.tags.includes("exchange"),
  };

  if (cache) {
    await cache.put(cacheKey, JSON.stringify(entry), { expirationTtl: 600 });
  }
  return entry;
}

export async function lookupSep29MemoRequired(
  config: ServerConfig,
  address: string,
  fetchFn: FetchLike = fetch,
): Promise<boolean> {
  if (!address.startsWith("G")) return false;
  for (const base of config.horizonUrls) {
    const cleanBase = base.replace(/\/+$/, "");
    try {
      const res = await fetchFn(
        `${cleanBase}/accounts/${encodeURIComponent(address)}`,
        { headers: { Accept: "application/json" } },
      );
      if (res.status === 404) return false;
      if (!res.ok) continue;
      const body = (await res.json()) as {
        data?: Record<string, string>;
      };
      // SEP-29: base64("1") === "MQ=="
      return body.data?.["config.memo_required"] === "MQ==";
    } catch {
      continue;
    }
  }
  return false;
}

export function createProxyRoutes(deps: ProxyRoutesDeps = {}): Hono<ProxyRouteEnv> {
  const router = new Hono<ProxyRouteEnv>();
  const fetchFn = deps.fetchFn ?? fetch;

  router.get("/directory/:address", async (c) => {
    const config = c.get("config");
    const address = c.req.param("address");
    const parsed = StellarAddressSchema.safeParse(address);
    if (!parsed.success) {
      return c.json({ error: "Invalid Stellar address" }, 400);
    }

    const entry = await lookupDirectoryTag(config, c.env.CACHE, parsed.data, fetchFn);
    return c.json(
      entry ?? {
        address: parsed.data,
        tags: [],
        memoRequired: false,
      },
    );
  });

  router.get("/stellar-toml", async (c) => {
    const domain = (c.req.query("domain") ?? "").trim().toLowerCase();
    if (
      !SAFE_PUBLIC_DOMAIN_REGEX.test(domain) ||
      domain.endsWith(".local") ||
      domain.endsWith(".internal")
    ) {
      return c.json({ error: "Invalid public issuer domain" }, 400);
    }

    const cacheKey = `toml:${domain}`;
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(cacheKey);
      if (cached) {
        return c.text(cached, 200);
      }
    }

    const res = await fetchFn(`https://${domain}/.well-known/stellar.toml`, {
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) {
      return c.json({ error: `Unable to fetch stellar.toml from ${domain}` }, 502);
    }

    const text = await res.text();
    if (c.env.CACHE) {
      await c.env.CACHE.put(cacheKey, text, { expirationTtl: 900 });
    }
    return c.text(text, 200);
  });

  router.post("/soroswap/quote", async (c) => {
    const config = c.get("config");
    let reqBody: z.infer<typeof SwapQuoteBodySchema>;
    try {
      reqBody = SwapQuoteBodySchema.parse(await c.req.json());
    } catch (err) {
      return c.json(
        { error: "Invalid swap quote payload", details: err instanceof Error ? err.message : undefined },
        400,
      );
    }

    if (config.soroswapApiBase && config.soroswapApiKey) {
      try {
        const cleanBase = config.soroswapApiBase.replace(/\/+$/, "");
        const res = await fetchFn(
          `${cleanBase}/quote?network=${config.network}`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${config.soroswapApiKey}`,
            },
            body: JSON.stringify(reqBody),
          },
        );
        if (res.ok) {
          const data = (await res.json()) as {
            amountOut?: string;
            expectedOutputAmount?: string;
            priceImpactPct?: string;
            rawTrade?: { xdr?: string };
          };
          const out = data.expectedOutputAmount ?? data.amountOut;
          if (out) {
            return c.json({
              provider: "soroswap",
              inputAmount: reqBody.amount,
              expectedOutputAmount: String(out),
              priceImpactPct: data.priceImpactPct ?? "0.05",
              unsignedXdr: data.rawTrade?.xdr,
            });
          }
        }
      } catch {
        // Fall through to Horizon Path Payments
      }
    }

    try {
      const horizonSwap = createHorizonPathSwapAdapter({
        horizonUrls: config.horizonUrls,
        fetchFn,
      });
      const quote = await horizonSwap.getQuote(reqBody);
      return c.json(quote);
    } catch (err) {
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "No swap route available across Soroswap or Horizon Path Payments",
        },
        422,
      );
    }
  });

  router.post("/scan", async (c) => {
    const config = c.get("config");
    let body: z.infer<typeof ScanBodySchema>;
    try {
      body = ScanBodySchema.parse(await c.req.json());
    } catch {
      return c.json({ error: "Invalid scan payload" }, 400);
    }

    const shield = createSecurityShield({
      networkPassphrase: config.networkPassphrase,
      rpcUrls: config.rpcUrls,
      horizonUrls: config.horizonUrls,
      stellarExpertApiBase: config.stellarExpertApiBase,
      sep42AssetListUrls: [],
      directoryLookup: (addr) => lookupDirectoryTag(config, c.env.CACHE, addr, fetchFn),
      memoRequiredLookup: (addr) => lookupSep29MemoRequired(config, addr, fetchFn),
    });

    const scanner = shield.createScanner();
    const addrParse = StellarAddressSchema.safeParse(body.target);
    if (addrParse.success) {
      const report = await scanner.scanAddress(addrParse.data);
      return c.json({
        kind: "address",
        target: addrParse.data,
        report,
      });
    }

    try {
      const decoded = decodeTransactionEnvelope(
        body.target,
        config.networkPassphrase,
      );
      const report = await scanner.scanTransactionXdr(body.target);
      return c.json({
        kind: "xdr",
        decoded,
        report,
      });
    } catch (err) {
      return c.json(
        {
          error:
            err instanceof Error
              ? err.message
              : "Target is neither a valid Stellar address nor a valid transaction XDR",
        },
        400,
      );
    }
  });

  return router;
}
