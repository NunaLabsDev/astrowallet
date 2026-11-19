import { StellarAddressSchema, type BalanceDiff, type StellarAddress } from "@astrowallet/domain";

export interface SimulatedSorobanResult {
  ok: boolean;
  error?: string | undefined;
  minResourceFeeStroops: string;
  requiresProtocol23Restore: boolean;
  eventsCount: number;
  balanceDiffs: BalanceDiff[];
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

function extractBalanceFromStateEntry(entry: unknown): {
  address?: string | undefined;
  amount?: bigint | undefined;
} | null {
  if (!entry || typeof entry !== "object") return null;
  const obj = entry as Record<string, unknown>;

  // Handle JSON-formatted ledger entry balance shapes defensively
  const balanceVal =
    typeof obj.amount === "string" || typeof obj.amount === "number" || typeof obj.amount === "bigint"
      ? BigInt(obj.amount)
      : typeof obj.balance === "string" || typeof obj.balance === "number" || typeof obj.balance === "bigint"
        ? BigInt(obj.balance)
        : undefined;

  const addrVal =
    typeof obj.address === "string"
      ? obj.address
      : typeof obj.accountId === "string"
        ? obj.accountId
        : undefined;

  if (balanceVal === undefined) return null;
  return { address: addrVal, amount: balanceVal };
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

    const sign = delta > 0n ? "+" : "-";
    const abs = delta > 0n ? delta : -delta;
    const whole = abs / 10_000_000n;
    const frac = (abs % 10_000_000n).toString().padStart(7, "0");

    diffs.push({
      address: parsedAddr.data as StellarAddress,
      assetCode: "XLM",
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
      return {
        ok: true,
        minResourceFeeStroops: res.minResourceFee ?? "0",
        requiresProtocol23Restore: requiresRestore,
        eventsCount: res.events?.length ?? 0,
        balanceDiffs: parseStateChangeBalanceDiffs(res.stateChanges),
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
