import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  Networks,
  StrKey,
  TransactionBuilder,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { ContractAddress } from "@astrowallet/domain";

export type Sep40AssetDescriptor =
  | { kind: "stellar"; contractId: string }
  | { kind: "other"; symbol: string };

export interface Sep40PriceRequestAsset {
  key: string;
  symbol?: string | undefined;
  contractId?: string | undefined;
}

export interface Sep40PriceQuote {
  key: string;
  priceUsd: number;
  priceFormatted: string;
  priceRaw: string;
  decimals: number;
  timestamp: number;
  ageSec?: number | undefined;
  stale?: boolean | undefined;
  sourceKind: "stellar" | "other";
}

export interface Sep40OracleSnapshot {
  oracleContractId: ContractAddress;
  decimals: number;
  latestLedger?: number | undefined;
  prices: Record<string, Sep40PriceQuote>;
}

const CANONICAL_SEP40_ASSETS_PUBLIC: Record<string, { code: string; issuer: string }> = {
  USDC: { code: "USDC", issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN" },
  EURC: { code: "EURC", issuer: "GDHU6WRG4IEQXM5NZ4BMPKOXHW76MZM4Y2IEMFDVXBSDP6SJY4ITNPP2" },
  USDT0: { code: "USDT0", issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q" },
  USDT: { code: "USDT0", issuer: "GATISXX6BZ6NC7IKQBY37CJD4SOZL3CYZJWXEDG6JVIY4WBS6KXJHN6Q" },
  PYUSD: { code: "PYUSD", issuer: "GDQE7IXJ4HUHV6RQHIUPRJSEZE4DRS5WY577O2FY6YQ5LVWZ7JZTU2V5" },
  USDY: { code: "USDY", issuer: "GAJMPX5NBOG6TQFPQGRABJEEB2YE7RFRLUKJDZAZGAD5GFX4J7TADAZ6" },
  USDE: { code: "USDE", issuer: "GDJ5BNU5NN6NQ54D7OX6NQTUYNBZ42CAT33QGM5BIQ2QIYADAC5ICH47" },
  SUSDE: { code: "SUSDE", issuer: "GDJ5BNU5NN6NQ54D7OX6NQTUYNBZ42CAT33QGM5BIQ2QIYADAC5ICH47" },
  CETES: { code: "CETES", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },
  USTRY: { code: "USTRY", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },
  TESOURO: { code: "TESOURO", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },
  KTB: { code: "KTB", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },
  EUROB: { code: "EUROB", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },
  GILTS: { code: "GILTS", issuer: "GCRYUGD5NVARGXT56XEZI5CIFCQETYHAPQQTHO2O3IQZTHDH4LATMYWC" },
  MXNE: { code: "MXNe", issuer: "GCQCNWT22JDLENQAVIE6DRJGHWAQ6EX2H5ABGPV55EJUPPZM5UA7KHZR" },
  LIBRE: { code: "LIBRE", issuer: "GAYCCWKECNGDRHYU3UTREBD2XLC3CUQN6FV22TKM4WCQER3IWR7TF5CY" },
  XLMNR: { code: "xLMNR", issuer: "GDKA6WVMFSA73BMEVKPO6WXSSWP4MPRBDJVSXLLSEVIEVH226L5RJ7NL" },
  SVR: { code: "SVR", issuer: "GAGORNGHVJP5X2QO2NNIIDXKLNHVWJWXC5S73EZNCHOALGFTB2V25YGF" },
};

const CANONICAL_SEP40_ASSETS_TESTNET: Record<string, { code: string; issuer: string }> = {
  USDC: { code: "USDC", issuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5" },
};

function isMixedCaseSymbol(sym: string): boolean {
  return sym !== sym.toUpperCase() && sym !== sym.toLowerCase();
}

/**
 * Resolves a canonical Stellar Asset Contract (`C...`) ID for well-known SEP-40 feed symbols.
 */
export function resolveCanonicalSep40ContractId(
  symbol: string,
  networkPassphrase: string,
): string | undefined {
  const upper = symbol.trim().toUpperCase();
  if (!upper) return undefined;
  if (upper === "XLM" || upper === "NATIVE") {
    return Asset.native().contractId(networkPassphrase);
  }
  const table =
    networkPassphrase === Networks.PUBLIC
      ? CANONICAL_SEP40_ASSETS_PUBLIC
      : networkPassphrase === Networks.TESTNET
        ? CANONICAL_SEP40_ASSETS_TESTNET
        : undefined;
  const entry = table?.[upper];
  if (!entry) return undefined;
  try {
    return new Asset(entry.code, entry.issuer).contractId(networkPassphrase);
  } catch {
    return undefined;
  }
}

function readonlyOracleAddress(): string {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32));
}

/**
 * Encodes a SEP-40 `Asset` enum (`Asset::Stellar(Address)` | `Asset::Other(Symbol)`) into Soroban XDR `ScVal`.
 */
export function buildSep40AssetScVal(asset: Sep40AssetDescriptor): xdr.ScVal {
  if (asset.kind === "stellar") {
    const clean = asset.contractId.trim();
    if (!StrKey.isValidContract(clean)) {
      throw new Error(`Invalid Stellar contract ID for SEP-40 Asset::Stellar: ${asset.contractId}`);
    }
    return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Stellar"), new Address(clean).toScVal()]);
  }
  const trimmed = asset.symbol.trim();
  const sym = isMixedCaseSymbol(trimmed) ? trimmed : trimmed.toUpperCase();
  if (!sym || !/^[A-Za-z0-9_]{1,32}$/.test(sym)) {
    throw new Error(`Invalid SEP-40 Asset::Other symbol: ${asset.symbol}`);
  }
  return xdr.ScVal.scvVec([xdr.ScVal.scvSymbol("Other"), xdr.ScVal.scvSymbol(sym)]);
}

/**
 * Formats an `i128` fixed-point oracle integer into a decimal string using `decimals` precision.
 */
export function formatSep40FixedPrice(rawPrice: bigint, decimals: number): string {
  if (decimals <= 0) return rawPrice.toString();
  const negative = rawPrice < 0n;
  const abs = negative ? -rawPrice : rawPrice;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0");
  const trimmedFrac = frac.replace(/0+$/, "");
  const formattedFrac = trimmedFrac.length >= 2 ? trimmedFrac : frac.slice(0, Math.min(decimals, 4));
  return `${negative ? "-" : ""}${whole.toString()}.${formattedFrac}`;
}

/**
 * Decodes a SEP-40 `Option<PriceData>` (`{ price: i128, timestamp: u64 }`) `ScVal` return value.
 */
export function parseSep40PriceDataScVal(
  retval: xdr.ScVal | undefined,
  decimals: number,
  options?: { nowSec?: number | undefined; maxStalenessSec?: number | undefined },
): {
  priceUsd: number;
  priceFormatted: string;
  priceRaw: string;
  timestamp: number;
  ageSec: number;
  stale: boolean;
} | null {
  if (!retval) {
    return null;
  }
  let native: unknown;
  try {
    native = scValToNative(retval);
  } catch {
    return null;
  }
  if (!native || typeof native !== "object") {
    return null;
  }
  const record = native as Record<string, unknown>;
  const rawPriceVal = record.price;
  const rawTsVal = record.timestamp;
  if (rawPriceVal === undefined || rawPriceVal === null || rawTsVal === undefined || rawTsVal === null) {
    return null;
  }
  const priceBig = typeof rawPriceVal === "bigint" ? rawPriceVal : BigInt(String(rawPriceVal));
  const tsNum = typeof rawTsVal === "bigint" ? Number(rawTsVal) : Number(rawTsVal);
  const effectiveNow = options?.nowSec ?? Math.floor(Date.now() / 1000);
  if (priceBig <= 0n || !Number.isFinite(tsNum) || tsNum < 0 || tsNum > effectiveNow + 300) {
    return null;
  }
  const priceFormatted = formatSep40FixedPrice(priceBig, decimals);
  const priceUsd = Number(priceFormatted);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return null;
  }
  const timestamp = Math.trunc(tsNum);
  const ageSec = Math.max(0, effectiveNow - timestamp);
  const stale =
    options?.maxStalenessSec !== undefined ? ageSec > options.maxStalenessSec : false;
  return {
    priceUsd,
    priceFormatted,
    priceRaw: priceBig.toString(),
    timestamp,
    ageSec,
    stale,
  };
}

async function simulateReadOnlyContractCall(input: {
  server: rpc.Server;
  contractId: string;
  networkPassphrase: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<{ retval?: xdr.ScVal | undefined; latestLedger?: number | undefined }> {
  const sourceId = readonlyOracleAddress();
  const sourceAccount = new Account(sourceId, "0");
  const contract = new Contract(input.contractId);
  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(contract.call(input.method, ...input.args))
    .setTimeout(25)
    .build();

  const sim = await input.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`SEP-40 simulation error (${input.method}): ${sim.error}`);
  }
  return {
    retval: sim.result?.retval,
    latestLedger: sim.latestLedger,
  };
}

/**
 * Fetches live read-only prices from a SEP-40 compliant Soroban oracle (e.g., RedStone Push).
 */
export async function fetchSep40OraclePrices(input: {
  oracleContractId: ContractAddress;
  rpcUrls: readonly string[];
  networkPassphrase: string;
  assets: readonly Sep40PriceRequestAsset[];
  nowSec?: number | undefined;
  maxStalenessSec?: number | undefined;
}): Promise<Sep40OracleSnapshot> {
  if (!StrKey.isValidContract(input.oracleContractId)) {
    throw new Error("Invalid SEP-40 oracle contract ID");
  }
  const cleanUrls = input.rpcUrls.map((u) => u.trim()).filter(Boolean);
  if (cleanUrls.length === 0) {
    throw new Error("At least one Soroban RPC URL is required");
  }
  const uniqueAssets = input.assets.slice(0, 16);
  let lastError: unknown;

  for (const rpcUrl of cleanUrls) {
    const server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
    try {
      const decSim = await simulateReadOnlyContractCall({
        server,
        contractId: input.oracleContractId,
        networkPassphrase: input.networkPassphrase,
        method: "decimals",
        args: [],
      });
      const decodedDec = decSim.retval ? Number(scValToNative(decSim.retval)) : 14;
      const decimals =
        Number.isInteger(decodedDec) && decodedDec >= 0 && decodedDec <= 18 ? decodedDec : 14;

      let latestLedger = decSim.latestLedger;
      const entries = await Promise.all(
        uniqueAssets.map(async (item): Promise<Sep40PriceQuote | null> => {
          const candidates: Array<{ desc: Sep40AssetDescriptor; kind: "stellar" | "other" }> = [];
          const explicitContractId =
            item.contractId && StrKey.isValidContract(item.contractId.trim())
              ? item.contractId.trim()
              : item.symbol && item.symbol.trim()
                ? resolveCanonicalSep40ContractId(item.symbol, input.networkPassphrase)
                : undefined;
          if (explicitContractId) {
            candidates.push({
              desc: { kind: "stellar", contractId: explicitContractId },
              kind: "stellar",
            });
          }
          if (item.symbol && item.symbol.trim()) {
            const rawSym = item.symbol.trim();
            const upperSym = rawSym.toUpperCase();
            if (isMixedCaseSymbol(rawSym)) {
              candidates.push({ desc: { kind: "other", symbol: rawSym }, kind: "other" });
              if (upperSym !== rawSym) {
                candidates.push({ desc: { kind: "other", symbol: upperSym }, kind: "other" });
              }
            } else {
              candidates.push({ desc: { kind: "other", symbol: upperSym }, kind: "other" });
            }
          }
          for (const candidate of candidates) {
            try {
              const sim = await simulateReadOnlyContractCall({
                server,
                contractId: input.oracleContractId,
                networkPassphrase: input.networkPassphrase,
                method: "lastprice",
                args: [buildSep40AssetScVal(candidate.desc)],
              });
              if (sim.latestLedger && (!latestLedger || sim.latestLedger > latestLedger)) {
                latestLedger = sim.latestLedger;
              }
              const parsed = parseSep40PriceDataScVal(sim.retval, decimals, {
                nowSec: input.nowSec,
                maxStalenessSec: input.maxStalenessSec,
              });
              if (parsed) {
                return {
                  key: item.key,
                  ...parsed,
                  decimals,
                  sourceKind: candidate.kind,
                };
              }
            } catch {
              // Try next descriptor variant if asset isn't registered under this enum branch
            }
          }
          return null;
        }),
      );

      const prices: Record<string, Sep40PriceQuote> = {};
      for (const quote of entries) {
        if (quote) {
          prices[quote.key] = quote;
        }
      }

      return {
        oracleContractId: input.oracleContractId,
        decimals,
        latestLedger,
        prices,
      };
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("All Soroban RPC endpoints failed");
}
