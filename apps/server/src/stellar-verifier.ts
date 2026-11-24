import { FeeBumpTransaction, TransactionBuilder } from "@stellar/stellar-sdk";
import { resolveSwapAssetSacId } from "@astrowallet/defi";
import {
  calculateAccountReserveSummary,
  type AccountReserveSummary,
  type ServerConfig,
} from "@astrowallet/domain";
import {
  decodeTransactionEnvelope,
  extractBaseDestination,
} from "@astrowallet/security-shield";

export type FetchLike = typeof fetch;

export interface LiveBalanceEntry {
  assetCode: string;
  assetIssuer?: string | undefined;
  balance: string;
}

export interface LiveAccountBalancesResult {
  funded: boolean;
  balances: LiveBalanceEntry[];
}

export interface LiveAccountReserveInfo {
  funded: boolean;
  summary?: AccountReserveSummary | undefined;
}

export interface IncomingPaymentEvent {
  pagingToken: string;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  createdAt?: string | undefined;
}

export type TxVerificationResult =
  | { confirmed: true; ledger: number }
  | { confirmed: false; reason: string };

/** Intent-derived expectations a confirmed transaction must satisfy (anti-spoof / anti-replay). */
export interface ExpectedTxMatch {
  destination?: string | undefined;
  amount?: string | undefined;
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  memo?: string | undefined;
  minCreatedAtUnix?: number | undefined;
  allowSorobanRpcFallback?: boolean | undefined;
  expectedSourceAccount?: string | undefined;
  expectedTxHash?: string | undefined;
  expectedActionType?: "swap" | "reclaim_reserve" | undefined;
  /** Requires a Soroban `invokeHostFunction` on `contractId.functionName` (optionally with first arg hex & escrow params). */
  sorobanInvoke?:
    | {
        contractId: string;
        functionName: string;
        firstArgHex?: string | undefined;
        expectedTokenContractId?: string | undefined;
        expectedAmount?: string | undefined;
        expectedAssetCode?: string | undefined;
        expectedAssetIssuer?: string | undefined;
        networkPassphrase?: string | undefined;
      }
    | undefined;
}

interface HorizonBalanceJson {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  selling_liabilities?: string;
}

interface HorizonAccountJson {
  subentry_count?: number;
  num_sponsoring?: number;
  num_sponsored?: number;
  balances?: HorizonBalanceJson[];
}

interface HorizonTxJson {
  successful?: boolean;
  ledger?: number;
  created_at?: string;
  memo?: string;
  memo_type?: string;
  envelope_xdr?: string;
}

interface NormalizedTx {
  ledger: number;
  createdAtUnix?: number | undefined;
  memo?: string | undefined;
  envelopeXdr?: string | undefined;
}

interface HorizonOpRecordJson {
  type?: string;
  to?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

interface HorizonPaymentRecordJson {
  paging_token?: string;
  transaction_hash?: string;
  created_at?: string;
  type?: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
  asset_issuer?: string;
}

async function fetchFromHorizonFailover(
  horizonUrls: readonly string[],
  path: string,
  fetchFn: FetchLike,
  opts?: { retryOn404?: boolean },
): Promise<Response> {
  let lastError: unknown;
  let lastNotFoundResponse: Response | null = null;
  for (const base of horizonUrls) {
    const cleanBase = base.replace(/\/+$/, "");
    try {
      const response = await fetchFn(`${cleanBase}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(8_000),
      });
      if (response.ok) {
        return response;
      }
      if (response.status === 404) {
        if (!opts?.retryOn404) {
          return response;
        }
        lastNotFoundResponse = response;
        continue;
      }
      lastError = new Error(`Horizon returned HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  if (lastNotFoundResponse) {
    return lastNotFoundResponse;
  }
  throw lastError instanceof Error ? lastError : new Error("All Horizon endpoints failed");
}

export async function fetchLiveAccountBalances(
  config: Pick<ServerConfig, "horizonUrls">,
  address: string,
  fetchFn: FetchLike = fetch,
): Promise<LiveAccountBalancesResult> {
  const response = await fetchFromHorizonFailover(
    config.horizonUrls,
    `/accounts/${encodeURIComponent(address)}`,
    fetchFn,
  );
  if (response.status === 404) {
    return { funded: false, balances: [] };
  }

  const data = (await response.json()) as HorizonAccountJson;
  const balances: LiveBalanceEntry[] = [];
  for (const item of data.balances ?? []) {
    if (item.asset_type === "native") {
      balances.push({ assetCode: "XLM", balance: item.balance });
    } else if (item.asset_code) {
      balances.push({
        assetCode: item.asset_code,
        assetIssuer: item.asset_issuer,
        balance: item.balance,
      });
    }
  }
  return { funded: true, balances };
}

export async function fetchLiveAccountReserveInfo(
  config: Pick<ServerConfig, "horizonUrls">,
  address: string,
  fetchFn: FetchLike = fetch,
): Promise<LiveAccountReserveInfo> {
  const response = await fetchFromHorizonFailover(
    config.horizonUrls,
    `/accounts/${encodeURIComponent(address)}`,
    fetchFn,
  );
  if (response.status === 404) {
    return { funded: false };
  }

  const data = (await response.json()) as HorizonAccountJson;
  const rawBalances = data.balances ?? [];
  const native = rawBalances.find((b) => b.asset_type === "native");
  const normalizedBalances = rawBalances.map((item) => ({
    assetCode: item.asset_type === "native" ? "XLM" : (item.asset_code ?? "ASSET"),
    assetIssuer: item.asset_issuer,
    balance: item.balance,
  }));

  const summary = calculateAccountReserveSummary({
    nativeBalanceXlm: native?.balance ?? "0",
    subentryCount: data.subentry_count ?? 0,
    numSponsoring: data.num_sponsoring ?? 0,
    numSponsored: data.num_sponsored ?? 0,
    sellingLiabilitiesXlm: native?.selling_liabilities,
    balances: normalizedBalances,
  });

  return { funded: true, summary };
}

function decimalToStroops(amount: string): bigint | null {
  const cleaned = amount.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleaned)) return null;
  const [whole, frac = ""] = cleaned.split(".");
  return BigInt(whole ?? "0") * 10_000_000n + BigInt(frac.padEnd(7, "0"));
}

function opMatchesExpectation(op: HorizonOpRecordJson, expected: ExpectedTxMatch): boolean {
  const wantedDest = expected.destination ? extractBaseDestination(expected.destination) : undefined;
  const wantedStroops = expected.amount ? decimalToStroops(expected.amount) : null;
  const wantedCode = (expected.assetCode ?? "XLM").toUpperCase();
  const isNativeWanted = wantedCode === "XLM" && !expected.assetIssuer;

  let dest: string | undefined;
  let amount: string | undefined;
  let native = false;
  let code: string | undefined;
  let issuer: string | undefined;

  if (
    op.type === "payment" ||
    op.type === "path_payment_strict_send" ||
    op.type === "path_payment_strict_receive"
  ) {
    dest = op.to;
    amount = op.amount;
    native = op.asset_type === "native";
    code = op.asset_code;
    issuer = op.asset_issuer;
  } else if (op.type === "create_account") {
    dest = op.account;
    amount = op.starting_balance;
    native = true;
  } else {
    return false;
  }

  if (wantedDest && dest !== wantedDest) return false;
  if (isNativeWanted) {
    if (!native) return false;
  } else {
    if (native) return false;
    if ((code ?? "").toUpperCase() !== wantedCode) return false;
    if (expected.assetIssuer && issuer !== expected.assetIssuer) return false;
  }
  if (wantedStroops !== null) {
    const got = amount ? decimalToStroops(amount) : null;
    if (got === null || got < wantedStroops) return false;
  }
  return true;
}

async function fetchSorobanTx(
  rpcUrls: readonly string[],
  txHash: string,
  fetchFn: FetchLike,
): Promise<{ failed: true; reason: string } | { failed: false; tx: NormalizedTx } | null> {
  let sawNotFound = false;
  for (const rpcUrl of rpcUrls) {
    try {
      const res = await fetchFn(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: AbortSignal.timeout(8_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTransaction",
          params: { hash: txHash },
        }),
      });
      if (!res.ok) continue;
      const body = (await res.json()) as {
        result?: {
          status?: string;
          ledger?: number;
          createdAt?: string;
          envelopeXdr?: string;
        };
      };
      const status = body.result?.status;
      if (status === "SUCCESS") {
        const created = body.result?.createdAt ? Number(body.result.createdAt) : Number.NaN;
        return {
          failed: false,
          tx: {
            ledger: body.result?.ledger ?? 0,
            createdAtUnix: Number.isFinite(created) ? created : undefined,
            envelopeXdr: body.result?.envelopeXdr,
          },
        };
      }
      if (status === "FAILED") {
        return { failed: true, reason: "Transaction failed on-chain" };
      }
      sawNotFound = true;
    } catch {
      continue;
    }
  }
  if (sawNotFound) {
    return { failed: true, reason: "Transaction not found yet" };
  }
  return null;
}

export async function verifyTransactionConfirmed(
  config: Pick<ServerConfig, "horizonUrls"> & {
    rpcUrls?: readonly string[] | undefined;
    networkPassphrase?: string | undefined;
  },
  txHash: string,
  fetchFn: FetchLike = fetch,
  expected?: ExpectedTxMatch,
): Promise<TxVerificationResult> {
  const response = await fetchFromHorizonFailover(
    config.horizonUrls,
    `/transactions/${encodeURIComponent(txHash)}`,
    fetchFn,
    { retryOn404: true },
  );

  let tx: NormalizedTx;
  let horizonSourced = false;
  if (response.status === 404) {
    if (expected?.allowSorobanRpcFallback && config.rpcUrls?.length) {
      const soroban = await fetchSorobanTx(config.rpcUrls, txHash, fetchFn);
      if (soroban?.failed) return { confirmed: false, reason: soroban.reason };
      if (soroban && !soroban.failed) {
        tx = soroban.tx;
      } else {
        return { confirmed: false, reason: "Transaction not found on Horizon yet" };
      }
    } else {
      return { confirmed: false, reason: "Transaction not found on Horizon yet" };
    }
  } else {
    const raw = (await response.json()) as HorizonTxJson;
    if (raw.successful !== true) {
      return { confirmed: false, reason: "Transaction failed on-chain" };
    }
    horizonSourced = true;
    const createdMs = raw.created_at ? Date.parse(raw.created_at) : Number.NaN;
    tx = {
      ledger: raw.ledger ?? 0,
      createdAtUnix: Number.isFinite(createdMs) ? Math.floor(createdMs / 1000) : undefined,
      memo: raw.memo,
      envelopeXdr: raw.envelope_xdr,
    };
  }

  if (expected?.minCreatedAtUnix !== undefined) {
    if (tx.createdAtUnix === undefined) {
      return { confirmed: false, reason: "Transaction timestamp unavailable" };
    }
    if (tx.createdAtUnix < expected.minCreatedAtUnix - 120) {
      return {
        confirmed: false,
        reason: "Transaction predates this intent (replay of a historical tx hash rejected)",
      };
    }
  }

  let cachedDecoded: ReturnType<typeof decodeTransactionEnvelope> | null | undefined;
  const getDecodedEnvelope = (): ReturnType<typeof decodeTransactionEnvelope> | null => {
    if (cachedDecoded !== undefined) return cachedDecoded;
    if (!tx.envelopeXdr || !config.networkPassphrase) {
      cachedDecoded = null;
      return null;
    }
    try {
      cachedDecoded = decodeTransactionEnvelope(tx.envelopeXdr, config.networkPassphrase);
    } catch {
      cachedDecoded = null;
    }
    return cachedDecoded;
  };

  if (expected?.memo !== undefined && expected.memo !== "") {
    const resolvedMemo = tx.memo ?? getDecodedEnvelope()?.memo;
    if (resolvedMemo !== expected.memo) {
      return { confirmed: false, reason: "Transaction memo does not match the intent memo" };
    }
  }

  if (expected?.sorobanInvoke) {
    if (!tx.envelopeXdr || !config.networkPassphrase) {
      return { confirmed: false, reason: "Unable to inspect Soroban invocation for this transaction" };
    }
    const invokeSpec = expected.sorobanInvoke;
    const expectedTokenId =
      invokeSpec.expectedTokenContractId ??
      (invokeSpec.expectedAssetCode
        ? resolveSwapAssetSacId(
            invokeSpec.expectedAssetIssuer
              ? `${invokeSpec.expectedAssetCode}:${invokeSpec.expectedAssetIssuer}`
              : invokeSpec.expectedAssetCode,
            config.networkPassphrase,
          )
        : undefined);
    const expectedStroops = invokeSpec.expectedAmount
      ? decimalToStroops(invokeSpec.expectedAmount)
      : null;

    let matched = false;
    const decoded = getDecodedEnvelope();
    if (decoded) {
      matched = decoded.operations.some((op) => {
        const s = op.soroban;
        if (!s) return false;
        const fnMatched =
          invokeSpec.functionName === "refund_expired"
            ? s.functionName === "refund_expired" || s.functionName === "refund_expired_to"
            : s.functionName === invokeSpec.functionName;
        if (s.contractId !== invokeSpec.contractId || !fnMatched) {
          return false;
        }
        if (
          invokeSpec.firstArgHex !== undefined &&
          s.args[0]?.toLowerCase() !== invokeSpec.firstArgHex.toLowerCase()
        ) {
          return false;
        }
        if (invokeSpec.functionName === "create_claim") {
          if (expectedTokenId && s.args[2] !== expectedTokenId) {
            return false;
          }
          if (expectedStroops !== null) {
            const rawAmt = s.args[3] ?? "";
            if (!/^\d+$/.test(rawAmt) || BigInt(rawAmt) < expectedStroops) {
              return false;
            }
          }
        }
        return true;
      });
    }
    if (!matched) {
      return {
        confirmed: false,
        reason: "Transaction does not invoke the expected escrow contract call for this intent",
      };
    }
  }

  if (expected?.expectedTxHash) {
    const targetHash = expected.expectedTxHash.trim().toLowerCase();
    if (txHash.trim().toLowerCase() !== targetHash) {
      if (!tx.envelopeXdr || !config.networkPassphrase) {
        return { confirmed: false, reason: "Transaction hash does not match expected unsignedXdr" };
      }
      try {
        const parsedEnv = TransactionBuilder.fromXDR(tx.envelopeXdr, config.networkPassphrase);
        const innerHash =
          parsedEnv instanceof FeeBumpTransaction
            ? Buffer.from(parsedEnv.innerTransaction.hash()).toString("hex").toLowerCase()
            : Buffer.from(parsedEnv.hash()).toString("hex").toLowerCase();
        if (innerHash !== targetHash) {
          return { confirmed: false, reason: "Confirmed transaction does not match expected XDR" };
        }
      } catch {
        return { confirmed: false, reason: "Unable to verify confirmed transaction hash against XDR" };
      }
    }
  }

  if (expected?.expectedSourceAccount) {
    if (!tx.envelopeXdr || !config.networkPassphrase) {
      return {
        confirmed: false,
        reason: "Unable to verify transaction source account (missing envelopeXdr)",
      };
    }
    const decoded = getDecodedEnvelope();
    if (!decoded) {
      return {
        confirmed: false,
        reason: "Failed to decode transaction envelope for source account verification",
      };
    }
    if (
      expected.expectedSourceAccount.startsWith("G") ||
      expected.expectedSourceAccount.startsWith("M")
    ) {
      const expectedBase = extractBaseDestination(expected.expectedSourceAccount);
      const matchesSource =
        decoded.sourceAccount === expectedBase ||
        decoded.operations.some((op) => op.source === expectedBase);
      if (!matchesSource) {
        return {
          confirmed: false,
          reason: `Transaction source account mismatch (expected ${expectedBase}, got ${decoded.sourceAccount})`,
        };
      }
    }
  }

  if (expected?.expectedActionType) {
    if (!tx.envelopeXdr || !config.networkPassphrase) {
      return {
        confirmed: false,
        reason: `Unable to verify transaction action type (${expected.expectedActionType})`,
      };
    }
    const decoded = getDecodedEnvelope();
    if (!decoded) {
      return {
        confirmed: false,
        reason: `Failed to decode transaction envelope for ${expected.expectedActionType} verification`,
      };
    }
    if (expected.expectedActionType === "reclaim_reserve") {
      if (!decoded.operations.some((op) => op.type === "changeTrust")) {
        return {
          confirmed: false,
          reason: "Reserve reclaim transaction does not contain a changeTrust operation",
        };
      }
    } else if (expected.expectedActionType === "swap") {
      const hasSwapOp = decoded.operations.some(
        (op) =>
          op.type === "pathPaymentStrictSend" ||
          op.type === "pathPaymentStrictReceive" ||
          op.type === "manageSellOffer" ||
          op.type === "manageBuyOffer" ||
          op.type === "createPassiveSellOffer" ||
          op.type === "invokeHostFunction",
      );
      if (!hasSwapOp) {
        return {
          confirmed: false,
          reason:
            "Swap transaction does not contain a swap, DEX offer, or Soroban contract operation",
        };
      }
    }
  }

  if (expected?.destination?.startsWith("C") && expected.amount !== undefined) {
    if (!tx.envelopeXdr || !config.networkPassphrase) {
      return {
        confirmed: false,
        reason: "Unable to verify Soroban SAC transfer destination and amount",
      };
    }
    const wantedStroops = decimalToStroops(expected.amount);
    if (wantedStroops === null) {
      return { confirmed: false, reason: "Invalid expected transfer amount" };
    }
    const expectedAsset = expected.assetIssuer
      ? `${expected.assetCode ?? "XLM"}:${expected.assetIssuer}`
      : (expected.assetCode ?? "XLM");
    const expectedSacId = resolveSwapAssetSacId(expectedAsset, config.networkPassphrase);

    let sacMatched = false;
    const decoded = getDecodedEnvelope();
    if (decoded) {
      sacMatched = decoded.operations.some((op) => {
        const s = op.soroban;
        if (!s || s.functionName !== "transfer" || s.contractId !== expectedSacId) {
          return false;
        }
        const toArg = s.args[1];
        const amtArg = s.args[2] ?? "";
        return (
          toArg === expected.destination &&
          /^\d+$/.test(amtArg) &&
          BigInt(amtArg) >= wantedStroops
        );
      });
    }
    if (!sacMatched) {
      return {
        confirmed: false,
        reason: "Transaction does not transfer the required SAC asset and amount to destination C...",
      };
    }
  }

  const checkOps =
    horizonSourced &&
    expected?.destination !== undefined &&
    expected.amount !== undefined &&
    !expected.destination.startsWith("C");
  if (checkOps && expected) {
    const opsRes = await fetchFromHorizonFailover(
      config.horizonUrls,
      `/transactions/${encodeURIComponent(txHash)}/operations?limit=50`,
      fetchFn,
      { retryOn404: true },
    );
    if (opsRes.status === 404) {
      return { confirmed: false, reason: "Transaction operations not found" };
    }
    const opsBody = (await opsRes.json()) as {
      _embedded?: { records?: HorizonOpRecordJson[] };
    };
    const records = opsBody._embedded?.records ?? [];
    if (!records.some((op) => opMatchesExpectation(op, expected))) {
      return {
        confirmed: false,
        reason: "Transaction does not pay the destination, asset and amount required by this intent",
      };
    }
  }

  return { confirmed: true, ledger: tx.ledger };
}

export interface IncomingPaymentsPollResult {
  incoming: IncomingPaymentEvent[];
  newestCursor?: string | undefined;
}

export async function fetchIncomingPaymentsSince(
  config: Pick<ServerConfig, "horizonUrls">,
  address: string,
  cursor?: string,
  limit = 5,
  fetchFn: FetchLike = fetch,
): Promise<IncomingPaymentsPollResult> {
  const query = new URLSearchParams({
    order: "asc",
    limit: String(limit),
  });
  if (cursor) {
    query.set("cursor", cursor);
  }

  const response = await fetchFromHorizonFailover(
    config.horizonUrls,
    `/accounts/${encodeURIComponent(address)}/payments?${query.toString()}`,
    fetchFn,
  );
  if (response.status === 404) {
    return { incoming: [] };
  }

  const payload = (await response.json()) as {
    _embedded?: { records?: HorizonPaymentRecordJson[] };
  };
  const records = payload._embedded?.records ?? [];
  const events: IncomingPaymentEvent[] = [];
  let newestCursor: string | undefined;

  for (const rec of records) {
    if (!rec.paging_token) continue;
    newestCursor = rec.paging_token;
    if (!rec.transaction_hash) continue;
    if (
      (rec.type === "payment" ||
        rec.type === "path_payment_strict_send" ||
        rec.type === "path_payment_strict_receive") &&
      rec.to === address &&
      rec.from &&
      rec.amount
    ) {
      events.push({
        pagingToken: rec.paging_token,
        txHash: rec.transaction_hash,
        from: rec.from,
        to: rec.to,
        amount: rec.amount,
        assetCode: rec.asset_type === "native" ? "XLM" : (rec.asset_code ?? "ASSET"),
        ...(rec.asset_type !== "native" && rec.asset_issuer
          ? { assetIssuer: rec.asset_issuer }
          : {}),
        ...(rec.created_at ? { createdAt: rec.created_at } : {}),
      });
    } else if (
      rec.type === "create_account" &&
      rec.account === address &&
      rec.funder &&
      rec.starting_balance
    ) {
      events.push({
        pagingToken: rec.paging_token,
        txHash: rec.transaction_hash,
        from: rec.funder,
        to: rec.account,
        amount: rec.starting_balance,
        assetCode: "XLM",
        ...(rec.created_at ? { createdAt: rec.created_at } : {}),
      });
    }
  }

  return { incoming: events, newestCursor };
}

/**
 * Fetches the newest payment/operation paging_token (`order=desc&limit=1`) so
 * newly linked or stale-cursor accounts seed at HEAD instead of replaying history.
 */
export async function fetchLatestPaymentCursor(
  config: Pick<ServerConfig, "horizonUrls">,
  address: string,
  fetchFn: FetchLike = fetch,
): Promise<string> {
  const query = new URLSearchParams({
    order: "desc",
    limit: "1",
  });
  const response = await fetchFromHorizonFailover(
    config.horizonUrls,
    `/accounts/${encodeURIComponent(address)}/payments?${query.toString()}`,
    fetchFn,
  );
  if (response.status === 404) {
    return "empty_init";
  }
  const payload = (await response.json()) as {
    _embedded?: { records?: HorizonPaymentRecordJson[] };
  };
  const latest = payload._embedded?.records?.[0]?.paging_token;
  return latest && latest.length > 0 ? latest : "empty_init";
}
