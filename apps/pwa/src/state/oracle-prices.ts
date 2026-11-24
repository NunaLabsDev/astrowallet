import type { StellarNetwork } from "@astrowallet/domain";
import { readCachedEntry, writeCachedEntry } from "./market-cache.js";

export interface OraclePriceQuoteEntry {
  key: string;
  priceUsd: number;
  priceFormatted: string;
  priceRaw: string;
  decimals: number;
  timestamp: number;
  sourceKind: "stellar" | "other";
}

export interface OraclePricesResponse {
  configured: boolean;
  network: StellarNetwork;
  oracleContractId: string | null;
  decimals: number | null;
  latestLedger?: number | undefined;
  prices: Record<string, OraclePriceQuoteEntry>;
}

const ORACLE_CACHE_TTL_MS = 60_000;

/**
 * Fetches RedStone SEP-40 USD oracle prices from `/v1/proxy/oracle/prices` with short SWR cache.
 */
export async function fetchCachedOraclePrices(input: {
  apiBaseUrl: string;
  network: StellarNetwork;
  assets?: readonly string[] | undefined;
}): Promise<OraclePricesResponse | null> {
  const assetsCsv = (input.assets && input.assets.length > 0
    ? input.assets
    : ["XLM", "USDC", "USDT0", "USDE", "SUSDE", "EURC", "BTC", "ETH"]
  ).join(",");
  const cacheKey = `oracle:${input.network}:${assetsCsv}`;
  const cached = await readCachedEntry<OraclePricesResponse>(cacheKey, ORACLE_CACHE_TTL_MS);

  const base = input.apiBaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(
      `${base}/v1/proxy/oracle/prices?assets=${encodeURIComponent(assetsCsv)}`,
      {
        headers: { "X-Astro-Network": input.network },
        signal: AbortSignal.timeout(7000),
      },
    );
    if (!res.ok) {
      return cached?.data ?? null;
    }
    const json = (await res.json()) as OraclePricesResponse;
    if (json && typeof json === "object" && typeof json.prices === "object") {
      writeCachedEntry(cacheKey, json, ORACLE_CACHE_TTL_MS);
      return json;
    }
    return cached?.data ?? null;
  } catch {
    return cached?.data ?? null;
  }
}
