export interface SimulatedSorobanResult {
  ok: boolean;
  error?: string | undefined;
  minResourceFeeStroops: string;
  requiresProtocol23Restore: boolean;
  eventsCount: number;
}

interface RpcSimulateResponse {
  result?: {
    error?: string;
    minResourceFee?: string;
    events?: unknown[];
    restorePreamble?: {
      minResourceFee?: string;
      transactionData?: string;
    };
  };
  error?: {
    message?: string;
  };
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
        };
      }

      const requiresRestore = Boolean(res.restorePreamble?.transactionData);
      return {
        ok: true,
        minResourceFeeStroops: res.minResourceFee ?? "0",
        requiresProtocol23Restore: requiresRestore,
        eventsCount: res.events?.length ?? 0,
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
  };
}
