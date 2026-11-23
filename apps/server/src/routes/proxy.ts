import {
  buildSoroswapQuoteBody,
  createHorizonPathSwapAdapter,
  parseSoroswapQuoteOutput,
} from "@astrowallet/defi";
import {
  ClassicAddressSchema,
  StellarAddressSchema,
  type ClassicAddress,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  createSecurityShield,
  decodeTransactionEnvelope,
  extractBaseDestination,
  fetchSep42VerifiedAssets,
  type DirectoryTagEntry,
} from "@astrowallet/security-shield";
import {
  fetchMarketLiquidAssets,
  fetchMarketOrderbook,
  fetchMarketPriceHistory,
  fetchMarketRecentTrades,
  fetchMarketTokenDetails,
  fetchMarketTopHoldersAndPools,
  type MarketTimeframe,
} from "../market-horizon.js";
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
    const path = c.req.path;
    const isReadOnlyMeta =
      path.endsWith("/stellar-toml") ||
      path.endsWith("/nft-meta") ||
      path.includes("/market/");
    const limit = await checkRateLimit({
      repository: c.get("repo"),
      cache: c.env.CACHE,
      scope: isReadOnlyMeta ? "proxy_meta" : "proxy",
      clientKey: clientKeyFromHeaders(c.req.raw.headers),
      limitPerMin: isReadOnlyMeta
        ? Math.max(config.proxyRateLimitPerMin * 4, 240)
        : config.proxyRateLimitPerMin,
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

  function normalizeIpfsUrl(raw: string): string | undefined {
    const trimmed = raw.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("ipfs://")) {
      const cidPath = trimmed.slice(7).replace(/^ipfs\//i, "").replace(/^\/+/, "");
      return cidPath ? `https://ipfs.io/ipfs/${cidPath}` : undefined;
    }
    if (/^(Qm[1-9A-HJ-NP-Za-km-z]{44,}|bafy[a-z2-7]{20,})(?:\/.*)?$/i.test(trimmed)) {
      return `https://ipfs.io/ipfs/${trimmed}`;
    }
    if (trimmed.startsWith("https://")) {
      return trimmed;
    }
    return undefined;
  }

  function decodeBase64Utf8(b64: string): string {
    try {
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) {
        bytes[i] = bin.charCodeAt(i);
      }
      return new TextDecoder().decode(bytes).trim();
    } catch {
      return "";
    }
  }

  function extractCurrencyFromToml(
    tomlText: string,
    code: string,
    issuer: string,
  ): { name?: string; description?: string; image?: string } {
    const blocks = tomlText.split(/\[\[CURRENCIES\]\]/i).slice(1);
    const upperCode = code.toUpperCase();
    const matchField = (block: string, field: string): string | undefined => {
      const re = new RegExp(`^\\s*${field}\\s*=\\s*"([^"\\r\\n]*)"`, "mi");
      const m = re.exec(block);
      return m?.[1]?.trim() || undefined;
    };
    for (const block of blocks) {
      const bCode = matchField(block, "code")?.toUpperCase();
      const bIssuer = matchField(block, "issuer");
      if (bCode === upperCode && (!bIssuer || bIssuer === issuer)) {
        const fName = matchField(block, "name");
        const fDesc = matchField(block, "desc");
        const img = matchField(block, "image");
        const normalizedImg = img ? (normalizeIpfsUrl(img) ?? img) : undefined;
        return {
          ...(fName ? { name: fName } : {}),
          ...(fDesc ? { description: fDesc } : {}),
          ...(normalizedImg ? { image: normalizedImg } : {}),
        };
      }
    }
    return {};
  }

  router.get("/nft-meta", async (c) => {
    const config = c.get("config");
    const rawIssuer = (c.req.query("issuer") ?? "").trim();
    const code = (c.req.query("code") ?? "").trim();
    const issuerParse = ClassicAddressSchema.safeParse(rawIssuer);
    if (!issuerParse.success || !/^[A-Za-z0-9]{1,12}$/.test(code)) {
      return c.json({ error: "Valid Classic issuer and asset code are required" }, 400);
    }
    const issuer = issuerParse.data;

    return serveEdgeCachedJson(c, {
      cacheKey: `nft:${config.network}:${issuer}:${code}`,
      freshTtlSec: 86400,
      staleTtlSec: 604800,
      compute: async () => {
        let homeDomain: string | undefined;
        let ipfsHash: string | undefined;
        let name: string | undefined;
        let description: string | undefined;
        let image: string | undefined;

        for (const base of config.horizonUrls) {
          const cleanBase = base.replace(/\/+$/, "");
          try {
            const accRes = await fetchFn(`${cleanBase}/accounts/${encodeURIComponent(issuer)}`, {
              headers: { Accept: "application/json" },
              signal: AbortSignal.timeout(5000),
            });
            if (accRes.status === 404) break;
            if (!accRes.ok) continue;
            const acc = (await accRes.json()) as {
              home_domain?: string;
              data?: Record<string, string>;
            };
            homeDomain = acc.home_domain?.trim().toLowerCase() || undefined;
            const dataEntries = acc.data ?? {};
            const rawIpfsB64 =
              dataEntries.ipfshash ?? dataEntries.ipfs_hash ?? dataEntries.ipfs;
            if (typeof rawIpfsB64 === "string" && rawIpfsB64.length > 0) {
              const decoded = decodeBase64Utf8(rawIpfsB64);
              if (decoded && !decoded.includes("..")) {
                ipfsHash = decoded;
              }
            }
            break;
          } catch {
            continue;
          }
        }

        if (ipfsHash) {
          const cidClean = ipfsHash.replace(/^ipfs:\/\//i, "").replace(/^ipfs\//i, "").replace(/^\/+/, "");
          const gateways = [
            `https://ipfs.io/ipfs/${cidClean}`,
            `https://dweb.link/ipfs/${cidClean}`,
          ];
          for (const gwUrl of gateways) {
            try {
              const ipfsRes = await fetchFn(gwUrl, {
                headers: { Accept: "application/json, image/*, */*" },
                signal: AbortSignal.timeout(4000),
              });
              if (!ipfsRes.ok) continue;
              const contentType = (ipfsRes.headers.get("Content-Type") ?? "").toLowerCase();
              if (contentType.startsWith("image/")) {
                image = gwUrl;
                break;
              }
              const len = Number(ipfsRes.headers.get("Content-Length") ?? "0");
              if (Number.isFinite(len) && len > 65536) continue;
              const text = await ipfsRes.text();
              if (text.length > 65536) continue;
              const meta = JSON.parse(text) as {
                name?: unknown;
                description?: unknown;
                image?: unknown;
                url?: unknown;
              };
              if (typeof meta.name === "string" && meta.name.trim()) {
                name = meta.name.trim().slice(0, 120);
              }
              if (typeof meta.description === "string" && meta.description.trim()) {
                description = meta.description.trim().slice(0, 280);
              }
              const rawImg =
                typeof meta.image === "string"
                  ? meta.image
                  : typeof meta.url === "string"
                    ? meta.url
                    : "";
              if (rawImg) {
                image = normalizeIpfsUrl(rawImg);
              }
              break;
            } catch {
              continue;
            }
          }
        }

        if ((!image || !name) && homeDomain && isSafePublicDomain(homeDomain)) {
          const tomlRes = await fetchSafeStellarToml(homeDomain, c.env.CACHE);
          if (tomlRes.ok) {
            const parsed = extractCurrencyFromToml(tomlRes.text, code, issuer);
            name ??= parsed.name;
            description ??= parsed.description;
            image ??= parsed.image;
          }
        }

        return {
          code,
          issuer,
          ...(homeDomain ? { homeDomain } : {}),
          ...(ipfsHash ? { ipfsHash } : {}),
          ...(name ? { name } : {}),
          ...(description ? { description } : {}),
          ...(image ? { image } : {}),
          resolved: Boolean(image || name),
        };
      },
    });
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

    const resolveBareAsset = async (raw: string): Promise<string> => {
      const trimmed = raw.trim();
      const upper = trimmed.toUpperCase();
      if (!trimmed || upper === "XLM" || upper === "NATIVE" || trimmed.includes(":")) {
        return trimmed;
      }
      if (config.sep42AssetListUrls.length === 0) return trimmed;
      const verified = await fetchSep42VerifiedAssets(config.sep42AssetListUrls, {
        fetchFn,
      }).catch(() => []);
      const match = verified.find((v) => v.code.toUpperCase() === upper);
      return match ? `${match.code}:${match.issuer}` : trimmed;
    };

    const [fromAssetResolved, toAssetResolved] = await Promise.all([
      resolveBareAsset(reqBody.fromAsset),
      resolveBareAsset(reqBody.toAsset),
    ]);
    const resolvedReq = {
      ...reqBody,
      fromAsset: fromAssetResolved,
      toAsset: toAssetResolved,
    };

    if (config.soroswapApiBase && config.soroswapApiKey) {
      try {
        const cleanBase = config.soroswapApiBase.replace(/\/+$/, "");
        const quoteBody = buildSoroswapQuoteBody(resolvedReq, config.networkPassphrase);
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
            if (resolvedReq.sourceAddress) {
              const buildRes = await fetchFn(`${cleanBase}/quote/build?network=${config.network}`, {
                method: "POST",
                headers: authHeaders,
                body: JSON.stringify({ quote: data, from: resolvedReq.sourceAddress }),
                signal: AbortSignal.timeout(8000),
              }).catch(() => null);
              if (buildRes?.ok) {
                const built = (await buildRes.json()) as { xdr?: string };
                unsignedXdr = built.xdr;
              }
            }
            return c.json({
              provider: "soroswap",
              inputAmount: resolvedReq.amount,
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
      const quote = await horizonSwap.getQuote(resolvedReq);
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

  async function serveEdgeCachedJson<T>(
    c: {
      env: { CACHE?: KVNamespace };
      executionCtx?: { waitUntil(p: Promise<unknown>): void };
      header(name: string, value: string): void;
      json(data: unknown, status?: number): Response;
    },
    opts: {
      cacheKey: string;
      freshTtlSec: number;
      staleTtlSec: number;
      compute: () => Promise<T>;
    },
  ): Promise<Response> {
    const kvKey = `mkt:${opts.cacheKey}`;
    const edgeCache =
      typeof caches !== "undefined" && "default" in caches
        ? (caches as unknown as { default: Cache }).default
        : null;
    const edgeReq = edgeCache
      ? new Request(`https://cache.astrowallet.internal/${encodeURIComponent(kvKey)}`)
      : null;

    const persist = async (data: T): Promise<void> => {
      const payload = JSON.stringify({ data, cachedAt: Date.now() });
      const totalTtl = Math.max(60, opts.freshTtlSec + opts.staleTtlSec);
      if (c.env.CACHE) {
        await c.env.CACHE.put(kvKey, payload, { expirationTtl: totalTtl }).catch(() => {});
      }
      if (edgeCache && edgeReq) {
        const cacheResp = new Response(payload, {
          headers: {
            "Content-Type": "application/json",
            "Cache-Control": `public, max-age=${opts.freshTtlSec}, stale-while-revalidate=${opts.staleTtlSec}`,
          },
        });
        await edgeCache.put(edgeReq, cacheResp).catch(() => {});
      }
    };

    const scheduleBackground = (p: Promise<unknown>): boolean => {
      try {
        c.executionCtx?.waitUntil(p);
        return true;
      } catch {
        // Ignore in Node/Vitest environments without Workers executionCtx
        return false;
      }
    };

    if (edgeCache && edgeReq) {
      const hit = await edgeCache.match(edgeReq).catch(() => undefined);
      if (hit) {
        const parsed = (await hit.json().catch(() => null)) as {
          data?: T;
          cachedAt?: number;
        } | null;
        if (parsed && parsed.data !== undefined) {
          const ageSec = parsed.cachedAt ? (Date.now() - parsed.cachedAt) / 1000 : 0;
          const isStale = ageSec > opts.freshTtlSec;
          if (isStale) {
            scheduleBackground(opts.compute().then(persist).catch(() => {}));
          }
          c.header("X-Astro-Cache", isStale ? "EDGE-STALE" : "EDGE-HIT");
          c.header(
            "Cache-Control",
            `public, max-age=${opts.freshTtlSec}, stale-while-revalidate=${opts.staleTtlSec}`,
          );
          return c.json(parsed.data, 200);
        }
      }
    }

    if (c.env.CACHE) {
      const kvRaw = await c.env.CACHE.get(kvKey).catch(() => null);
      if (kvRaw) {
        try {
          const parsed = JSON.parse(kvRaw) as { data?: T; cachedAt?: number };
          if (parsed && parsed.data !== undefined) {
            const ageSec = parsed.cachedAt ? (Date.now() - parsed.cachedAt) / 1000 : 0;
            const isStale = ageSec > opts.freshTtlSec;
            if (isStale) {
              scheduleBackground(opts.compute().then(persist).catch(() => {}));
            } else if (edgeCache && edgeReq) {
              scheduleBackground(persist(parsed.data));
            }
            c.header("X-Astro-Cache", isStale ? "KV-STALE" : "KV-HIT");
            c.header(
              "Cache-Control",
              `public, max-age=${opts.freshTtlSec}, stale-while-revalidate=${opts.staleTtlSec}`,
            );
            return c.json(parsed.data, 200);
          }
        } catch {
          // Ignore corrupted KV cache entry
        }
      }
    }

    const fresh = await opts.compute();
    if (!scheduleBackground(persist(fresh))) {
      await persist(fresh);
    }
    c.header("X-Astro-Cache", "MISS");
    c.header(
      "Cache-Control",
      `public, max-age=${opts.freshTtlSec}, stale-while-revalidate=${opts.staleTtlSec}`,
    );
    return c.json(fresh, 200);
  }

  router.get("/market/history", async (c) => {
    const config = c.get("config");
    const code = (c.req.query("code") ?? "").trim().toUpperCase();
    const rawIssuer = (c.req.query("issuer") ?? "").trim();
    const rawTf = (c.req.query("timeframe") ?? "24h").trim().toLowerCase();
    const counterCode = (c.req.query("counterCode") ?? "").trim().toUpperCase();
    const rawCounterIssuer = (c.req.query("counterIssuer") ?? "").trim();

    if (!code || !/^[A-Z0-9]{1,12}$/.test(code)) {
      return c.json({ error: "Valid asset code is required" }, 400);
    }
    const issuerParse = rawIssuer ? ClassicAddressSchema.safeParse(rawIssuer) : null;
    if (issuerParse && !issuerParse.success) {
      return c.json({ error: "Invalid asset issuer address" }, 400);
    }
    const counterIssuerParse = rawCounterIssuer
      ? ClassicAddressSchema.safeParse(rawCounterIssuer)
      : null;
    if (counterIssuerParse && !counterIssuerParse.success) {
      return c.json({ error: "Invalid counter asset issuer address" }, 400);
    }

    const timeframe: MarketTimeframe =
      rawTf === "7d" || rawTf === "30d" || rawTf === "1y" || rawTf === "all" ? rawTf : "24h";
    const freshTtlSec = timeframe === "24h" ? 90 : timeframe === "7d" ? 300 : 1800;
    const staleTtlSec = 86_400;

    return serveEdgeCachedJson(c, {
      cacheKey: `hist3:${config.network}:${code}:${rawIssuer || "native"}:${timeframe}:${counterCode || "XLM"}:${rawCounterIssuer || "native"}`,
      freshTtlSec,
      staleTtlSec,
      compute: () =>
        fetchMarketPriceHistory({
          horizonUrls: config.horizonUrls,
          assetCode: code,
          assetIssuer: issuerParse?.data as ClassicAddress | undefined,
          timeframe,
          ...(counterCode
            ? {
                counterAsset: {
                  code: counterCode,
                  issuer: counterIssuerParse?.data as ClassicAddress | undefined,
                },
              }
            : {}),
          nowMs: Date.now(),
          fetchFn,
        }),
    });
  });

  router.get("/market/token", async (c) => {
    const config = c.get("config");
    const code = (c.req.query("code") ?? "").trim().toUpperCase();
    const rawIssuer = (c.req.query("issuer") ?? "").trim();
    const counterCode = (c.req.query("counterCode") ?? "").trim().toUpperCase();
    const rawCounterIssuer = (c.req.query("counterIssuer") ?? "").trim();

    if (!code || !/^[A-Z0-9]{1,12}$/.test(code)) {
      return c.json({ error: "Valid asset code is required" }, 400);
    }
    const issuerParse = rawIssuer ? ClassicAddressSchema.safeParse(rawIssuer) : null;
    if (issuerParse && !issuerParse.success) {
      return c.json({ error: "Invalid asset issuer address" }, 400);
    }
    const counterIssuerParse = rawCounterIssuer
      ? ClassicAddressSchema.safeParse(rawCounterIssuer)
      : null;
    if (counterIssuerParse && !counterIssuerParse.success) {
      return c.json({ error: "Invalid counter asset issuer address" }, 400);
    }

    const counterAsset = counterCode
      ? {
          code: counterCode,
          issuer: counterIssuerParse?.data as ClassicAddress | undefined,
        }
      : undefined;

    return serveEdgeCachedJson(c, {
      cacheKey: `tok:${config.network}:${code}:${rawIssuer || "native"}:${counterCode || "XLM"}:${rawCounterIssuer || "native"}`,
      freshTtlSec: 30,
      staleTtlSec: 300,
      compute: async () => {
        const [details, orderbook, recentTrades] = await Promise.all([
          fetchMarketTokenDetails({
            horizonUrls: config.horizonUrls,
            networkPassphrase: config.networkPassphrase,
            assetCode: code,
            assetIssuer: issuerParse?.data as ClassicAddress | undefined,
            fetchFn,
          }),
          fetchMarketOrderbook({
            horizonUrls: config.horizonUrls,
            assetCode: code,
            assetIssuer: issuerParse?.data as ClassicAddress | undefined,
            counterAsset,
            limit: 5,
            fetchFn,
          }).catch(() => null),
          fetchMarketRecentTrades({
            horizonUrls: config.horizonUrls,
            assetCode: code,
            assetIssuer: issuerParse?.data as ClassicAddress | undefined,
            counterAsset,
            limit: 15,
            fetchFn,
          }).catch(() => []),
        ]);
        const { holders, liquidityPools } = await fetchMarketTopHoldersAndPools({
          horizonUrls: config.horizonUrls,
          assetCode: code,
          assetIssuer: issuerParse?.data as ClassicAddress | undefined,
          supplyAmount: details?.supplyAmount,
          fetchFn,
        }).catch(() => ({ holders: [], liquidityPools: [] }));
        return { details, orderbook, recentTrades, holders, liquidityPools };
      },
    });
  });

  router.get("/market/liquid", async (c) => {
    const config = c.get("config");
    const rawLimit = Number(c.req.query("limit") ?? "15");
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(Math.trunc(rawLimit), 1), 30)
      : 15;

    return serveEdgeCachedJson(c, {
      cacheKey: `liq:${config.network}:${limit}`,
      freshTtlSec: 300,
      staleTtlSec: 1800,
      compute: async () => {
        const items = await fetchMarketLiquidAssets({
          horizonUrls: config.horizonUrls,
          limit,
          fetchFn,
        });
        return { items };
      },
    });
  });

  async function resolveSep24AnchorEndpoints(
    domain: string,
    cache?: KVNamespace,
  ): Promise<{ webAuthEndpoint: string; transferServerSep24: string }> {
    const cleanDomain = domain.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/+$/, "");
    if (!isSafePublicDomain(cleanDomain)) {
      throw new Error("Invalid or unsafe anchor domain");
    }
    const cacheKey = `sep24_meta:${cleanDomain}`;
    if (cache) {
      const hit = await cache.get(cacheKey);
      if (hit) {
        try {
          const parsed = JSON.parse(hit) as { webAuthEndpoint?: string; transferServerSep24?: string };
          if (parsed.webAuthEndpoint && parsed.transferServerSep24) {
            return {
              webAuthEndpoint: parsed.webAuthEndpoint,
              transferServerSep24: parsed.transferServerSep24,
            };
          }
        } catch {
          // ignore cache parse error
        }
      }
    }

    const res = await fetchFn(`https://${cleanDomain}/.well-known/stellar.toml`, {
      headers: { Accept: "text/plain" },
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      throw new Error(`Failed to fetch stellar.toml from ${cleanDomain} (${res.status})`);
    }
    const toml = (await res.text()).slice(0, STELLAR_TOML_MAX_BYTES);
    const webAuthMatch = toml.match(/^\s*WEB_AUTH_ENDPOINT\s*=\s*"([^"]+)"/m);
    const sep24Match = toml.match(/^\s*TRANSFER_SERVER_SEP0024\s*=\s*"([^"]+)"/m);
    const webAuthEndpoint = webAuthMatch?.[1]?.trim() ?? "";
    const transferServerSep24 = sep24Match?.[1]?.trim() ?? "";
    if (!webAuthEndpoint.startsWith("https://") || !transferServerSep24.startsWith("https://")) {
      throw new Error(`Anchor ${cleanDomain} missing HTTPS WEB_AUTH_ENDPOINT or TRANSFER_SERVER_SEP0024`);
    }
    const webAuthHost = new URL(webAuthEndpoint).hostname.toLowerCase();
    const sep24Host = new URL(transferServerSep24).hostname.toLowerCase();
    if (!isSafePublicDomain(webAuthHost) || !isSafePublicDomain(sep24Host)) {
      throw new Error("Anchor endpoint hostname failed SSRF check");
    }

    const result = {
      webAuthEndpoint: webAuthEndpoint.replace(/\/+$/, ""),
      transferServerSep24: transferServerSep24.replace(/\/+$/, ""),
    };
    if (cache) {
      await cache.put(cacheKey, JSON.stringify(result), { expirationTtl: 600 });
    }
    return result;
  }

  router.get("/sep10/challenge", async (c) => {
    const domain = c.req.query("domain") ?? "";
    const account = c.req.query("account") ?? "";
    const parsedAcct = ClassicAddressSchema.safeParse(account.trim());
    if (!parsedAcct.success) {
      return c.json({ error: "Valid Classic G... account is required" }, 400);
    }
    try {
      const endpoints = await resolveSep24AnchorEndpoints(domain, c.env.CACHE);
      const res = await fetchFn(
        `${endpoints.webAuthEndpoint}?account=${encodeURIComponent(parsedAcct.data)}`,
        { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) },
      );
      const body = (await res.json()) as { transaction?: string; network_passphrase?: string; error?: string };
      if (!res.ok || !body.transaction) {
        return c.json({ error: body.error ?? `SEP-10 challenge failed (${res.status})` }, 502);
      }
      return c.json({
        transaction: body.transaction,
        network_passphrase: body.network_passphrase,
        webAuthEndpoint: endpoints.webAuthEndpoint,
        transferServerSep24: endpoints.transferServerSep24,
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "SEP-10 challenge error" }, 400);
    }
  });

  router.post("/sep10/token", async (c) => {
    let body: { domain?: string; transaction?: string };
    try {
      body = (await c.req.json()) as { domain?: string; transaction?: string };
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.domain || !body.transaction) {
      return c.json({ error: "domain and signed transaction XDR are required" }, 400);
    }
    try {
      const endpoints = await resolveSep24AnchorEndpoints(body.domain, c.env.CACHE);
      const res = await fetchFn(endpoints.webAuthEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ transaction: body.transaction }),
        signal: AbortSignal.timeout(8000),
      });
      const json = (await res.json()) as { token?: string; error?: string };
      if (!res.ok || !json.token) {
        return c.json({ error: json.error ?? `SEP-10 token exchange failed (${res.status})` }, 401);
      }
      return c.json({ token: json.token });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "SEP-10 token error" }, 400);
    }
  });

  router.post("/sep24/interactive", async (c) => {
    let body: {
      domain?: string;
      direction?: "deposit" | "withdraw";
      token?: string;
      assetCode?: string;
      amount?: string;
      account?: string;
    };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    if (!body.domain || !body.token || !body.assetCode || !body.direction) {
      return c.json({ error: "domain, direction, token, and assetCode are required" }, 400);
    }
    const action = body.direction === "withdraw" ? "withdraw" : "deposit";
    try {
      const endpoints = await resolveSep24AnchorEndpoints(body.domain, c.env.CACHE);
      const res = await fetchFn(
        `${endpoints.transferServerSep24}/transactions/${action}/interactive`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
            Authorization: `Bearer ${body.token}`,
          },
          body: JSON.stringify({
            asset_code: body.assetCode.trim().toUpperCase(),
            ...(body.amount ? { amount: body.amount.trim() } : {}),
            ...(body.account ? { account: body.account.trim() } : {}),
          }),
          signal: AbortSignal.timeout(10000),
        },
      );
      const json = (await res.json()) as { url?: string; id?: string; type?: string; error?: string };
      if (!res.ok || !json.url) {
        return c.json(
          { error: json.error ?? `SEP-24 interactive session rejected (${res.status})` },
          res.status >= 400 && res.status < 500 ? (res.status as 400) : 502,
        );
      }
      return c.json({ url: json.url, id: json.id, type: json.type });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : "SEP-24 interactive error" }, 400);
    }
  });

  return router;
}
