import {
  Account,
  Address,
  BASE_FEE,
  Contract,
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
  sourceKind: "stellar" | "other";
}

export interface Sep40OracleSnapshot {
  oracleContractId: ContractAddress;
  decimals: number;
  latestLedger?: number | undefined;
  prices: Record<string, Sep40PriceQuote>;
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
  const sym = asset.symbol.trim();
  if (!sym || sym.length > 32) {
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
): { priceUsd: number; priceFormatted: string; priceRaw: string; timestamp: number } | null {
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
  if (priceBig <= 0n || !Number.isFinite(tsNum) || tsNum < 0) {
    return null;
  }
  const priceFormatted = formatSep40FixedPrice(priceBig, decimals);
  const priceUsd = Number(priceFormatted);
  if (!Number.isFinite(priceUsd) || priceUsd <= 0) {
    return null;
  }
  return {
    priceUsd,
    priceFormatted,
    priceRaw: priceBig.toString(),
    timestamp: Math.trunc(tsNum),
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
          if (item.contractId && StrKey.isValidContract(item.contractId.trim())) {
            candidates.push({
              desc: { kind: "stellar", contractId: item.contractId.trim() },
              kind: "stellar",
            });
          }
          if (item.symbol && item.symbol.trim()) {
            candidates.push({
              desc: { kind: "other", symbol: item.symbol.trim() },
              kind: "other",
            });
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
              const parsed = parseSep40PriceDataScVal(sim.retval, decimals);
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
