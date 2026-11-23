import {
  buildSoroswapQuoteBody,
  createHorizonPathSwapAdapter,
  parseSoroswapQuoteOutput,
} from "@astrowallet/defi";
import {
  StellarAddressSchema,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  createSecurityShield,
  decodeTransactionEnvelope,
  extractBaseDestination,
  type DirectoryTagEntry,
} from "@astrowallet/security-shield";
import type { KVNamespace } from "@cloudflare/workers-types";
import { Hono } from "hono";
import { z } from "zod";
import type { ServerRepository } from "../db/repository.js";
import { checkRateLimit, clientKeyFromHeaders } from "../rate-limit.js";
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
    repo?: ServerRepository;
  };
};

const SwapQuoteBodySchema = z.object({
  fromAsset: z.string().min(1).max(80),
  toAsset: z.string().min(1).max(80),
  amount: z.string().regex(/^\d+(\.\d{1,7})?$/),
  slippageBps: z.number().int().min(1).max(5000).default(50),
  sourceAddress: z
    .string()
    .regex(/^G[A-Z2-7]{55}$/)
    .optional(),
});

const ScanBodySchema = z.object({
  target: z.string().trim().min(10),
});

const SAFE_PUBLIC_DOMAIN_REGEX =
  /^(?!-)[a-z0-9-]{1,63}(?<!-)(?:\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const BLOCKED_DOMAIN_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".arpa",
  ".home",
  ".lan",
  ".corp",
  ".test",
  ".invalid",
];
const STELLAR_TOML_MAX_BYTES = 128 * 1024;

export function isSafePublicDomain(domain: string): boolean {
  if (!SAFE_PUBLIC_DOMAIN_REGEX.test(domain)) return false;
  if (domain === "localhost") return false;
  if (BLOCKED_DOMAIN_SUFFIXES.some((suffix) => domain.endsWith(suffix))) return false;
  const labels = domain.split(".");
  const tld = labels[labels.length - 1] ?? "";
  // Reject IPv4 literals and all-numeric TLDs
  if (/^\d+$/.test(tld)) return false;
  return true;
}

export async function lookupDirectoryTag(
  config: ServerConfig,
  cache: KVNamespace | undefined,
  address: string,
  fetchFn: FetchLike = fetch,
): Promise<DirectoryTagEntry | null> {
  const baseAddress = extractBaseDestination(address);
  const cacheKey = `dir:${config.network}:${baseAddress}`;
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
    `${base}/explorer/${netSlug}/directory/${encodeURIComponent(baseAddress)}`,
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
    address: raw.address ?? baseAddress,
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
  const baseAddress = extractBaseDestination(address);
  if (!baseAddress.startsWith("G")) return false;
  for (const base of config.horizonUrls) {
    const cleanBase = base.replace(/\/+$/, "");
    try {
      const res = await fetchFn(
        `${cleanBase}/accounts/${encodeURIComponent(baseAddress)}`,
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

export async function runScanTarget(params: {
  config: ServerConfig;
  cache?: KVNamespace | undefined;
  target: string;
  fetchFn?: FetchLike | undefined;
}): Promise<
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: 400; error: string }
> {
  const fetchFn = params.fetchFn ?? fetch;
  const shield = createSecurityShield({
    networkPassphrase: params.config.networkPassphrase,
    rpcUrls: params.config.rpcUrls,
    horizonUrls: params.config.horizonUrls,
    stellarExpertApiBase: params.config.stellarExpertApiBase,
    sep42AssetListUrls: params.config.sep42AssetListUrls,
    fetchFn,
    directoryLookup: (addr) =>
      lookupDirectoryTag(params.config, params.cache, addr, fetchFn),
    memoRequiredLookup: (addr) =>
      lookupSep29MemoRequired(params.config, addr, fetchFn),
  });

  const scanner = shield.createScanner();
  const addrParse = StellarAddressSchema.safeParse(params.target);
  if (addrParse.success) {
    const report = await scanner.scanAddress(addrParse.data);
    return {
      ok: true,
      body: {
        kind: "address",
        target: addrParse.data,
        report,
      },
    };
  }

  try {
    const decoded = decodeTransactionEnvelope(
      params.target,
      params.config.networkPassphrase,
    );
    const report = await scanner.scanTransactionXdr(params.target);
    return {
      ok: true,
      body: {
        kind: "xdr",
        decoded,
        report,
      },
    };
  } catch (err) {
    return {
      ok: false,
      status: 400,
      error:
        err instanceof Error
          ? err.message
          : "Target is neither a valid Stellar address nor a valid transaction XDR",
    };
  }
}

export function createProxyRoutes(deps: ProxyRoutesDeps = {}): Hono<ProxyRouteEnv> {
  const router = new Hono<ProxyRouteEnv>();
  const fetchFn = deps.fetchFn ?? fetch;

  router.use("*", async (c, next) => {
    const config = c.get("config");
    const limit = await checkRateLimit({
      repository: c.get("repo"),
      cache: c.env.CACHE,
      scope: "proxy",
      clientKey: clientKeyFromHeaders(c.req.raw.headers),
      limitPerMin: config.proxyRateLimitPerMin,
    });
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return c.json({ error: "Proxy rate limit exceeded" }, 429);
    }
    await next();
    return undefined;
  });

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
    if (!isSafePublicDomain(domain)) {
      return c.json({ error: "Invalid public issuer domain" }, 400);
    }

    const cacheKey = `toml:${domain}`;
    if (c.env.CACHE) {
      const cached = await c.env.CACHE.get(cacheKey);
      if (cached) {
        return c.text(cached, 200);
      }
    }

    let res: Response | null = null;
    let currentUrl = `https://${domain}/.well-known/stellar.toml`;
    try {
      for (let hop = 0; hop < 3; hop += 1) {
        const candidate = await fetchFn(currentUrl, {
          headers: {
            Accept: "text/plain, */*",
            "User-Agent": "AstroWallet-SEP1-Scanner/1.0",
          },
          redirect: "manual",
          signal: AbortSignal.timeout(5000),
        });
        if (candidate.status >= 300 && candidate.status < 400) {
          const location = candidate.headers.get("Location");
          if (!location) break;
          const nextUrl = new URL(location, currentUrl);
          if (
            nextUrl.protocol !== "https:" ||
            !isSafePublicDomain(nextUrl.hostname.toLowerCase())
          ) {
            return c.json({ error: "Unsafe stellar.toml redirect blocked" }, 502);
          }
          currentUrl = nextUrl.toString();
          continue;
        }
        res = candidate;
        break;
      }
    } catch {
      return c.json({ error: `Unable to fetch stellar.toml from ${domain}` }, 502);
    }
    if (!res || !res.ok) {
      return c.json({ error: `Unable to fetch stellar.toml from ${domain}` }, 502);
    }

    const declaredLength = Number(res.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > STELLAR_TOML_MAX_BYTES) {
      return c.json({ error: "stellar.toml exceeds the 128 KB limit" }, 413);
    }

    let text: string;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        totalBytes += value.byteLength;
        if (totalBytes > STELLAR_TOML_MAX_BYTES) {
          await reader.cancel().catch(() => {});
          return c.json({ error: "stellar.toml exceeds the 128 KB limit" }, 413);
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(merged);
    } else {
      text = await res.text();
      if (new TextEncoder().encode(text).length > STELLAR_TOML_MAX_BYTES) {
        return c.json({ error: "stellar.toml exceeds the 128 KB limit" }, 413);
      }
    }
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
        const quoteBody = buildSoroswapQuoteBody(reqBody, config.networkPassphrase);
        const authHeaders = {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.soroswapApiKey}`,
        };
        const res = await fetchFn(`${cleanBase}/quote?network=${config.network}`, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(quoteBody),
          signal: AbortSignal.timeout(8000),
        });
        if (res.ok) {
          const data = (await res.json()) as {
            amountOut?: string | number;
            expectedOutputAmount?: string;
            priceImpactPct?: string;
          };
          const out = parseSoroswapQuoteOutput(data);
          if (out) {
            let unsignedXdr: string | undefined;
            if (reqBody.sourceAddress) {
              const buildRes = await fetchFn(`${cleanBase}/quote/build?network=${config.network}`, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({ quote: data, from: reqBody.sourceAddress }),
                signal: AbortSignal.timeout(8000),
              }).catch(() => null);
              if (buildRes?.ok) {
                const built = (await buildRes.json()) as { xdr?: string };
                unsignedXdr = built.xdr;
              }
            }
            return c.json({
              provider: "soroswap",
              inputAmount: reqBody.amount,
              expectedOutputAmount: out,
              priceImpactPct: data.priceImpactPct ?? "N/A",
              unsignedXdr,
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

    const result = await runScanTarget({
      config,
      cache: c.env.CACHE,
      target: body.target,
      fetchFn,
    });
    if (!result.ok) {
      return c.json({ error: result.error }, result.status);
    }
    return c.json(result.body);
  });

  return router;
}
