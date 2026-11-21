import type { VerifiedAssetEntry } from "./rules.js";

export interface FetchSep42Options {
  fetchFn?: typeof fetch | undefined;
  cacheTtlMs?: number | undefined;
}

interface RawSep42Asset {
  code?: unknown;
  issuer?: unknown;
  contract?: unknown;
  name?: unknown;
  org?: unknown;
  domain?: unknown;
  icon?: unknown;
  decimals?: unknown;
}

interface RawSep42List {
  assets?: unknown;
}

function cleanOptionalString(val: unknown): string | undefined {
  if (typeof val !== "string") return undefined;
  const trimmed = val.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function cleanOptionalHttpsIcon(val: unknown): string | undefined {
  const raw = cleanOptionalString(val);
  if (!raw || !raw.startsWith("https://")) return undefined;
  return raw;
}

function cleanOptionalDecimals(val: unknown): number | undefined {
  if (typeof val !== "number" || !Number.isInteger(val) || val < 0 || val > 18) {
    return undefined;
  }
  return val;
}

function cleanOptionalContract(val: unknown): string | undefined {
  const raw = cleanOptionalString(val);
  if (!raw || !/^C[A-Z2-7]{55}$/.test(raw)) return undefined;
  return raw;
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

  const listBatches = await Promise.all(
    cleanUrls.map(async (url): Promise<VerifiedAssetEntry[]> => {
      const batch: VerifiedAssetEntry[] = [];
      try {
        const res = await fetchFn(url, {
          headers: { Accept: "application/json" },
        });
        if (!res.ok) return batch;
        const json = (await res.json()) as RawSep42List;
        if (!Array.isArray(json.assets)) return batch;

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
          const name = cleanOptionalString(raw.name) ?? cleanOptionalString(raw.org);
          const domain = cleanOptionalString(raw.domain);
          const icon = cleanOptionalHttpsIcon(raw.icon);
          const decimals = cleanOptionalDecimals(raw.decimals);
          const contract = cleanOptionalContract(raw.contract);

          batch.push({
            code,
            issuer,
            ...(name ? { name } : {}),
            ...(domain ? { domain } : {}),
            ...(icon ? { icon } : {}),
            ...(decimals !== undefined ? { decimals } : {}),
            ...(contract ? { contract } : {}),
          });
        }
      } catch {
        // Gracefully skip unreachable or malformed SEP-42 endpoints
      }
      return batch;
    }),
  );

  for (const batch of listBatches) {
    for (const entry of batch) {
      const key = `${entry.code}:${entry.issuer}`;
      const existing = deduped.get(key);
      if (!existing) {
        deduped.set(key, entry);
      } else {
        deduped.set(key, {
          code: existing.code,
          issuer: existing.issuer,
          ...(existing.name || entry.name ? { name: existing.name ?? entry.name } : {}),
          ...(existing.domain || entry.domain ? { domain: existing.domain ?? entry.domain } : {}),
          ...(existing.icon || entry.icon ? { icon: existing.icon ?? entry.icon } : {}),
          ...(existing.decimals !== undefined || entry.decimals !== undefined
            ? { decimals: existing.decimals ?? entry.decimals }
            : {}),
          ...(existing.contract || entry.contract
            ? { contract: existing.contract ?? entry.contract }
            : {}),
        });
      }
    }
  }

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
