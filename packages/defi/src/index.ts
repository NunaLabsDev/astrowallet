import { Asset } from "@stellar/stellar-sdk";
export * from "./pro-bridge.js";
export * from "./ramps.js";
export * from "./sep40.js";
import type {
  ContractAddress,
  RampPort,
  RampQuoteRequest,
  SwapPort,
  SwapQuote,
  SwapQuoteRequest,
  YieldPort,
} from "@astrowallet/domain";

export interface ParsedSwapAsset {
  code: string;
  issuer?: string | undefined;
}

/**
 * Parses "XLM", "native", or "CODE:G..." asset identifiers.
 */
export function parseSwapAssetIdentifier(raw: string): ParsedSwapAsset {
  const trimmed = raw.trim();
  if (trimmed.toUpperCase() === "XLM" || trimmed.toLowerCase() === "native") {
    return { code: "XLM" };
  }
  const [codePart, issuerPart] = trimmed.split(":");
  const code = (codePart ?? "").trim().toUpperCase();
  const issuer = issuerPart?.trim();
  if (!code || !/^[A-Z0-9]{1,12}$/.test(code)) {
    throw new Error(`Invalid swap asset code "${raw}"`);
  }
  if (issuer && !/^G[A-Z2-7]{55}$/.test(issuer)) {
    throw new Error(`Invalid swap asset issuer for "${code}"`);
  }
  return { code, issuer: issuer || undefined };
}

interface HorizonStrictSendPathHop {
  asset_type: string;
  asset_code?: string | undefined;
  asset_issuer?: string | undefined;
}

interface HorizonStrictSendPathRecord {
  destination_amount: string;
  path?: HorizonStrictSendPathHop[];
}

interface HorizonOrderbookBid {
  price?: string;
  amount?: string;
  price_r?: { n?: number; d?: number };
}

interface HorizonOrderbookResponse {
  bids?: HorizonOrderbookBid[];
}

function setHorizonAssetQueryParams(
  params: URLSearchParams,
  prefix: string,
  parsed: ParsedSwapAsset,
): void {
  if (parsed.code === "XLM" && !parsed.issuer) {
    params.set(`${prefix}_asset_type`, "native");
    return;
  }
  if (!parsed.issuer) {
    throw new Error(`Issuer is required for non-native asset ${parsed.code}`);
  }
  params.set(
    `${prefix}_asset_type`,
    parsed.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
  );
  params.set(`${prefix}_asset_code`, parsed.code);
  params.set(`${prefix}_asset_issuer`, parsed.issuer);
}

function computeOrderbookStrictSendOutput(
  inputAmountDecimal: string,
  bids: readonly HorizonOrderbookBid[],
): { expectedOutputAmount: string; priceImpactPct: string } | null {
  const inputNum = Number(inputAmountDecimal);
  if (!Number.isFinite(inputNum) || inputNum <= 0 || bids.length === 0) {
    return null;
  }

  let remainingBase = inputNum;
  let totalCounterOut = 0;
  let topPrice: number | null = null;

  for (const bid of bids) {
    const rN = bid.price_r?.n;
    const rD = bid.price_r?.d;
    const price =
      typeof rN === "number" && typeof rD === "number" && rD > 0 && rN > 0
        ? rN / rD
        : Number(bid.price ?? "0");
    const counterAvail = Number(bid.amount ?? "0");
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(counterAvail) || counterAvail <= 0) {
      continue;
    }
    if (topPrice === null) {
      topPrice = price;
    }
    const maxBaseConsumable = counterAvail / price;
    const takeBase = Math.min(remainingBase, maxBaseConsumable);
    const gainCounter =
      takeBase >= maxBaseConsumable ? counterAvail : takeBase * price;
    totalCounterOut += gainCounter;
    remainingBase -= takeBase;
    if (remainingBase <= 1e-8) {
      remainingBase = 0;
      break;
    }
  }

  if (remainingBase > 1e-7 || totalCounterOut <= 0) {
    return null;
  }

  const stroopsOut = BigInt(Math.floor(totalCounterOut * 10_000_000));
  if (stroopsOut <= 0n) {
    return null;
  }

  const effectivePrice = totalCounterOut / inputNum;
  const impactPct =
    topPrice && topPrice > 0
      ? Math.max(0, ((topPrice - effectivePrice) / topPrice) * 100).toFixed(2)
      : "N/A";

  return {
    expectedOutputAmount: stroops7ToDecimal(stroopsOut),
    priceImpactPct: impactPct,
  };
}

/**
 * Zero-API-key Classic SDEX / AMM Path Payment swap adapter backed by Horizon failover
 * (with automatic direct `/order_book` fallback when `/paths/strict-send` returns empty).
 */
export function createHorizonPathSwapAdapter(input: {
  horizonUrls: readonly string[];
  fetchFn?: typeof fetch | undefined;
}): SwapPort {
  const fetchFn = input.fetchFn ?? fetch;

  return {
    providerName: "horizon-path",
    async getQuote(request: SwapQuoteRequest): Promise<SwapQuote> {
      const from = parseSwapAssetIdentifier(request.fromAsset);
      const to = parseSwapAssetIdentifier(request.toAsset);

      const params = new URLSearchParams({
        source_amount: request.amount,
      });

      if (from.code === "XLM" && !from.issuer) {
        params.set("source_asset_type", "native");
      } else {
        if (!from.issuer) {
          throw new Error(`Issuer is required for non-native asset ${from.code}`);
        }
        params.set(
          "source_asset_type",
          from.code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12",
        );
        params.set("source_asset_code", from.code);
        params.set("source_asset_issuer", from.issuer);
      }

      const destSpec =
        to.code === "XLM" && !to.issuer
          ? "native"
          : to.issuer
            ? `${to.code}:${to.issuer}`
            : to.code;
      if (to.code !== "XLM" && !to.issuer) {
        throw new Error(`Issuer is required for non-native asset ${to.code}`);
      }
      params.set("destination_assets", destSpec);

      let lastErr: unknown;
      for (const baseUrl of input.horizonUrls) {
        const cleanBase = baseUrl.replace(/\/+$/, "");
        try {
          const res = await fetchFn(
            `${cleanBase}/paths/strict-send?${params.toString()}`,
            { headers: { Accept: "application/json" } },
          );
          if (res.ok) {
            const body = (await res.json()) as {
              _embedded?: { records?: HorizonStrictSendPathRecord[] };
            };
            const records = body._embedded?.records ?? [];
            const [first, ...rest] = records;
            if (first) {
              let best = first;
              let bestStroops = decimalToStroops7(best.destination_amount);
              for (const rec of rest) {
                const candidateStroops = decimalToStroops7(rec.destination_amount);
                if (candidateStroops > bestStroops) {
                  best = rec;
                  bestStroops = candidateStroops;
                }
              }

              const pathAssets = (best.path ?? []).map((hop) =>
                hop.asset_type === "native" || !hop.asset_code
                  ? { assetCode: "XLM" }
                  : { assetCode: hop.asset_code, assetIssuer: hop.asset_issuer },
              );

              return {
                provider: "horizon-path",
                inputAmount: request.amount,
                expectedOutputAmount: best.destination_amount,
                priceImpactPct: "N/A",
                pathAssets,
              };
            }
          } else {
            lastErr = new Error(`Horizon path search returned HTTP ${res.status}`);
          }

          // Fallback: check direct SDEX /order_book depth when /paths/strict-send is empty
          const obParams = new URLSearchParams({ limit: "20" });
          setHorizonAssetQueryParams(obParams, "selling", from);
          setHorizonAssetQueryParams(obParams, "buying", to);
          const obRes = await fetchFn(
            `${cleanBase}/order_book?${obParams.toString()}`,
            { headers: { Accept: "application/json" } },
          );
          if (obRes.ok) {
            const obBody = (await obRes.json()) as HorizonOrderbookResponse;
            const filled = computeOrderbookStrictSendOutput(
              request.amount,
              obBody.bids ?? [],
            );
            if (filled) {
              return {
                provider: "horizon-sdex-orderbook",
                inputAmount: request.amount,
                expectedOutputAmount: filled.expectedOutputAmount,
                priceImpactPct: filled.priceImpactPct,
                pathAssets: [],
              };
            }
          }

          lastErr = new Error(`No liquidity path found between ${from.code} and ${to.code}`);
        } catch (err) {
          lastErr = err;
        }
      }

      throw lastErr instanceof Error
        ? lastErr
        : new Error("Horizon path payment quote failed");
    },
  };
}

/**
 * Converts a Stellar decimal string (up to 7 decimals) into exact 7-decimal stroops BigInt.
 */
export function decimalToStroops7(amount: string): bigint {
  const cleaned = amount.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleaned)) {
    throw new Error("Amount must be a positive decimal with up to 7 fractional digits");
  }
  const [wholePart, fracPart = ""] = cleaned.split(".");
  const stroops =
    BigInt(wholePart ?? "0") * STROOPS_PER_UNIT + BigInt(fracPart.padEnd(7, "0"));
  if (stroops <= 0n) {
    throw new Error("Amount must be greater than zero");
  }
  return stroops;
}

/**
 * Formats a 7-decimal stroops integer into a trimmed Stellar decimal string.
 */
export function stroops7ToDecimal(stroops: bigint | string): string {
  const value = typeof stroops === "bigint" ? stroops : BigInt(stroops.trim());
  const whole = value / STROOPS_PER_UNIT;
  const frac = (value % STROOPS_PER_UNIT).toString().padStart(7, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : whole.toString();
}

/**
 * Worker-proxied Soroswap Aggregator adapter (keeps sk_ API keys strictly on apps/server).
 */
export function createSoroswapProxyAdapter(input: {
  apiBaseUrl: string;
  network?: string | undefined;
  fetchFn?: typeof fetch | undefined;
}): SwapPort {
  const fetchFn = input.fetchFn ?? fetch;
  const cleanBase = input.apiBaseUrl.replace(/\/+$/, "");

  return {
    providerName: "soroswap",
    async getQuote(request: SwapQuoteRequest): Promise<SwapQuote> {
      const res = await fetchFn(`${cleanBase}/v1/proxy/soroswap/quote`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(input.network ? { "X-Astro-Network": input.network } : {}),
        },
        body: JSON.stringify(request),
      });
      if (!res.ok) {
        throw new Error(`Soroswap proxy quote failed (${res.status})`);
      }
      const data = (await res.json()) as {
        provider?: string;
        expectedOutputAmount?: string;
        priceImpactPct?: string;
        unsignedXdr?: string;
        pathAssets?: ReadonlyArray<{ assetCode: string; assetIssuer?: string | undefined }>;
      };
      if (!data.expectedOutputAmount) {
        throw new Error("Invalid quote response from Soroswap proxy");
      }
      return {
        provider: data.provider ?? "soroswap",
        inputAmount: request.amount,
        expectedOutputAmount: data.expectedOutputAmount,
        priceImpactPct: data.priceImpactPct ?? "N/A",
        unsignedXdr: data.unsignedXdr,
        pathAssets: data.pathAssets,
      };
    },
  };
}

/**
 * Composite swap engine trying Soroswap Aggregator primary and falling back to Horizon Path Payments.
 */
export function createCompositeSwapEngine(input: {
  soroswapAdapter?: SwapPort | undefined;
  horizonAdapter: SwapPort;
}): SwapPort {
  return {
    providerName: "composite-swap",
    async getQuote(request: SwapQuoteRequest): Promise<SwapQuote> {
      if (input.soroswapAdapter) {
        try {
          return await input.soroswapAdapter.getQuote(request);
        } catch {
          // Automatic fallback to zero-key Horizon Path Payments on rate-limit / error
        }
      }
      return input.horizonAdapter.getQuote(request);
    },
  };
}

/**
 * Hexagonal DeFi & Ramp registry separating v1 Swap adapters from pluggable v2 plugins.
 */
export class DeFiRegistry {
  private readonly swapAdapters = new Map<string, SwapPort>();
  private readonly rampAdapters = new Map<string, RampPort>();
  private readonly yieldAdapters = new Map<string, YieldPort>();

  registerSwapAdapter(adapter: SwapPort): this {
    this.swapAdapters.set(adapter.providerName, adapter);
    return this;
  }

  getSwapAdapter(providerName: string): SwapPort | undefined {
    return this.swapAdapters.get(providerName);
  }

  listSwapProviders(): readonly string[] {
    return [...this.swapAdapters.keys()];
  }

  registerRampAdapter(adapter: RampPort): this {
    this.rampAdapters.set(adapter.providerName, adapter);
    return this;
  }

  getRampAdapter(providerName: string): RampPort | undefined {
    return this.rampAdapters.get(providerName);
  }

  listRampProviders(): readonly string[] {
    return [...this.rampAdapters.keys()];
  }

  registerYieldAdapter(adapter: YieldPort): this {
    this.yieldAdapters.set(adapter.providerName, adapter);
    return this;
  }

  getYieldAdapter(providerName: string): YieldPort | undefined {
    return this.yieldAdapters.get(providerName);
  }

  listYieldProviders(): readonly string[] {
    return [...this.yieldAdapters.keys()];
  }
}

const STROOPS_PER_UNIT = 10_000_000n;

function assertValidRampBaseUrl(rawUrl: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  const isLocal =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (parsed.protocol !== "https:" && !isLocal) {
    throw new Error(`${label} must use https:// (or localhost http://)`);
  }
  return parsed;
}

/**
 * Converts 6-decimal EVM/Solana Circle CCTP USDC atomic units to 7-decimal Stellar stroops.
 */
export function convertEvmUsdc6ToStellarStroops7(atomic6: bigint | string): {
  atomic6: bigint;
  stroops7: bigint;
  formattedStellarUsdc: string;
} {
  let parsedAtomic: bigint;
  if (typeof atomic6 === "bigint") {
    parsedAtomic = atomic6;
  } else {
    const cleaned = atomic6.trim();
    if (!/^\d+$/.test(cleaned)) {
      throw new Error("EVM USDC 6-decimal atomic amount must be a positive integer");
    }
    parsedAtomic = BigInt(cleaned);
  }
  if (parsedAtomic <= 0n) {
    throw new Error("EVM USDC 6-decimal atomic amount must be greater than zero");
  }
  const stroops7 = parsedAtomic * 10n;
  const whole = stroops7 / STROOPS_PER_UNIT;
  const frac = (stroops7 % STROOPS_PER_UNIT).toString().padStart(7, "0");
  return {
    atomic6: parsedAtomic,
    stroops7,
    formattedStellarUsdc: `${whole.toString()}.${frac}`,
  };
}

/**
 * Converts a Stellar 7-decimal USDC amount string to 6-decimal EVM CCTP atomic units,
 * rejecting any non-zero 7th decimal digit so dust is never silently truncated.
 */
export function convertStellarUsdcToEvmAtomic6(stellarUsdcAmount: string): {
  atomic6: bigint;
  stroops7: bigint;
} {
  const cleaned = stellarUsdcAmount.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleaned)) {
    throw new Error("Stellar USDC amount must be a positive decimal with up to 7 decimals");
  }
  const [wholePart, fracPart = ""] = cleaned.split(".");
  const frac7 = fracPart.padEnd(7, "0");
  if (frac7[6] !== "0") {
    throw new Error(
      "Circle CCTP 6->7 decimal guard: 7th decimal digit must be 0 to avoid sub-micro-USDC truncation",
    );
  }
  const stroops7 = BigInt(wholePart ?? "0") * STROOPS_PER_UNIT + BigInt(frac7);
  if (stroops7 <= 0n) {
    throw new Error("Stellar USDC amount must be greater than zero");
  }
  return {
    atomic6: stroops7 / 10n,
    stroops7,
  };
}

/**
 * Self-serve zero-KYB Circle CCTP cross-chain USDC ramp adapter (`CctpForwarder`).
 */
export function createCircleCctpRampAdapter(input: {
  bridgeBaseUrl: string;
  forwarderContractId: ContractAddress;
}): RampPort {
  if (!/^C[A-Z2-7]{55}$/.test(input.forwarderContractId)) {
    throw new Error("Invalid CctpForwarder Soroban C... contract address");
  }
  assertValidRampBaseUrl(input.bridgeBaseUrl, "Circle CCTP bridgeBaseUrl");

  return {
    providerName: "circle-cctp",
    async createSessionUrl(request: RampQuoteRequest): Promise<{ url: string }> {
      if (request.assetCode.trim().toUpperCase() !== "USDC") {
        throw new Error("Circle CCTP supports USDC bridging only");
      }
      if (request.destinationAddress.startsWith("M")) {
        throw new Error(
          "Circle CCTP CctpForwarder requires an unmuxed G... or C... destination address (M... muxed strkeys are unsupported)",
        );
      }
      if (!/^[GC][A-Z2-7]{55}$/.test(request.destinationAddress)) {
        throw new Error("Invalid destination Stellar G... or C... address for Circle CCTP");
      }

      const { atomic6, stroops7 } = convertStellarUsdcToEvmAtomic6(request.amount);
      const url = assertValidRampBaseUrl(input.bridgeBaseUrl, "Circle CCTP bridgeBaseUrl");
      url.searchParams.set("provider", "circle-cctp");
      url.searchParams.set("direction", request.direction);
      url.searchParams.set("asset", "USDC");
      url.searchParams.set("forwarder", input.forwarderContractId);
      url.searchParams.set("recipient", request.destinationAddress);
      url.searchParams.set("amount", request.amount.trim());
      url.searchParams.set("atomic6", atomic6.toString());
      url.searchParams.set("stroops7", stroops7.toString());
      return { url: url.toString() };
    },
  };
}

/**
 * Self-serve MoonPay fiat on/off-ramp adapter behind RampPort.
 */
export function createMoonPayRampAdapter(input: {
  widgetBaseUrl: string;
  apiKey?: string | undefined;
}): RampPort {
  assertValidRampBaseUrl(input.widgetBaseUrl, "MoonPay widgetBaseUrl");

  return {
    providerName: "moonpay",
    async createSessionUrl(request: RampQuoteRequest): Promise<{ url: string }> {
      if (!/^\d+(?:\.\d{1,7})?$/.test(request.amount.trim()) || Number(request.amount) <= 0) {
        throw new Error("MoonPay ramp amount must be positive");
      }
      const url = assertValidRampBaseUrl(input.widgetBaseUrl, "MoonPay widgetBaseUrl");
      if (input.apiKey?.trim()) {
        url.searchParams.set("apiKey", input.apiKey.trim());
      }
      url.searchParams.set("currencyCode", request.assetCode.trim().toLowerCase());
      url.searchParams.set("baseCurrencyCode", request.fiatCurrency.trim().toLowerCase());
      url.searchParams.set("baseCurrencyAmount", request.amount.trim());
      url.searchParams.set("walletAddress", request.destinationAddress);
      url.searchParams.set("flow", request.direction);
      return { url: url.toString() };
    },
  };
}

/**
 * Self-serve Transak fiat on/off-ramp adapter behind RampPort.
 */
export function createTransakRampAdapter(input: {
  widgetBaseUrl: string;
  apiKey?: string | undefined;
}): RampPort {
  assertValidRampBaseUrl(input.widgetBaseUrl, "Transak widgetBaseUrl");

  return {
    providerName: "transak",
    async createSessionUrl(request: RampQuoteRequest): Promise<{ url: string }> {
      if (!/^\d+(?:\.\d{1,7})?$/.test(request.amount.trim()) || Number(request.amount) <= 0) {
        throw new Error("Transak ramp amount must be positive");
      }
      const url = assertValidRampBaseUrl(input.widgetBaseUrl, "Transak widgetBaseUrl");
      if (input.apiKey?.trim()) {
        url.searchParams.set("apiKey", input.apiKey.trim());
      }
      url.searchParams.set("network", "stellar");
      url.searchParams.set("cryptoCurrencyCode", request.assetCode.trim().toUpperCase());
      url.searchParams.set("fiatCurrency", request.fiatCurrency.trim().toUpperCase());
      url.searchParams.set("fiatAmount", request.amount.trim());
      url.searchParams.set("walletAddress", request.destinationAddress);
      url.searchParams.set(
        "productsAvailed",
        request.direction === "offramp" ? "SELL" : "BUY",
      );
      return { url: url.toString() };
    },
  };
}

/**
 * Resolves a swap asset identifier ("XLM" or "CODE:G...") to its canonical SAC C... contract id.
 */
export function resolveSwapAssetSacId(rawAsset: string, networkPassphrase: string): string {
  const parsed = parseSwapAssetIdentifier(rawAsset);
  if (parsed.code === "XLM" && !parsed.issuer) {
    return Asset.native().contractId(networkPassphrase);
  }
  if (!parsed.issuer) {
    throw new Error(`Issuer is required for non-native asset ${parsed.code}`);
  }
  return new Asset(parsed.code, parsed.issuer).contractId(networkPassphrase);
}

export interface SoroswapQuoteBody {
  assetIn: string;
  assetOut: string;
  amount: string;
  tradeType: "EXACT_IN";
  protocols: string[];
  slippageBps: number;
}

/**
 * Builds the Soroswap Aggregator `/quote` payload (SAC contract ids, 7-decimal stroops amount).
 */
export function buildSoroswapQuoteBody(
  request: SwapQuoteRequest,
  networkPassphrase: string,
  protocols: readonly string[] = ["soroswap", "sdex", "aqua", "phoenix"],
): SoroswapQuoteBody {
  return {
    assetIn: resolveSwapAssetSacId(request.fromAsset, networkPassphrase),
    assetOut: resolveSwapAssetSacId(request.toAsset, networkPassphrase),
    amount: decimalToStroops7(request.amount).toString(),
    tradeType: "EXACT_IN",
    protocols: [...protocols],
    slippageBps: request.slippageBps,
  };
}

/**
 * Extracts the expected output (decimal string) from a Soroswap `/quote` response (stroops).
 */
export function parseSoroswapQuoteOutput(data: {
  amountOut?: string | number | undefined;
  expectedOutputAmount?: string | undefined;
}): string | null {
  if (data.expectedOutputAmount && /^\d+(?:\.\d+)?$/.test(data.expectedOutputAmount)) {
    return data.expectedOutputAmount;
  }
  if (data.amountOut !== undefined && /^\d+$/.test(String(data.amountOut))) {
    return stroops7ToDecimal(BigInt(String(data.amountOut)));
  }
  return null;
}

const BPS_DENOMINATOR = 10_000n;

/**
 * Computes minimum acceptable output stroops (7 decimals) after slippage using exact BigInt math.
 * Throws if slippage is invalid or minimum received amount drops to `<= 0n`.
 */
export function calculateMinReceivedStroops7(
  expectedAmount: string,
  slippageBps: number,
): bigint {
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 10_000) {
    throw new Error("Slippage tolerance must be an integer between 0 and 9999 bps");
  }
  const expectedStroops = decimalToStroops7(expectedAmount);
  if (expectedStroops <= 0n) {
    throw new Error("Expected output amount must be positive");
  }
  const minReceived = (expectedStroops * (BPS_DENOMINATOR - BigInt(slippageBps))) / BPS_DENOMINATOR;
  if (minReceived <= 0n) {
    throw new Error("Minimum received amount after slippage must be greater than zero");
  }
  return minReceived;
}
