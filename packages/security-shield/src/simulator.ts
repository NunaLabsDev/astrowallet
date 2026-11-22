import { StrKey, TransactionBuilder, rpc, xdr } from "@stellar/stellar-sdk";
import { StellarAddressSchema, type BalanceDiff, type StellarAddress } from "@astrowallet/domain";

export interface SimulatedSorobanResult {
  ok: boolean;
  error?: string | undefined;
  minResourceFeeStroops: string;
  requiresProtocol23Restore: boolean;
  eventsCount: number;
  balanceDiffs: BalanceDiff[];
  assembledXdr?: string | undefined;
}

interface RawStateChange {
  type?: string;
  key?: string;
  before?: unknown;
  after?: unknown;
}

interface RpcSimulateResponse {
  result?: {
    error?: string;
    minResourceFee?: string;
    transactionData?: string;
    events?: unknown[];
    stateChanges?: RawStateChange[];
    restorePreamble?: {
      minResourceFee?: string;
      transactionData?: string;
    };
  };
  error?: {
    message?: string;
  };
}

interface ExtractedStateBalance {
  address?: string | undefined;
  amount?: bigint | undefined;
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
}

function decodeAsciiAssetCode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes).replace(/\0+$/, "").trim() || "UNKNOWN";
}

function tryBigInt(val: unknown): bigint | undefined {
  if (typeof val === "bigint") return val;
  if (typeof val === "number" && Number.isInteger(val)) return BigInt(val);
  if (typeof val === "string" && /^-?\d+$/.test(val.trim())) return BigInt(val.trim());
  return undefined;
}

function extractTrustlineAssetFromXdr(asset: xdr.TrustLineAsset): {
  assetCode: string;
  assetIssuer?: string | undefined;
} {
  if (asset.type === "assetTypeNative") {
    return { assetCode: "XLM" };
  }
  if (asset.type === "assetTypeCreditAlphanum4") {
    return {
      assetCode: decodeAsciiAssetCode(asset.alphaNum4.assetCode.toBytes()),
      assetIssuer: StrKey.encodeEd25519PublicKey(asset.alphaNum4.issuer.ed25519.toBytes()),
    };
  }
  if (asset.type === "assetTypeCreditAlphanum12") {
    return {
      assetCode: decodeAsciiAssetCode(asset.alphaNum12.assetCode.toBytes()),
      assetIssuer: StrKey.encodeEd25519PublicKey(asset.alphaNum12.issuer.ed25519.toBytes()),
    };
  }
  return { assetCode: "LP_SHARE" };
}

function extractBalanceFromStateEntry(entry: unknown): ExtractedStateBalance | null {
  if (typeof entry === "string") {
    const trimmed = entry.trim();
    if (!trimmed) return null;
    try {
      const parsed = xdr.LedgerEntry.fromXDR(trimmed, "base64");
      if (parsed.data.type === "account") {
        const account = parsed.data.account;
        return {
          address: StrKey.encodeEd25519PublicKey(account.accountId.ed25519.toBytes()),
          amount: BigInt(account.balance),
          assetCode: "XLM",
        };
      }
      if (parsed.data.type === "trustline") {
        const tl = parsed.data.trustLine;
        const assetInfo = extractTrustlineAssetFromXdr(tl.asset);
        return {
          address: StrKey.encodeEd25519PublicKey(tl.accountId.ed25519.toBytes()),
          amount: BigInt(tl.balance),
          assetCode: assetInfo.assetCode,
          assetIssuer: assetInfo.assetIssuer,
        };
      }
      return null;
    } catch {
      return null;
    }
  }

  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;

  // Support nested Soroban RPC xdrFormat="json" shapes: { data: { account / trustLine } }
  const dataObj =
    obj.data && typeof obj.data === "object" ? (obj.data as Record<string, unknown>) : obj;
  if (dataObj.account && typeof dataObj.account === "object") {
    const acc = dataObj.account as Record<string, unknown>;
    const bal = tryBigInt(acc.balance);
    if (bal !== undefined) {
      return {
        address: typeof acc.accountId === "string" ? acc.accountId : undefined,
        amount: bal,
        assetCode: "XLM",
      };
    }
  }
  if (dataObj.trustLine && typeof dataObj.trustLine === "object") {
    const tl = dataObj.trustLine as Record<string, unknown>;
    const bal = tryBigInt(tl.balance);
    if (bal !== undefined) {
      const assetObj =
        tl.asset && typeof tl.asset === "object" ? (tl.asset as Record<string, unknown>) : undefined;
      const alpha = (assetObj?.alphaNum4 ?? assetObj?.alphaNum12) as
        | { assetCode?: unknown; issuer?: unknown }
        | undefined;
      return {
        address: typeof tl.accountId === "string" ? tl.accountId : undefined,
        amount: bal,
        assetCode:
          assetObj?.native !== undefined
            ? "XLM"
            : typeof alpha?.assetCode === "string"
              ? alpha.assetCode
              : "UNKNOWN",
        assetIssuer: typeof alpha?.issuer === "string" ? alpha.issuer : undefined,
      };
    }
  }

  // Handle flat JSON-formatted balance shapes defensively without assuming XLM when asset is missing
  const balanceVal = tryBigInt(obj.amount) ?? tryBigInt(obj.balance);
  if (balanceVal === undefined) return null;

  const addrVal =
    typeof obj.address === "string"
      ? obj.address
      : typeof obj.accountId === "string"
        ? obj.accountId
        : undefined;

  const rawCode =
    typeof obj.assetCode === "string"
      ? obj.assetCode.trim()
      : obj.assetType === "native" || obj.isNative === true
        ? "XLM"
        : "UNKNOWN";
  const rawIssuer = typeof obj.assetIssuer === "string" ? obj.assetIssuer.trim() : undefined;

  return {
    address: addrVal,
    amount: balanceVal,
    assetCode: rawCode || "UNKNOWN",
    assetIssuer: rawIssuer,
  };
}

function parseStateChangeBalanceDiffs(
  stateChanges: readonly RawStateChange[] | undefined,
): BalanceDiff[] {
  if (!Array.isArray(stateChanges) || stateChanges.length === 0) {
    return [];
  }

  const diffs: BalanceDiff[] = [];
  for (const sc of stateChanges) {
    const beforeInfo = extractBalanceFromStateEntry(sc.before);
    const afterInfo = extractBalanceFromStateEntry(sc.after);
    const rawAddress = afterInfo?.address ?? beforeInfo?.address;
    const parsedAddr = rawAddress ? StellarAddressSchema.safeParse(rawAddress) : null;
    if (!parsedAddr?.success) continue;

    const beforeAmt = beforeInfo?.amount ?? 0n;
    const afterAmt = afterInfo?.amount ?? 0n;
    const delta = afterAmt - beforeAmt;
    if (delta === 0n) continue;

    const assetCode = afterInfo?.assetCode ?? beforeInfo?.assetCode ?? "UNKNOWN";
    const rawIssuer = afterInfo?.assetIssuer ?? beforeInfo?.assetIssuer;
    const parsedIssuer = rawIssuer ? StellarAddressSchema.safeParse(rawIssuer) : null;

    const sign = delta > 0n ? "+" : "-";
    const abs = delta > 0n ? delta : -delta;
    const whole = abs / 10_000_000n;
    const frac = (abs % 10_000_000n).toString().padStart(7, "0");

    diffs.push({
      address: parsedAddr.data as StellarAddress,
      assetCode,
      assetIssuer: parsedIssuer?.success ? (parsedIssuer.data as StellarAddress) : undefined,
      delta: `${sign}${whole.toString()}.${frac}`,
    });
  }
  return diffs;
}

/**
 * Calls Stellar Soroban JSON-RPC `simulateTransaction` across failover endpoints.
 */
export async function simulateSorobanTransaction(
  rpcUrls: readonly string[],
  xdrBase64: string,
  fetchFn: typeof fetch = fetch,
  networkPassphrase?: string,
): Promise<SimulatedSorobanResult> {
  let lastError: unknown;

  for (const rpcUrl of rpcUrls) {
    try {
      const response = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "simulateTransaction",
          params: {
            transaction: xdrBase64,
            xdrFormat: "json",
          },
        }),
      });
      if (!response.ok) {
        lastError = new Error(`Soroban RPC HTTP ${response.status}`);
        continue;
      }

      const data = (await response.json()) as RpcSimulateResponse;
      if (data.error) {
        return {
          ok: false,
          error: data.error.message ?? "RPC simulation error",
          minResourceFeeStroops: "0",
          requiresProtocol23Restore: false,
          eventsCount: 0,
          balanceDiffs: [],
        };
      }

      const res = data.result;
      if (!res || res.error) {
        return {
          ok: false,
          error: res?.error ?? "Empty simulation response",
          minResourceFeeStroops: "0",
          requiresProtocol23Restore: false,
          eventsCount: 0,
          balanceDiffs: [],
        };
      }

      const requiresRestore = Boolean(res.restorePreamble?.transactionData);
      let assembledXdr: string | undefined;
      if (networkPassphrase && typeof res.transactionData === "string") {
        try {
          const parsedTx = TransactionBuilder.fromXDR(xdrBase64, networkPassphrase);
          assembledXdr = rpc.assembleTransaction(parsedTx, res as never).build().toXDR();
        } catch {
          assembledXdr = undefined;
        }
      }
      return {
        ok: true,
        minResourceFeeStroops: res.minResourceFee ?? "0",
        requiresProtocol23Restore: requiresRestore,
        eventsCount: res.events?.length ?? 0,
        balanceDiffs: parseStateChangeBalanceDiffs(res.stateChanges),
        ...(assembledXdr ? { assembledXdr } : {}),
      };
    } catch (err) {
      lastError = err;
    }
  }

  return {
    ok: false,
    error: lastError instanceof Error ? lastError.message : "All Soroban RPC endpoints failed",
    minResourceFeeStroops: "0",
    requiresProtocol23Restore: false,
    eventsCount: 0,
    balanceDiffs: [],
  };
}
