import type { VerifiedAssetEntry } from "./rules.js";

export interface FetchSep42Options {
  fetchFn?: typeof fetch | undefined;
  cacheTtlMs?: number | undefined;
}

interface RawSep42Asset {
  code?: unknown;
  issuer?: unknown;
  contract?: unknown;
}

interface RawSep42List {
  assets?: unknown;
}

const DEFAULT_CACHE_TTL_MS = 15 * 60 * 1000;
const sep42Cache = new Map<
  string,
  { expiresAt: number; assets: readonly VerifiedAssetEntry[] }
>();

/**
 * Fetches and deduplicates verified SEP-42 asset issuers from configured Asset List URLs.
 * Caches results in memory with a configurable TTL and gracefully skips unreachable lists.
 */
export async function fetchSep42VerifiedAssets(
  urls: readonly string[],
  options: FetchSep42Options = {},
): Promise<VerifiedAssetEntry[]> {
  const cleanUrls = Array.from(
    new Set(urls.map((u) => u.trim()).filter((u) => u.length > 0)),
  ).sort();

  if (cleanUrls.length === 0) {
    return [];
  }

  const cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
  const cacheKey = cleanUrls.join("|");
  const now = Date.now();
  const cached = sep42Cache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return [...cached.assets];
  }

  const fetchFn = options.fetchFn ?? fetch;
  const deduped = new Map<string, VerifiedAssetEntry>();

  await Promise.all(
    cleanUrls.map(async (url) => {
      try {
        const res = await fetchFn(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return;
        const json = (await res.json()) as RawSep42List;
        if (!Array.isArray(json.assets)) return;

        for (const item of json.assets) {
          if (!item || typeof item !== "object") continue;
          const raw = item as RawSep42Asset;
          if (typeof raw.code !== "string" || typeof raw.issuer !== "string") {
            continue;
          }
          const code = raw.code.trim().toUpperCase();
          const issuer = raw.issuer.trim();
          if (!code || !/^G[A-Z2-7]{55}$/.test(issuer)) {
            continue;
          }
          deduped.set(`${code}:${issuer}`, { code, issuer });
        }
      } catch {
        // Gracefully skip unreachable or malformed SEP-42 endpoints
      }
    }),
  );

  const assets = Array.from(deduped.values());
  if (assets.length > 0 && cacheTtlMs > 0) {
    sep42Cache.set(cacheKey, {
      expiresAt: now + cacheTtlMs,
      assets,
    });
  }
  return assets;
}

export function clearSep42AssetCache(): void {
  sep42Cache.clear();
}
