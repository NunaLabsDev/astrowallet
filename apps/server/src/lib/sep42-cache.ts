import type { ServerConfig } from "@astrowallet/domain";
import { fetchSep42VerifiedAssets, type VerifiedAssetEntry } from "@astrowallet/security-shield";
import type { KVNamespace } from "@cloudflare/workers-types";
import type { FetchLike } from "../stellar-verifier.js";

/**
 * Loads SEP-42 verified assets with a 10-minute Cloudflare KV cache shared across webhook, polling, and indexer paths.
 */
export async function getCachedSep42VerifiedAssets(input: {
  config: ServerConfig;
  cache?: KVNamespace | undefined;
  fetchFn?: FetchLike | undefined;
}): Promise<VerifiedAssetEntry[]> {
  if (input.config.sep42AssetListUrls.length === 0) {
    return [];
  }
  const kvKey = `sep42:${input.config.network}:v1`;
  if (input.cache) {
    const cached = await input.cache.get(kvKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached) as unknown;
        if (Array.isArray(parsed)) {
          return parsed as VerifiedAssetEntry[];
        }
      } catch {
        // Ignore corrupted KV entry and refresh from SEP-42 lists
      }
    }
  }

  const verifiedAssets = await fetchSep42VerifiedAssets(
    input.config.sep42AssetListUrls,
    input.fetchFn ? { fetchFn: input.fetchFn } : undefined,
  ).catch(() => [] as VerifiedAssetEntry[]);

  if (verifiedAssets.length > 0 && input.cache) {
    await input.cache
      .put(kvKey, JSON.stringify(verifiedAssets), { expirationTtl: 600 })
      .catch(() => undefined);
  }
  return verifiedAssets;
}
