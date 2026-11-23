import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import { Asset, StrKey } from "@stellar/stellar-sdk";
import type { FetchLike } from "./stellar-verifier.js";

export type MarketTimeframe = "24h" | "7d" | "30d" | "1y" | "all";

async function fetchHorizonJson<T>(
  horizonUrls: readonly string[],
  pathAndQuery: string,
  fetchFn: FetchLike = fetch,
): Promise<T | null> {
  let lastErr: unknown;
  for (const rawBase of horizonUrls) {
    const base = rawBase.replace(/\/+$/, "");
    try {
      const res = await fetchFn(`${base}${pathAndQuery}`, {
        headers: { Accept: "application/json" },
      });
      if (res.status === 404) return null;
      if (!res.ok) {
        lastErr = new Error(`Horizon returned HTTP ${res.status}`);
        continue;
      }
      return (await res.json()) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr instanceof Error) throw lastErr;
  return null;
}

function resolveAssetParams(
  prefix: string,
  assetCode: string,
  assetIssuer?: string,
): Record<string, string> {
  const code = assetCode.trim();
  if (code.toUpperCase() === "XLM" && !assetIssuer) {
    return { [`${prefix}_asset_type`]: "native" };
  }
  return {
    [`${prefix}_asset_type`]: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
    [`${prefix}_asset_code`]: code,
    ...(assetIssuer ? { [`${prefix}_asset_issuer`]: assetIssuer } : {}),
  };
}

function parseFinite(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw === "string") {
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function parseTradePrice(price?: { n?: string | number; d?: string | number }): number | null {
  if (!price) return null;
  const n = parseFinite(price.n);
  const d = parseFinite(price.d);
  if (n === null || d === null || d <= 0) return null;
  const val = n / d;
  return Number.isFinite(val) && val > 0 ? val : null;
}

interface RawOhlcvCandle {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
  avg?: number | undefined;
}

function medianOf(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function rollupCandles(candles: readonly RawOhlcvCandle[], bucketMs: number): RawOhlcvCandle[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, RawOhlcvCandle & { weightedSum: number; weightVol: number }>();

  for (const c of sorted) {
    const bucketTs = Math.floor(c.timestamp / bucketMs) * bucketMs;
    const prev = buckets.get(bucketTs);
    const weight = c.baseVolume > 0 ? c.baseVolume : 0;
    const avgPrice = c.avg && c.avg > 0 ? c.avg : c.close;
    if (!prev) {
      buckets.set(bucketTs, {
        timestamp: bucketTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        baseVolume: c.baseVolume,
        avg: avgPrice,
        weightedSum: avgPrice * weight,
        weightVol: weight,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.baseVolume += c.baseVolume;
      prev.weightedSum += avgPrice * weight;
      prev.weightVol += weight;
      prev.avg = prev.weightVol > 0 ? prev.weightedSum / prev.weightVol : prev.close;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(({ timestamp, open, high, low, close, baseVolume, avg }) => ({
      timestamp,
      open,
      high,
      low,
      close,
      baseVolume,
      ...(avg !== undefined ? { avg } : {}),
    }));
}

function percentile75(nums: readonly number[]): number {
  if (nums.length === 0) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.75))]!;
}

function rollupMonthlyCandles(candles: readonly RawOhlcvCandle[]): RawOhlcvCandle[] {
  if (candles.length === 0) return [];
  const sorted = [...candles].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, RawOhlcvCandle & { weightedSum: number; weightVol: number }>();

  for (const c of sorted) {
    const d = new Date(c.timestamp);
    const monthTs = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    const prev = buckets.get(monthTs);
    const weight = c.baseVolume > 0 ? c.baseVolume : 0;
    const avgPrice = c.avg && c.avg > 0 ? c.avg : c.close;
    if (!prev) {
      buckets.set(monthTs, {
        timestamp: monthTs,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        baseVolume: c.baseVolume,
        avg: avgPrice,
        weightedSum: avgPrice * weight,
        weightVol: weight,
      });
    } else {
      prev.high = Math.max(prev.high, c.high);
      prev.low = Math.min(prev.low, c.low);
      prev.close = c.close;
      prev.baseVolume += c.baseVolume;
      prev.weightedSum += avgPrice * weight;
      prev.weightVol += weight;
      prev.avg = prev.weightVol > 0 ? prev.weightedSum / prev.weightVol : prev.close;
    }
  }

  return Array.from(buckets.values())
    .sort((a, b) => a.timestamp - b.timestamp)
    .map(({ timestamp, open, high, low, close, baseVolume, avg }) => ({
      timestamp,
      open,
      high,
      low,
      close,
      baseVolume,
      ...(avg !== undefined ? { avg } : {}),
    }));
}

/**
 * Two-tier Stellar SDEX/AMM OHLCV sanitizer:
 * 1) Snaps dust-corrupted open/close prices (>12% away from Horizon VWAP `avg`) back to `avg`.
 * 2) Leaves normal wicks untouched while reconstructing unmistakably corrupted SDEX dust wicks
 *    to a realistic 75th-percentile candle wick ratio (instead of leaving 15% hair-comb spikes).
 */
export function sanitizeOhlcvCandles(
  candles: readonly RawOhlcvCandle[],
  opts?: { timeframe?: MarketTimeframe; maxWickFloorPct?: number },
): Array<{
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  baseVolume: number;
}> {
  if (candles.length === 0) return [];
  const deduped = new Map<number, RawOhlcvCandle>();
  for (const c of candles) {
    if (
      Number.isFinite(c.timestamp) &&
      c.open > 0 &&
      c.high > 0 &&
      c.low > 0 &&
      c.close > 0
    ) {
      deduped.set(c.timestamp, c);
    }
  }
  const sorted = Array.from(deduped.values()).sort((a, b) => a.timestamp - b.timestamp);
  if (sorted.length === 0) return [];

  const allAnchors = sorted.map((c) => (c.avg && c.avg > 0 ? c.avg : c.close));
  const seriesMedian = medianOf(allAnchors);
  const medianVol = medianOf(sorted.map((c) => c.baseVolume).filter((v) => v > 0));

  // Pass 1: clean bodies against VWAP / rolling median before measuring normal wick distribution
  const bodyCleaned = sorted.map((c, idx) => {
    const start = Math.max(0, idx - 3);
    const end = Math.min(sorted.length, idx + 4);
    const windowAnchors = allAnchors.slice(start, end);
    const localMed = windowAnchors.length >= 3 ? medianOf(windowAnchors) : seriesMedian;

    let open = c.open;
    let close = c.close;
    let high = c.high;
    let low = c.low;

    const avgValid =
      c.avg !== undefined && c.avg > 0 && localMed > 0 && c.avg >= 0.4 * localMed && c.avg <= 2.5 * localMed;
    if (avgValid && c.avg !== undefined) {
      if (Math.abs(open - c.avg) / c.avg > 0.12) open = c.avg;
      if (Math.abs(close - c.avg) / c.avg > 0.12) close = c.avg;
    }

    if (
      localMed > 0 &&
      medianVol > 0 &&
      c.baseVolume < 0.05 * medianVol &&
      (close > 3.5 * localMed || close < localMed / 3.5)
    ) {
      open = localMed;
      close = localMed;
      high = localMed;
      low = localMed;
    }

    return { timestamp: c.timestamp, open, high, low, close, baseVolume: c.baseVolume };
  });

  const cleanUpWicks = bodyCleaned
    .map((c) => {
      const bm = Math.max(c.open, c.close);
      return bm > 0 ? (c.high - bm) / bm : 0;
    })
    .filter((w) => w >= 0 && w < 0.10);
  const cleanDnWicks = bodyCleaned
    .map((c) => {
      const bm = Math.min(c.open, c.close);
      return bm > 0 ? (bm - c.low) / bm : 0;
    })
    .filter((w) => w >= 0 && w < 0.10);

  const p75Up = Math.max(0.015, Math.min(0.045, percentile75(cleanUpWicks) || 0.025));
  const p75Dn = Math.max(0.015, Math.min(0.045, percentile75(cleanDnWicks) || 0.025));

  const isMultiYearAll = opts?.timeframe === "all";
  const upThreshold = isMultiYearAll ? 0.35 : Math.min(0.11, Math.max(0.075, p75Up * 3.0));
  const dnThreshold = isMultiYearAll ? 0.35 : Math.min(0.11, Math.max(0.075, p75Dn * 3.0));
  const upReconstruct = isMultiYearAll ? 0.12 : Math.min(0.035, p75Up * 1.25);
  const dnReconstruct = isMultiYearAll ? 0.12 : Math.min(0.035, p75Dn * 1.25);

  return bodyCleaned.map((c) => {
    const bodyMax = Math.max(c.open, c.close);
    const bodyMin = Math.min(c.open, c.close);
    const rawUp = bodyMax > 0 ? (c.high - bodyMax) / bodyMax : 0;
    const rawDn = bodyMin > 0 ? (bodyMin - c.low) / bodyMin : 0;

    const high = Math.max(
      bodyMax,
      rawUp > upThreshold ? bodyMax * (1 + upReconstruct) : c.high,
    );
    const low = Math.min(
      bodyMin,
      rawDn > dnThreshold ? bodyMin / (1 + dnReconstruct) : c.low,
    );

    return {
      timestamp: c.timestamp,
      open: c.open,
      high,
      low,
      close: c.close,
      baseVolume: c.baseVolume,
    };
  });
}

async function fetchKrakenXlmOhlcv(
  intervalMinutes: 1440 | 10080,
  fetchFn: FetchLike,
): Promise<RawOhlcvCandle[]> {
  try {
    const res = await fetchFn(
      `https://api.kraken.com/0/public/OHLC?pair=XLMUSD&interval=${intervalMinutes}`,
      {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as {
      error?: string[];
      result?: Record<string, Array<[number, string, string, string, string, string, string, number]>>;
    };
    if (body.error && body.error.length > 0) return [];
    const pairKey = Object.keys(body.result ?? {}).find((k) => k !== "last");
    if (!pairKey) return [];
    const rows = body.result?.[pairKey] ?? [];
    return rows
      .map((row): RawOhlcvCandle | null => {
        const tsSec = Number(row[0]);
        const open = parseFinite(row[1]);
        const high = parseFinite(row[2]);
        const low = parseFinite(row[3]);
        const close = parseFinite(row[4]);
        const vwap = parseFinite(row[5]);
        const vol = parseFinite(row[6]) ?? 0;
        if (
          !Number.isFinite(tsSec) ||
          tsSec <= 0 ||
          open === null ||
          high === null ||
          low === null ||
          close === null ||
          close <= 0
        ) {
          return null;
        }
        return {
          timestamp: tsSec * 1000,
          open,
          high,
          low,
          close,
          baseVolume: vol,
          ...(vwap !== null && vwap > 0 ? { avg: vwap } : {}),
        };
      })
      .filter((c): c is RawOhlcvCandle => c !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  } catch {
    return [];
  }
}

export async function fetchMarketPriceHistory(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  timeframe: MarketTimeframe;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
  nowMs: number;
  fetchFn?: FetchLike | undefined;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const isBaseNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const quoteCode = input.counterAsset?.code ?? "XLM";
  const quoteIssuer = input.counterAsset?.issuer;
  const isQuoteNative = quoteCode.toUpperCase() === "XLM" && !quoteIssuer;

  if (isBaseNative && isQuoteNative) {
    return {
      timeframe: input.timeframe,
      quoteCode: "XLM",
      candles: [],
      latestPriceXlm: 1,
      changePct: 0,
      high: 1,
      low: 1,
      volumeBase: 0,
      source: "parity" as const,
    };
  }

  const baseParams = resolveAssetParams("base", input.assetCode, input.assetIssuer);
  const counterParams = resolveAssetParams("counter", quoteCode, quoteIssuer);
  const isMainnet = !input.horizonUrls.some((u) => u.includes("testnet"));
  const wickFloor = input.timeframe === "24h" || input.timeframe === "7d" ? 0.08 : 0.15;

  async function queryAggRange(
    startMs: number,
    endMs: number,
    resolutionMs: number,
    limit: number,
  ): Promise<RawOhlcvCandle[]> {
    const params = new URLSearchParams({
      ...baseParams,
      ...counterParams,
      start_time: String(Math.max(0, startMs)),
      end_time: String(endMs),
      resolution: String(resolutionMs),
      limit: String(limit),
      order: "desc",
    });
    const body = await fetchHorizonJson<{
      _embedded?: {
        records?: Array<{
          timestamp?: string;
          open?: string;
          high?: string;
          low?: string;
          close?: string;
          avg?: string;
          base_volume?: string;
        }>;
      };
    }>(input.horizonUrls, `/trade_aggregations?${params.toString()}`, fetchFn);

    return (body?._embedded?.records ?? [])
      .map((rec): RawOhlcvCandle | null => {
        const ts = parseFinite(rec.timestamp);
        const open = parseFinite(rec.open);
        const high = parseFinite(rec.high);
        const low = parseFinite(rec.low);
        const close = parseFinite(rec.close);
        const avg = parseFinite(rec.avg);
        const baseVolume = parseFinite(rec.base_volume) ?? 0;
        if (ts === null || open === null || high === null || low === null || close === null || close <= 0) {
          return null;
        }
        return {
          timestamp: ts,
          open,
          high,
          low,
          close,
          baseVolume,
          ...(avg !== null && avg > 0 ? { avg } : {}),
        };
      })
      .filter((c): c is RawOhlcvCandle => c !== null)
      .reverse();
  }

  try {
    if (
      isBaseNative &&
      isMainnet &&
      (quoteCode.toUpperCase() === "USDC" || quoteCode.toUpperCase() === "USD") &&
      (input.timeframe === "30d" || input.timeframe === "1y" || input.timeframe === "all")
    ) {
      const interval = input.timeframe === "all" ? 10080 : 1440;
      const krakenRaw = await fetchKrakenXlmOhlcv(interval, fetchFn);
      if (krakenRaw.length >= 10) {
        const shaped =
          input.timeframe === "30d"
            ? krakenRaw.slice(-30)
            : input.timeframe === "1y"
              ? krakenRaw.slice(-365)
              : rollupMonthlyCandles(krakenRaw);
        const candles = sanitizeOhlcvCandles(shaped, { timeframe: input.timeframe });
        const first = candles[0]!;
        const last = candles[candles.length - 1]!;
        return {
          timeframe: input.timeframe,
          quoteCode,
          ...(quoteIssuer ? { quoteIssuer } : {}),
          candles,
          latestPriceXlm: last.close,
          changePct: first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null,
          high: Math.max(...candles.map((c) => c.high)),
          low: Math.min(...candles.map((c) => c.low)),
          volumeBase: candles.reduce((s, c) => s + c.baseVolume, 0),
          source: "kraken_ohlc" as const,
        };
      }
    }

    const DAY_MS = 86_400_000;
    let rawCandles: RawOhlcvCandle[] = [];

    if (input.timeframe === "24h") {
      rawCandles = await queryAggRange(input.nowMs - DAY_MS, input.nowMs, 900_000, 96);
      if (rawCandles.length < 2) {
        const hourly = await queryAggRange(input.nowMs - DAY_MS, input.nowMs, 3_600_000, 24);
        if (hourly.length > rawCandles.length) rawCandles = hourly;
      }
    } else if (input.timeframe === "7d") {
      const hourly = await queryAggRange(input.nowMs - 7 * DAY_MS, input.nowMs, 3_600_000, 168);
      rawCandles = rollupCandles(hourly, 14_400_000);
    } else if (input.timeframe === "30d") {
      rawCandles = await queryAggRange(input.nowMs - 30 * DAY_MS, input.nowMs, DAY_MS, 30);
    } else if (input.timeframe === "1y") {
      const splitMs = input.nowMs - 200 * DAY_MS;
      const [recent, older] = await Promise.all([
        queryAggRange(splitMs, input.nowMs, DAY_MS, 200),
        queryAggRange(input.nowMs - 365 * DAY_MS, splitMs, DAY_MS, 170).catch(() => []),
      ]);
      rawCandles = [...older, ...recent];
    } else {
      const splitMs = input.nowMs - 200 * DAY_MS;
      const [recent, older] = await Promise.all([
        queryAggRange(splitMs, input.nowMs, DAY_MS, 200),
        queryAggRange(input.nowMs - 400 * DAY_MS, splitMs, DAY_MS, 200).catch(() => []),
      ]);
      const combined = [...older, ...recent];
      rawCandles = combined.length > 100 ? rollupCandles(combined, 604_800_000) : combined;
    }

    if (rawCandles.length < 2 && (input.timeframe === "30d" || input.timeframe === "1y" || input.timeframe === "all")) {
      const hourly = await queryAggRange(input.nowMs - 7 * DAY_MS, input.nowMs, 3_600_000, 168).catch(() => []);
      if (hourly.length > rawCandles.length) {
        rawCandles = hourly;
      }
    }

    if (rawCandles.length > 0) {
      const candles = sanitizeOhlcvCandles(rawCandles, { timeframe: input.timeframe });
      const first = candles[0]!;
      const last = candles[candles.length - 1]!;
      return {
        timeframe: input.timeframe,
        quoteCode,
        ...(quoteIssuer ? { quoteIssuer } : {}),
        candles,
        latestPriceXlm: last.close,
        changePct: first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null,
        high: Math.max(...candles.map((c) => c.high)),
        low: Math.min(...candles.map((c) => c.low)),
        volumeBase: candles.reduce((s, c) => s + c.baseVolume, 0),
        source: "trade_aggregations" as const,
      };
    }
  } catch {
    // Fall through to trades / order_book
  }

  try {
    const tradeParams = new URLSearchParams({
      ...baseParams,
      ...counterParams,
      limit: "20",
      order: "desc",
    });
    const tradesBody = await fetchHorizonJson<{
      _embedded?: {
        records?: Array<{
          ledger_close_time?: string;
          base_amount?: string;
          price?: { n?: string | number; d?: string | number };
        }>;
      };
    }>(input.horizonUrls, `/trades?${tradeParams.toString()}`, fetchFn);

    const rawPoints = (tradesBody?._embedded?.records ?? [])
      .map((t): RawOhlcvCandle | null => {
        const p = parseTradePrice(t.price);
        const ts = t.ledger_close_time ? Date.parse(t.ledger_close_time) : NaN;
        if (p === null || !Number.isFinite(ts)) return null;
        return {
          timestamp: ts,
          open: p,
          high: p,
          low: p,
          close: p,
          baseVolume: parseFinite(t.base_amount) ?? 0,
        };
      })
      .filter((c): c is RawOhlcvCandle => c !== null)
      .reverse();

    if (rawPoints.length > 0) {
      const points = sanitizeOhlcvCandles(rawPoints, { maxWickFloorPct: wickFloor });
      const first = points[0]!;
      const last = points[points.length - 1]!;
      return {
        timeframe: input.timeframe,
        quoteCode,
        ...(quoteIssuer ? { quoteIssuer } : {}),
        candles: points,
        latestPriceXlm: last.close,
        changePct: first.open > 0 ? ((last.close - first.open) / first.open) * 100 : null,
        high: Math.max(...points.map((c) => c.high)),
        low: Math.min(...points.map((c) => c.low)),
        volumeBase: points.reduce((s, c) => s + c.baseVolume, 0),
        source: "trades" as const,
      };
    }
  } catch {
    // Fall through to order_book
  }

  const ob = await fetchMarketOrderbook({
    horizonUrls: input.horizonUrls,
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
    counterAsset: input.counterAsset,
    limit: 5,
    fetchFn,
  }).catch(() => null);
  const midNum = ob?.midPriceXlm ? parseFinite(ob.midPriceXlm) : null;
  return {
    timeframe: input.timeframe,
    quoteCode,
    ...(quoteIssuer ? { quoteIssuer } : {}),
    candles: [],
    latestPriceXlm: midNum,
    changePct: null,
    high: midNum,
    low: midNum,
    volumeBase: 0,
    source: "order_book" as const,
  };
}

export async function fetchMarketOrderbook(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
  limit?: number | undefined;
  fetchFn?: FetchLike | undefined;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 20);
  const quoteCode = input.counterAsset?.code ?? "XLM";
  const quoteIssuer = input.counterAsset?.issuer;
  const isBaseNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const isQuoteNative = quoteCode.toUpperCase() === "XLM" && !quoteIssuer;

  if (isBaseNative && isQuoteNative) {
    return { quoteCode, quoteIssuer, bids: [], asks: [], midPriceXlm: "1", spreadPct: "0.00" };
  }

  const params = new URLSearchParams({
    ...resolveAssetParams("selling", input.assetCode, input.assetIssuer),
    ...resolveAssetParams("buying", quoteCode, quoteIssuer),
    limit: String(limit),
  });
  const body = await fetchHorizonJson<{
    bids?: Array<{ price?: string; amount?: string }>;
    asks?: Array<{ price?: string; amount?: string }>;
  }>(input.horizonUrls, `/order_book?${params.toString()}`, fetchFn);

  const bids = (body?.bids ?? [])
    .filter((b): b is { price: string; amount: string } => Boolean(b.price && b.amount))
    .slice(0, limit);
  const asks = (body?.asks ?? [])
    .filter((a): a is { price: string; amount: string } => Boolean(a.price && a.amount))
    .slice(0, limit);

  const topBid = parseFinite(bids[0]?.price);
  const topAsk = parseFinite(asks[0]?.price);
  let midPriceXlm: string | null = null;
  let spreadPct: string | null = null;
  if (topBid !== null && topAsk !== null && topBid > 0 && topAsk > 0) {
    const mid = (topBid + topAsk) / 2;
    midPriceXlm = mid.toPrecision(6);
    if (mid > 0) spreadPct = Math.max(0, ((topAsk - topBid) / mid) * 100).toFixed(2);
  } else if (topBid !== null && topBid > 0) {
    midPriceXlm = topBid.toPrecision(6);
  } else if (topAsk !== null && topAsk > 0) {
    midPriceXlm = topAsk.toPrecision(6);
  }

  return { quoteCode, quoteIssuer, bids, asks, midPriceXlm, spreadPct };
}

export async function fetchMarketRecentTrades(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  counterAsset?: { code: string; issuer?: ClassicAddress | undefined } | undefined;
  limit?: number | undefined;
  fetchFn?: FetchLike | undefined;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const quoteCode = input.counterAsset?.code ?? "XLM";
  const quoteIssuer = input.counterAsset?.issuer;
  const isBaseNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const isQuoteNative = quoteCode.toUpperCase() === "XLM" && !quoteIssuer;
  if (isBaseNative && isQuoteNative) return [];

  const params = new URLSearchParams({
    ...resolveAssetParams("base", input.assetCode, input.assetIssuer),
    ...resolveAssetParams("counter", quoteCode, quoteIssuer),
    limit: String(Math.min(Math.max(input.limit ?? 15, 1), 50)),
    order: "desc",
  });

  const body = await fetchHorizonJson<{
    _embedded?: {
      records?: Array<{
        id?: string;
        ledger_close_time?: string;
        base_amount?: string;
        counter_amount?: string;
        base_account?: string;
        counter_account?: string;
        base_is_seller?: boolean;
        price?: { n?: string | number; d?: string | number };
      }>;
    };
  }>(input.horizonUrls, `/trades?${params.toString()}`, fetchFn);

  const out = [];
  for (const rec of body?._embedded?.records ?? []) {
    const p = parseTradePrice(rec.price);
    if (p === null || !rec.id || !rec.ledger_close_time) continue;
    out.push({
      id: rec.id,
      timestamp: rec.ledger_close_time,
      price: p.toPrecision(6),
      baseAmount: rec.base_amount ?? "0",
      counterAmount: rec.counter_amount ?? "0",
      baseAccount: rec.base_account,
      counterAccount: rec.counter_account,
      isBuy: !rec.base_is_seller,
    });
  }
  return out;
}

export async function fetchMarketTokenDetails(input: {
  horizonUrls: readonly string[];
  networkPassphrase: string;
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  fetchFn?: FetchLike | undefined;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const cleanCode = input.assetCode.trim();
  const isNative = cleanCode.toUpperCase() === "XLM" && !input.assetIssuer;
  const asset = isNative ? Asset.native() : new Asset(cleanCode, input.assetIssuer ?? "");
  const sacContractId = asset.contractId(input.networkPassphrase) as ContractAddress;

  if (isNative) {
    let totalCoins = "0";
    let latestLedgerSequence: number | undefined;
    let baseFeeStroops: number | undefined;
    let baseReserveStroops: number | undefined;
    let maxTxSetSize: number | undefined;
    let protocolVersion: number | undefined;
    try {
      const ledgerBody = await fetchHorizonJson<{
        _embedded?: {
          records?: Array<{
            sequence?: number;
            total_coins?: string;
            base_fee_in_stroops?: number;
            base_reserve_in_stroops?: number;
            max_tx_set_size?: number;
            protocol_version?: number;
          }>;
        };
      }>(input.horizonUrls, "/ledgers?order=desc&limit=1", fetchFn);
      const rec = ledgerBody?._embedded?.records?.[0];
      totalCoins = rec?.total_coins ?? "0";
      latestLedgerSequence = rec?.sequence;
      baseFeeStroops = rec?.base_fee_in_stroops;
      baseReserveStroops = rec?.base_reserve_in_stroops;
      maxTxSetSize = rec?.max_tx_set_size;
      protocolVersion = rec?.protocol_version;
    } catch {
      // Non-fatal
    }
    return {
      assetCode: "XLM",
      isNative: true,
      sacContractId,
      homeDomain: "stellar.org",
      name: "Stellar Lumens",
      description:
        "Native protocol asset of the Stellar network securing ledger base reserves, Soroban execution, and fees.",
      orgName: "Stellar Development Foundation",
      orgUrl: "https://stellar.org",
      supplyAmount: totalCoins,
      numAccounts: 0,
      ...(latestLedgerSequence !== undefined ? { latestLedgerSequence } : {}),
      ...(baseFeeStroops !== undefined ? { baseFeeStroops } : {}),
      ...(baseReserveStroops !== undefined ? { baseReserveStroops } : {}),
      ...(maxTxSetSize !== undefined ? { maxTxSetSize } : {}),
      ...(protocolVersion !== undefined ? { protocolVersion } : {}),
      flags: {
        authRequired: false,
        authRevocable: false,
        authImmutable: true,
        authClawbackEnabled: false,
      },
    };
  }

  const assetParams = new URLSearchParams({
    asset_code: cleanCode,
    asset_issuer: input.assetIssuer ?? "",
    limit: "1",
  });
  const [assetBody, issuerAccount] = await Promise.all([
    fetchHorizonJson<{
      _embedded?: {
        records?: Array<{
          amount?: string;
          balances?: { authorized?: string };
          accounts?: {
            authorized?: number;
            authorized_to_maintain_liabilities?: number;
            unauthorized?: number;
          };
          num_claimable_balances?: number;
          num_liquidity_pools?: number;
          num_contracts?: number;
          contracts_amount?: string;
          claimable_balances_amount?: string;
          liquidity_pools_amount?: string;
          flags?: {
            auth_required?: boolean;
            auth_revocable?: boolean;
            auth_immutable?: boolean;
            auth_clawback_enabled?: boolean;
          };
        }>;
      };
    }>(input.horizonUrls, `/assets?${assetParams.toString()}`, fetchFn).catch(() => null),
    fetchHorizonJson<{
      home_domain?: string;
      flags?: {
        auth_required?: boolean;
        auth_revocable?: boolean;
        auth_immutable?: boolean;
        auth_clawback_enabled?: boolean;
      };
    }>(input.horizonUrls, `/accounts/${encodeURIComponent(input.assetIssuer ?? "")}`, fetchFn).catch(
      () => null,
    ),
  ]);

  const record = assetBody?._embedded?.records?.[0];
  const flagsSource = record?.flags ?? issuerAccount?.flags;
  return {
    assetCode: cleanCode,
    assetIssuer: input.assetIssuer,
    isNative: false,
    sacContractId,
    homeDomain: issuerAccount?.home_domain?.trim() || undefined,
    supplyAmount: record?.balances?.authorized ?? record?.amount ?? "0",
    numAccounts: record?.accounts?.authorized ?? 0,
    ...(typeof record?.accounts?.authorized_to_maintain_liabilities === "number"
      ? {
          authorizedToMaintainLiabilitiesAccounts:
            record.accounts.authorized_to_maintain_liabilities,
        }
      : {}),
    ...(typeof record?.accounts?.unauthorized === "number"
      ? { unauthorizedAccounts: record.accounts.unauthorized }
      : {}),
    ...(typeof record?.num_claimable_balances === "number"
      ? { numClaimableBalances: record.num_claimable_balances }
      : {}),
    ...(typeof record?.num_liquidity_pools === "number"
      ? { numLiquidityPools: record.num_liquidity_pools }
      : {}),
    ...(typeof record?.num_contracts === "number" ? { numContracts: record.num_contracts } : {}),
    ...(record?.contracts_amount ? { contractsAmount: record.contracts_amount } : {}),
    claimableBalancesAmount: record?.claimable_balances_amount,
    liquidityPoolsAmount: record?.liquidity_pools_amount,
    flags: {
      authRequired: Boolean(flagsSource?.auth_required),
      authRevocable: Boolean(flagsSource?.auth_revocable),
      authImmutable: Boolean(flagsSource?.auth_immutable),
      authClawbackEnabled: Boolean(flagsSource?.auth_clawback_enabled),
    },
  };
}

export async function fetchMarketLiquidAssets(input: {
  horizonUrls: readonly string[];
  limit?: number | undefined;
  fetchFn?: FetchLike | undefined;
}) {
  const fetchFn = input.fetchFn ?? fetch;
  const limit = Math.min(Math.max(input.limit ?? 15, 1), 30);
  const [poolsBody, assetsBody] = await Promise.all([
    fetchHorizonJson<{
      _embedded?: {
        records?: Array<{
          total_shares?: string;
          reserves?: Array<{ asset?: string; amount?: string }>;
        }>;
      };
    }>(input.horizonUrls, `/liquidity_pools?limit=${limit}&order=desc`, fetchFn).catch(() => null),
    fetchHorizonJson<{
      _embedded?: {
        records?: Array<{
          asset_code?: string;
          asset_issuer?: string;
          amount?: string;
          balances?: { authorized?: string };
          accounts?: { authorized?: number };
        }>;
      };
    }>(input.horizonUrls, `/assets?limit=${limit}&order=desc`, fetchFn).catch(() => null),
  ]);

  const discovered = new Map<
    string,
    {
      assetCode: string;
      assetIssuer?: ClassicAddress;
      numAccounts?: number;
      supplyAmount?: string;
      isVerified: boolean;
      hasTrustline: boolean;
      hasLiquidityPool?: boolean | undefined;
      poolReserveAmount?: string | undefined;
    }
  >();

  for (const pool of poolsBody?._embedded?.records ?? []) {
    if ((parseFinite(pool.total_shares) ?? 0) <= 0) continue;
    for (const reserve of pool.reserves ?? []) {
      const rawAsset = reserve.asset?.trim();
      if (!rawAsset || rawAsset === "native" || !rawAsset.includes(":")) continue;
      const [rawCode, rawIssuer] = rawAsset.split(":");
      const code = rawCode?.trim();
      const issuer = rawIssuer?.trim();
      if (!code || !issuer || !StrKey.isValidEd25519PublicKey(issuer)) continue;
      const reserveNum = parseFinite(reserve.amount) ?? 0;
      if (reserveNum <= 0) continue;
      const key = `${code.toUpperCase()}:${issuer}`;
      const prev = discovered.get(key);
      if (!prev || reserveNum > (parseFinite(prev.poolReserveAmount) ?? 0)) {
        discovered.set(key, {
          assetCode: code,
          assetIssuer: issuer as ClassicAddress,
          isVerified: false,
          hasTrustline: false,
          hasLiquidityPool: true,
          ...(reserve.amount ? { poolReserveAmount: reserve.amount } : {}),
        });
      }
    }
  }

  for (const rec of assetsBody?._embedded?.records ?? []) {
    if (!rec.asset_code || !rec.asset_issuer || !StrKey.isValidEd25519PublicKey(rec.asset_issuer)) {
      continue;
    }
    const key = `${rec.asset_code.toUpperCase()}:${rec.asset_issuer}`;
    const existing = discovered.get(key);
    const authorized = rec.accounts?.authorized ?? 0;
    if (!existing && authorized <= 0) continue;
    discovered.set(key, {
      assetCode: rec.asset_code,
      assetIssuer: rec.asset_issuer as ClassicAddress,
      numAccounts: authorized,
      supplyAmount: rec.balances?.authorized ?? rec.amount ?? "0",
      isVerified: false,
      hasTrustline: false,
      ...(existing?.hasLiquidityPool ? { hasLiquidityPool: true } : {}),
      ...(existing?.poolReserveAmount ? { poolReserveAmount: existing.poolReserveAmount } : {}),
    });
  }

  return Array.from(discovered.values()).slice(0, limit);
}

export interface MarketTopHolder {
  address: string;
  balance: string;
  sharePct: number | null;
}

export interface MarketLiquidityPoolSummary {
  id: string;
  totalTrustlines: number;
  totalShares: string;
  reserves: Array<{ asset: string; amount: string }>;
}

/**
 * Fetches live top on-chain holders (for issued assets) and AMM liquidity pools
 * from Horizon so the Token Explorer displays rich Stellar.Expert-style telemetry.
 */
export async function fetchMarketTopHoldersAndPools(input: {
  horizonUrls: readonly string[];
  assetCode: string;
  assetIssuer?: ClassicAddress | undefined;
  supplyAmount?: string | undefined;
  fetchFn?: FetchLike | undefined;
}): Promise<{
  holders: MarketTopHolder[];
  liquidityPools: MarketLiquidityPoolSummary[];
}> {
  const fetchFn = input.fetchFn ?? fetch;
  const isNative = input.assetCode.trim().toUpperCase() === "XLM" && !input.assetIssuer;
  const reserveParam = isNative
    ? "native"
    : `${input.assetCode.trim()}:${input.assetIssuer}`;

  const holdersPromise: Promise<MarketTopHolder[]> = isNative
    ? fetchHorizonJson<{
        _embedded?: {
          records?: Array<{
            source_account?: string;
          }>;
        };
      }>(
        input.horizonUrls,
        `/transactions?limit=25&order=desc`,
        fetchFn,
      )
        .then(async (body) => {
          const uniq = new Set<string>();
          for (const rec of body?._embedded?.records ?? []) {
            if (rec.source_account && StrKey.isValidEd25519PublicKey(rec.source_account)) {
              uniq.add(rec.source_account);
            }
            if (uniq.size >= 12) break;
          }
          const addrs = Array.from(uniq).slice(0, 12);
          if (addrs.length === 0) return [];
          const supplyNum = parseFinite(input.supplyAmount);
          const list: MarketTopHolder[] = [];
          let cursor = 0;
          await Promise.all(
            Array.from({ length: Math.min(4, addrs.length) }, async () => {
              while (cursor < addrs.length) {
                const addr = addrs[cursor++];
                if (!addr) break;
                try {
                  const acc = await fetchHorizonJson<{
                    balances?: Array<{ asset_type?: string; balance?: string }>;
                  }>(input.horizonUrls, `/accounts/${encodeURIComponent(addr)}`, fetchFn);
                  const xlm = acc?.balances?.find((b) => b.asset_type === "native");
                  const val = parseFinite(xlm?.balance);
                  if (!xlm?.balance || val === null || val <= 0) continue;
                  list.push({
                    address: addr,
                    balance: xlm.balance,
                    sharePct:
                      supplyNum && supplyNum > 0
                        ? Math.min(100, (val / supplyNum) * 100)
                        : null,
                  });
                } catch {
                  // Skip transient account lookup failure
                }
              }
            }),
          );
          list.sort((a, b) => (parseFinite(b.balance) ?? 0) - (parseFinite(a.balance) ?? 0));
          return list.slice(0, 10);
        })
        .catch(() => [])
    : fetchHorizonJson<{
        _embedded?: {
          records?: Array<{
            id?: string;
            balances?: Array<{
              asset_type?: string;
              asset_code?: string;
              asset_issuer?: string;
              balance?: string;
            }>;
          }>;
        };
      }>(
        input.horizonUrls,
        `/accounts?asset=${encodeURIComponent(reserveParam)}&limit=50&order=desc`,
        fetchFn,
      )
        .then((body) => {
          const supplyNum = parseFinite(input.supplyAmount);
          const list: MarketTopHolder[] = [];
          for (const rec of body?._embedded?.records ?? []) {
            if (!rec.id) continue;
            const bal = rec.balances?.find(
              (b) =>
                b.asset_code?.toUpperCase() === input.assetCode.trim().toUpperCase() &&
                b.asset_issuer === input.assetIssuer,
            );
            const val = parseFinite(bal?.balance);
            if (!bal?.balance || val === null || val <= 0) continue;
            list.push({
              address: rec.id,
              balance: bal.balance,
              sharePct:
                supplyNum && supplyNum > 0
                  ? Math.min(100, (val / supplyNum) * 100)
                  : null,
            });
          }
          list.sort((a, b) => (parseFinite(b.balance) ?? 0) - (parseFinite(a.balance) ?? 0));
          return list.slice(0, 15);
        })
        .catch(() => []);

  const poolsPromise: Promise<MarketLiquidityPoolSummary[]> = fetchHorizonJson<{
    _embedded?: {
      records?: Array<{
        id?: string;
        total_trustlines?: number;
        total_shares?: string;
        reserves?: Array<{ asset?: string; amount?: string }>;
      }>;
    };
  }>(
    input.horizonUrls,
    `/liquidity_pools?reserves=${encodeURIComponent(reserveParam)}&limit=25&order=desc`,
    fetchFn,
  )
    .then((body) => {
      const out: MarketLiquidityPoolSummary[] = [];
      for (const p of body?._embedded?.records ?? []) {
        if (!p.id) continue;
        if ((parseFinite(p.total_shares) ?? 0) <= 0) continue;
        const reserves = (p.reserves ?? [])
          .filter((r) => r.asset && r.amount && (parseFinite(r.amount) ?? 0) > 0)
          .map((r) => ({ asset: r.asset!, amount: r.amount! }));
        if (reserves.length < 2) continue;
        out.push({
          id: p.id,
          totalTrustlines: p.total_trustlines ?? 0,
          totalShares: p.total_shares ?? "0",
          reserves,
        });
      }
      out.sort((a, b) => b.totalTrustlines - a.totalTrustlines);
      return out.slice(0, 10);
    })
    .catch(() => []);

  const [holders, liquidityPools] = await Promise.all([holdersPromise, poolsPromise]);
  return { holders, liquidityPools };
}
