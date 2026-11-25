import type { ClassicAddress, StellarNetwork } from "@astrowallet/domain";
import {
  discoverLiquidHorizonAssets,
  fetchTokenOnChainDetails,
  fetchTokenOrderbookAgainstXlm,
  fetchTokenPriceHistoryAgainstXlm,
  fetchTokenRecentTrades,
  type StellarTokenDetails,
  type TokenCatalogItem,
  type TokenOrderbookSnapshot,
  type TokenPriceHistoryResult,
  type TokenPriceTimeframe,
  type TokenRecentTradeRecord,
} from "@astrowallet/stellar-core";
import { tgDeviceStorageGet, tgDeviceStorageSet } from "../telegram/webapp.js";

interface StoredCacheEnvelope<T> {
  v: 1;
  savedAt: number;
  freshUntil: number;
  data: T;
}

const CACHE_PREFIX = "aw_swr_v3:";
const MAX_DEVICE_CACHE_BYTES = 64 * 1024;
const memoryCache = new Map<string, StoredCacheEnvelope<unknown>>();
const inflightRequests = new Map<string, Promise<unknown>>();

export async function readCachedEntry<T>(
  key: string,
  maxStaleMs: number,
): Promise<{ data: T; fresh: boolean } | null> {
  const fullKey = `${CACHE_PREFIX}${key}`;
  const now = Date.now();
  const mem = memoryCache.get(fullKey) as StoredCacheEnvelope<T> | undefined;
  if (mem && now - mem.savedAt <= maxStaleMs) {
    return { data: mem.data, fresh: now <= mem.freshUntil };
  }

  const raw = await tgDeviceStorageGet(fullKey).catch(() => null);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as StoredCacheEnvelope<T>;
    if (
      parsed &&
      parsed.v === 1 &&
      typeof parsed.savedAt === "number" &&
      typeof parsed.freshUntil === "number" &&
      now - parsed.savedAt <= maxStaleMs
    ) {
      memoryCache.set(fullKey, parsed as StoredCacheEnvelope<unknown>);
      return { data: parsed.data, fresh: now <= parsed.freshUntil };
    }
  } catch {
    // Ignore malformed cache item
  }
  return null;
}

export function writeCachedEntry<T>(key: string, data: T, freshMs: number): void {
  const fullKey = `${CACHE_PREFIX}${key}`;
  const now = Date.now();
  const env: StoredCacheEnvelope<T> = {
    v: 1,
    savedAt: now,
    freshUntil: now + freshMs,
    data,
  };
  memoryCache.set(fullKey, env as StoredCacheEnvelope<unknown>);
  try {
    const serialized = JSON.stringify(env);
    if (serialized.length <= MAX_DEVICE_CACHE_BYTES) {
      void tgDeviceStorageSet(fullKey, serialized).catch(() => undefined);
    }
  } catch {
    // Ignore serialization errors
  }
}

export function dedupedFetch<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const existing = inflightRequests.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const promise = fetcher().finally(() => {
    inflightRequests.delete(key);
  });
  inflightRequests.set(key, promise);
  return promise;
}

export interface TokenHolderEntry {
  address: string;
  balance: string;
  sharePct: number | null;
}

export interface TokenLiquidityPoolEntry {
  id: string;
  totalTrustlines: number;
  totalShares: string;
  reserves: Array<{ asset: string; amount: string }>;
}

export interface TokenBundleResult {
  details: StellarTokenDetails;
  orderbook: TokenOrderbookSnapshot | null;
  recentTrades: TokenRecentTradeRecord[];
  holders?: TokenHolderEntry[] | undefined;
  liquidityPools?: TokenLiquidityPoolEntry[] | undefined;
}

export async function fetchCachedMarketHistory(input: {
  apiBaseUrl?: string | undefined;
  network: StellarNetwork;
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  timeframe: TokenPriceTimeframe;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
}): Promise<TokenPriceHistoryResult> {
  const cacheKey = `hist:${input.network}:${input.assetCode}:${input.assetIssuer ?? "native"}:${input.timeframe}:${input.counterAsset?.code ?? "XLM"}`;
  const freshMs =
    input.timeframe === "24h" ? 60_000 : input.timeframe === "7d" ? 300_000 : 900_000;

  return dedupedFetch(cacheKey, async () => {
    if (input.apiBaseUrl) {
      try {
        const params = new URLSearchParams({
          code: input.assetCode,
          timeframe: input.timeframe,
        });
        if (input.assetIssuer) params.set("issuer", input.assetIssuer);
        if (input.counterAsset) {
          params.set("counterCode", input.counterAsset.code);
          if (input.counterAsset.issuer) params.set("counterIssuer", input.counterAsset.issuer);
        }
        const base = input.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/market/history?${params.toString()}`, {
          headers: { "X-Astro-Network": input.network },
        });
        if (res.ok) {
          const data = (await res.json()) as TokenPriceHistoryResult;
          writeCachedEntry(cacheKey, data, freshMs);
          return data;
        }
      } catch {
        // Fall through to direct Horizon failover
      }
    }

    const direct = await fetchTokenPriceHistoryAgainstXlm({
      horizonUrls: input.horizonUrls,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      timeframe: input.timeframe,
      counterAsset: input.counterAsset,
    });
    writeCachedEntry(cacheKey, direct, freshMs);
    return direct;
  });
}

export async function fetchCachedTokenBundle(input: {
  apiBaseUrl?: string | undefined;
  network: StellarNetwork;
  horizonUrls: readonly string[];
  networkPassphrase: string;
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
}): Promise<TokenBundleResult> {
  const cacheKey = `token:${input.network}:${input.assetCode}:${input.assetIssuer ?? "native"}:${input.counterAsset?.code ?? "XLM"}`;
  const freshMs = 30_000;

  return dedupedFetch(cacheKey, async () => {
    if (input.apiBaseUrl) {
      try {
        const params = new URLSearchParams({ code: input.assetCode });
        if (input.assetIssuer) params.set("issuer", input.assetIssuer);
        if (input.counterAsset) {
          params.set("counterCode", input.counterAsset.code);
          if (input.counterAsset.issuer) params.set("counterIssuer", input.counterAsset.issuer);
        }
        const base = input.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/market/token?${params.toString()}`, {
          headers: { "X-Astro-Network": input.network },
        });
        if (res.ok) {
          const data = (await res.json()) as TokenBundleResult;
          writeCachedEntry(cacheKey, data, freshMs);
          return data;
        }
      } catch {
        // Fall through to direct Horizon failover
      }
    }

    const [details, orderbook, recentTrades] = await Promise.all([
      fetchTokenOnChainDetails({
        horizonUrls: input.horizonUrls,
        networkPassphrase: input.networkPassphrase,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        apiBaseUrl: input.apiBaseUrl,
        network: input.network,
      }),
      fetchTokenOrderbookAgainstXlm({
        horizonUrls: input.horizonUrls,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        counterAsset: input.counterAsset,
        limit: 5,
      }).catch(() => null),
      fetchTokenRecentTrades({
        horizonUrls: input.horizonUrls,
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        counterAsset: input.counterAsset,
        limit: 15,
      }).catch(() => []),
    ]);
    const bundle: TokenBundleResult = { details, orderbook, recentTrades };
    writeCachedEntry(cacheKey, bundle, freshMs);
    return bundle;
  });
}

export async function fetchCachedLiquidAssets(input: {
  apiBaseUrl?: string | undefined;
  network: StellarNetwork;
  horizonUrls: readonly string[];
  limit?: number | undefined;
}): Promise<TokenCatalogItem[]> {
  const limit = input.limit ?? 15;
  const cacheKey = `liquid:${input.network}:${limit}`;
  const freshMs = 300_000;

  return dedupedFetch(cacheKey, async () => {
    if (input.apiBaseUrl) {
      try {
        const base = input.apiBaseUrl.replace(/\/+$/, "");
        const res = await fetch(`${base}/v1/proxy/market/liquid?limit=${limit}`, {
          headers: { "X-Astro-Network": input.network },
        });
        if (res.ok) {
          const body = (await res.json()) as { items?: TokenCatalogItem[] };
          if (Array.isArray(body.items)) {
            writeCachedEntry(cacheKey, body.items, freshMs);
            return body.items;
          }
        }
      } catch {
        // Fall through to direct Horizon failover
      }
    }

    const items = await discoverLiquidHorizonAssets({
      horizonUrls: input.horizonUrls,
      limit,
      apiBaseUrl: input.apiBaseUrl,
      network: input.network,
    });
    writeCachedEntry(cacheKey, items, freshMs);
    return items;
  });
}
