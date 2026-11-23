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

  async function fetchSafeStellarToml(
    domain: string,
    cache: KVNamespace | undefined,
  ): Promise<{ ok: true; text: string } | { ok: false; status: 400 | 413 | 502; error: string }> {
    if (!isSafePublicDomain(domain)) {
      return { ok: false, status: 400, error: "Invalid public issuer domain" };
    }

    const cacheKey = `toml:${domain}`;
    if (cache) {
      const cached = await cache.get(cacheKey);
      if (cached) {
        return { ok: true, text: cached };
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
            return { ok: false, status: 502, error: "Unsafe stellar.toml redirect blocked" };
          }
          currentUrl = nextUrl.toString();
          continue;
        }
        res = candidate;
        break;
      }
    } catch {
      return { ok: false, status: 502, error: `Unable to fetch stellar.toml from ${domain}` };
    }
    if (!res || !res.ok) {
      return { ok: false, status: 502, error: `Unable to fetch stellar.toml from ${domain}` };
    }

    const declaredLength = Number(res.headers.get("Content-Length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > STELLAR_TOML_MAX_BYTES) {
      return { ok: false, status: 413, error: "stellar.toml exceeds the 128 KB limit" };
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
          return { ok: false, status: 413, error: "stellar.toml exceeds the 128 KB limit" };
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
        return { ok: false, status: 413, error: "stellar.toml exceeds the 128 KB limit" };
      }
    }
    if (cache) {
      await cache.put(cacheKey, text, { expirationTtl: 900 });
    }
    return { ok: true, text };
  }

  router.get("/stellar-toml", async (c) => {
    const domain = (c.req.query("domain") ?? "").trim().toLowerCase();
    const tomlRes = await fetchSafeStellarToml(domain, c.env.CACHE);
    if (!tomlRes.ok) {
      return c.json({ error: tomlRes.error }, tomlRes.status);
    }
    return c.text(tomlRes.text, 200);
  });

  router.get("/federation", async (c) => {
    const q = (c.req.query("q") ?? "").trim();
    const match = /^([^*\s]{1,64})\*([a-z0-9.-]+)$/i.exec(q);
    if (!match?.[1] || !match[2]) {
      return c.json({ error: "Expected SEP-0002 address in user*domain format" }, 400);
    }
    const domain = match[2].toLowerCase();
    const tomlRes = await fetchSafeStellarToml(domain, c.env.CACHE);
    if (!tomlRes.ok) {
      return c.json({ error: tomlRes.error }, tomlRes.status);
    }
    const fedMatch = /^\s*FEDERATION_SERVER\s*=\s*"([^"]+)"/m.exec(tomlRes.text);
    if (!fedMatch?.[1]) {
      return c.json({ error: `No FEDERATION_SERVER found in ${domain}/stellar.toml` }, 404);
    }
    let fedUrl: URL;
    try {
      fedUrl = new URL(fedMatch[1].trim());
    } catch {
      return c.json({ error: "Invalid FEDERATION_SERVER URL" }, 502);
    }
    if (fedUrl.protocol !== "https:" || !isSafePublicDomain(fedUrl.hostname.toLowerCase())) {
      return c.json({ error: "Unsafe FEDERATION_SERVER URL blocked" }, 502);
    }
    fedUrl.searchParams.set("q", q);
    fedUrl.searchParams.set("type", "name");

    try {
      const res = await fetchFn(fedUrl.toString(), {
        headers: { Accept: "application/json" },
        redirect: "manual",
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) {
        return c.json({ error: `Federation lookup failed (${res.status})` }, 502);
      }
      const data = (await res.json()) as {
        account_id?: string;
        memo_type?: string;
        memo?: string | number;
      };
      const parsedAddr = StellarAddressSchema.safeParse(data.account_id);
      if (!parsedAddr.success) {
        return c.json({ error: "Federation server returned invalid Stellar address" }, 502);
      }
      return c.json({
        accountId: parsedAddr.data,
        ...(typeof data.memo_type === "string" && data.memo_type
          ? { memoType: data.memo_type }
          : {}),
        ...(data.memo !== undefined && data.memo !== null ? { memo: String(data.memo) } : {}),
      });
    } catch {
      return c.json({ error: `Unable to reach federation server for ${domain}` }, 502);
    }
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
