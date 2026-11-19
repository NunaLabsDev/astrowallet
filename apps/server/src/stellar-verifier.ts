import {
  calculateAccountReserveSummary,
  type AccountReserveSummary,
  type ServerConfig,
} from "@astrowallet/domain";

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
}

export type TxVerificationResult =
  | { confirmed: true; ledger: number }
  | { confirmed: false; reason: string };

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
}

interface HorizonPaymentRecordJson {
  paging_token?: string;
  transaction_hash?: string;
  type?: string;
  from?: string;
  to?: string;
  funder?: string;
  account?: string;
  amount?: string;
  starting_balance?: string;
  asset_type?: string;
  asset_code?: string;
}

async function fetchFromHorizonFailover(
  horizonUrls: readonly string[],
  path: string,
  fetchFn: FetchLike,
): Promise<Response> {
  let lastError: unknown;
  for (const base of horizonUrls) {
    const cleanBase = base.replace(/\/+$/, "");
    try {
      const response = await fetchFn(`${cleanBase}${path}`, {
        headers: { Accept: "application/json" },
      });
      if (response.status === 404 || response.ok) {
        return response;
      }
      lastError = new Error(`Horizon returned HTTP ${response.status}`);
    } catch (err) {
      lastError = err;
    }
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

export async function verifyTransactionConfirmed(
  config: Pick<ServerConfig, "horizonUrls">,
  txHash: string,
  fetchFn: FetchLike = fetch,
): Promise<TxVerificationResult> {
  const response = await fetchFromHorizonFailover(
    config.horizonUrls,
    `/transactions/${encodeURIComponent(txHash)}`,
    fetchFn,
  );
  if (response.status === 404) {
    return { confirmed: false, reason: "Transaction not found on Horizon yet" };
  }
  const tx = (await response.json()) as HorizonTxJson;
  if (tx.successful !== true) {
    return { confirmed: false, reason: "Transaction failed on-chain" };
  }
  return { confirmed: true, ledger: tx.ledger ?? 0 };
}

export async function fetchIncomingPaymentsSince(
  config: Pick<ServerConfig, "horizonUrls">,
  address: string,
  cursor?: string,
  limit = 5,
  fetchFn: FetchLike = fetch,
): Promise<IncomingPaymentEvent[]> {
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
    return [];
  }

  const payload = (await response.json()) as {
    _embedded?: { records?: HorizonPaymentRecordJson[] };
  };
  const records = payload._embedded?.records ?? [];
  const events: IncomingPaymentEvent[] = [];

  for (const rec of records) {
    if (!rec.paging_token || !rec.transaction_hash) continue;
    if (rec.type === "payment" && rec.to === address && rec.from && rec.amount) {
      events.push({
        pagingToken: rec.paging_token,
        txHash: rec.transaction_hash,
        from: rec.from,
        to: rec.to,
        amount: rec.amount,
        assetCode: rec.asset_type === "native" ? "XLM" : (rec.asset_code ?? "ASSET"),
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
      });
    }
  }

  return events;
}
