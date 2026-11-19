import {
  calculateAccountReserveSummary,
  type AssetBalance,
  type ClassicAddress,
  type MuxedAddress,
  type PwaConfig,
  type ServerConfig,
  type StellarAddress,
  type ZeroBalanceTrustline,
} from "@astrowallet/domain";
import {
  Asset,
  BASE_FEE,
  Horizon,
  Operation,
  TransactionBuilder,
  type Keypair,
  type xdr,
} from "@stellar/stellar-sdk";
import {
  buildChangeTrustOperation,
  buildClaimClaimableBalanceOperation,
  buildLumenWipeReclaimOperations,
  buildManageSellOfferOperation,
  buildStellarMemo,
  decodeMuxedAddress,
  type ClassicAssetInput,
  type TypedMemoInput,
} from "../classic/index.js";
import { assertFriendbotAllowed, createFailoverEndpoints } from "../network.js";

export interface StellarAccountState {
  funded: boolean;
  balances: AssetBalance[];
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  minReserveXlm: string;
  spendableXlm: string;
  reclaimableXlm: string;
  reclaimableTrustlines: readonly ZeroBalanceTrustline[];
}

export interface ClaimableBalanceRecord {
  id: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  amount: string;
  sponsor?: string | undefined;
  lastModifiedLedger: number;
}

export interface SdexOfferRecord {
  id: string;
  sellingAssetCode: string;
  sellingAssetIssuer?: string | undefined;
  buyingAssetCode: string;
  buyingAssetIssuer?: string | undefined;
  amount: string;
  price: string;
  lastModifiedLedger: number;
}

export interface RecentPaymentRecord {
  id: string;
  type: "payment" | "create_account" | "other";
  createdAt: string;
  txHash: string;
  from: string;
  to: string;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
}

export interface BuildAndSubmitPaymentInput {
  sourceKeypair: Keypair;
  destination: StellarAddress;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  memoText?: string | undefined;
  typedMemo?: TypedMemoInput | undefined;
}

export interface StellarClient {
  fetchAccountState(address: string): Promise<StellarAccountState>;
  fetchRecentPayments(address: string, limit?: number): Promise<RecentPaymentRecord[]>;
  fetchClaimableBalances(address: string, limit?: number): Promise<ClaimableBalanceRecord[]>;
  fetchOpenOffers(address: string, limit?: number): Promise<SdexOfferRecord[]>;
  fundWithFriendbot(address: string): Promise<{ funded: true }>;
  buildAndSubmitPayment(
    input: BuildAndSubmitPaymentInput,
  ): Promise<{ hash: string; ledger: number }>;
  submitChangeTrust(input: {
    sourceKeypair: Keypair;
    assetCode: string;
    assetIssuer: ClassicAddress;
    limit?: string | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  reclaimZeroBalanceTrustlines(input: {
    sourceKeypair: Keypair;
    trustlines: readonly ZeroBalanceTrustline[];
  }): Promise<{ hash: string; ledger: number; reclaimedXlm: string }>;
  claimClaimableBalance(input: {
    sourceKeypair: Keypair;
    balanceId: string;
  }): Promise<{ hash: string; ledger: number }>;
  submitSdexSellOffer(input: {
    sourceKeypair: Keypair;
    selling: ClassicAssetInput;
    buying: ClassicAssetInput;
    amount: string;
    price: string;
    offerId?: string | undefined;
  }): Promise<{ hash: string; ledger: number }>;
}

function isHorizonNotFound(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const maybe = err as { response?: { status?: number }; status?: number; message?: string };
  if (maybe.response?.status === 404 || maybe.status === 404) return true;
  if (typeof maybe.message === "string" && maybe.message.includes("Not Found")) return true;
  return false;
}

function normalizeBalanceLine(line: Horizon.HorizonApi.BalanceLine): AssetBalance | null {
  if (line.asset_type === "native") {
    return {
      assetCode: "XLM",
      balance: line.balance,
      isVerifiedAsset: true,
    };
  }
  if (line.asset_type === "credit_alphanum4" || line.asset_type === "credit_alphanum12") {
    return {
      assetCode: line.asset_code,
      assetIssuer: line.asset_issuer,
      balance: line.balance,
      isVerifiedAsset: false,
    };
  }
  return null;
}

function parseHorizonCanonicalAsset(raw: string): {
  assetCode: string;
  assetIssuer?: string | undefined;
} {
  if (raw === "native") {
    return { assetCode: "XLM" };
  }
  const [code, issuer] = raw.split(":");
  return {
    assetCode: code || "ASSET",
    assetIssuer: issuer,
  };
}

/**
 * Creates a live Horizon client driven strictly by validated environment configuration.
 */
export function createStellarClient(
  config: Pick<PwaConfig | ServerConfig, "network" | "networkPassphrase" | "horizonUrls" | "friendbotUrl">,
): StellarClient {
  const endpoints = createFailoverEndpoints(config.horizonUrls);

  async function withHorizonFailover<T>(
    fn: (server: Horizon.Server) => Promise<T>,
  ): Promise<T> {
    const urls = endpoints.list();
    let lastError: unknown;
    for (let i = 0; i < urls.length; i += 1) {
      const url = endpoints.current();
      const server = new Horizon.Server(url, {
        allowHttp: url.startsWith("http://"),
      });
      try {
        return await fn(server);
      } catch (err) {
        if (isHorizonNotFound(err)) {
          throw err;
        }
        lastError = err;
        endpoints.next();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All Horizon endpoints failed");
  }

  async function submitClassicOperations(
    sourceKeypair: Keypair,
    operations: readonly xdr.Operation[],
    memoInput?: TypedMemoInput,
  ): Promise<{ hash: string; ledger: number }> {
    const sourceAddress = sourceKeypair.publicKey();
    const sourceAccount = await withHorizonFailover((server) =>
      server.loadAccount(sourceAddress),
    );
    const builder = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: config.networkPassphrase,
    });

    for (const op of operations) {
      builder.addOperation(op);
    }

    if (memoInput && memoInput.kind !== "none") {
      builder.addMemo(buildStellarMemo(memoInput));
    }

    const tx = builder.setTimeout(60).build();
    tx.sign(sourceKeypair);
    const result = await withHorizonFailover((server) => server.submitTransaction(tx));
    return {
      hash: result.hash,
      ledger: result.ledger,
    };
  }

  async function fetchAccountState(address: string): Promise<StellarAccountState> {
    const lookupAddress = address.startsWith("M")
      ? decodeMuxedAddress(address as MuxedAddress).baseAddress
      : address;

    try {
      const account = await withHorizonFailover((server) => server.loadAccount(lookupAddress));
      const balances = account.balances
        .map(normalizeBalanceLine)
        .filter((b): b is AssetBalance => b !== null);

      const nativeLine = account.balances.find((b) => b.asset_type === "native") as
        | { balance: string; selling_liabilities?: string }
        | undefined;

      const reserve = calculateAccountReserveSummary({
        nativeBalanceXlm: nativeLine?.balance ?? "0",
        subentryCount: account.subentry_count,
        numSponsoring: account.num_sponsoring,
        numSponsored: account.num_sponsored,
        sellingLiabilitiesXlm: nativeLine?.selling_liabilities,
        balances,
      });

      return {
        funded: true,
        balances,
        subentryCount: reserve.subentryCount,
        numSponsoring: reserve.numSponsoring,
        numSponsored: reserve.numSponsored,
        minReserveXlm: reserve.minReserveXlm,
        spendableXlm: reserve.spendableXlm,
        reclaimableXlm: reserve.reclaimableXlm,
        reclaimableTrustlines: reserve.reclaimableTrustlines,
      };
    } catch (err) {
      if (isHorizonNotFound(err)) {
        return {
          funded: false,
          balances: [],
          subentryCount: 0,
          numSponsoring: 0,
          numSponsored: 0,
          minReserveXlm: "0.0",
          spendableXlm: "0.0000000",
          reclaimableXlm: "0.0",
          reclaimableTrustlines: [],
        };
      }
      throw err;
    }
  }

  async function fetchRecentPayments(
    address: string,
    limit = 10,
  ): Promise<RecentPaymentRecord[]> {
    try {
      const page = await withHorizonFailover((server) =>
        server.payments().forAccount(address).order("desc").limit(limit).call(),
      );

      return page.records.map((rec): RecentPaymentRecord => {
        if (rec.type === "payment") {
          const pay = rec as Horizon.HorizonApi.PaymentOperationResponse;
          return {
            id: pay.id,
            type: "payment",
            createdAt: pay.created_at,
            txHash: pay.transaction_hash,
            from: pay.from,
            to: pay.to,
            amount: pay.amount,
            assetCode: pay.asset_type === "native" ? "XLM" : (pay.asset_code ?? "ASSET"),
            assetIssuer: pay.asset_issuer,
          };
        }
        if (rec.type === "create_account") {
          const create = rec as Horizon.HorizonApi.CreateAccountOperationResponse;
          return {
            id: create.id,
            type: "create_account",
            createdAt: create.created_at,
            txHash: create.transaction_hash,
            from: create.funder,
            to: create.account,
            amount: create.starting_balance,
            assetCode: "XLM",
          };
        }
        return {
          id: rec.id,
          type: "other",
          createdAt: rec.created_at,
          txHash: rec.transaction_hash,
          from: rec.source_account,
          to: address,
          amount: "0",
          assetCode: "XLM",
        };
      });
    } catch (err) {
      if (isHorizonNotFound(err)) {
        return [];
      }
      throw err;
    }
  }

  async function fetchClaimableBalances(
    address: string,
    limit = 20,
  ): Promise<ClaimableBalanceRecord[]> {
    const lookupAddress = address.startsWith("M")
      ? decodeMuxedAddress(address as MuxedAddress).baseAddress
      : address;
    if (lookupAddress.startsWith("C")) {
      return [];
    }
    try {
      const page = await withHorizonFailover((server) =>
        server.claimableBalances().claimant(lookupAddress).limit(limit).call(),
      );
      return page.records.map((rec) => {
        const asset = parseHorizonCanonicalAsset(rec.asset);
        return {
          id: rec.id,
          assetCode: asset.assetCode,
          assetIssuer: asset.assetIssuer,
          amount: rec.amount,
          sponsor: rec.sponsor,
          lastModifiedLedger: rec.last_modified_ledger,
        };
      });
    } catch (err) {
      if (isHorizonNotFound(err)) {
        return [];
      }
      throw err;
    }
  }

  async function fetchOpenOffers(address: string, limit = 20): Promise<SdexOfferRecord[]> {
    const lookupAddress = address.startsWith("M")
      ? decodeMuxedAddress(address as MuxedAddress).baseAddress
      : address;
    if (lookupAddress.startsWith("C")) {
      return [];
    }
    try {
      const page = await withHorizonFailover((server) =>
        server.offers().forAccount(lookupAddress).limit(limit).call(),
      );
      return page.records.map((rec) => ({
        id: String(rec.id),
        sellingAssetCode:
          rec.selling.asset_type === "native" ? "XLM" : (rec.selling.asset_code ?? "ASSET"),
        sellingAssetIssuer: rec.selling.asset_issuer,
        buyingAssetCode:
          rec.buying.asset_type === "native" ? "XLM" : (rec.buying.asset_code ?? "ASSET"),
        buyingAssetIssuer: rec.buying.asset_issuer,
        amount: rec.amount,
        price: rec.price,
        lastModifiedLedger: rec.last_modified_ledger,
      }));
    } catch (err) {
      if (isHorizonNotFound(err)) {
        return [];
      }
      throw err;
    }
  }

  async function fundWithFriendbot(address: string): Promise<{ funded: true }> {
    const friendbotUrl = assertFriendbotAllowed(config);
    const target = `${friendbotUrl}?addr=${encodeURIComponent(address)}`;
    const response = await fetch(target, { method: "GET" });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Friendbot funding failed (${response.status}): ${text}`);
    }
    return { funded: true };
  }

  async function buildAndSubmitPayment(
    input: BuildAndSubmitPaymentInput,
  ): Promise<{ hash: string; ledger: number }> {
    const destAddress = input.destination;
    const isNativeXlm = input.assetCode === "XLM" && !input.assetIssuer;
    let useCreateAccount = false;

    if (destAddress.startsWith("M")) {
      const destState = await fetchAccountState(destAddress);
      if (!destState.funded) {
        throw new Error("Destination M... base account is unfunded on ledger");
      }
    } else if (isNativeXlm && !destAddress.startsWith("C")) {
      const destState = await fetchAccountState(destAddress);
      if (!destState.funded) {
        const numericAmount = Number(input.amount);
        if (!Number.isFinite(numericAmount) || numericAmount < 1) {
          throw new Error(
            "Destination Classic account is unfunded; initial activation requires at least 1 XLM",
          );
        }
        useCreateAccount = true;
      }
    }

    const asset = isNativeXlm
      ? Asset.native()
      : new Asset(input.assetCode, input.assetIssuer ?? "");

    const op = useCreateAccount
      ? Operation.createAccount({
          destination: destAddress,
          startingBalance: input.amount,
        })
      : Operation.payment({
          destination: destAddress,
          asset,
          amount: input.amount,
        });

    const memoInput: TypedMemoInput | undefined = input.typedMemo
      ? input.typedMemo
      : input.memoText && input.memoText.trim() !== ""
        ? { kind: "text", value: input.memoText.trim().slice(0, 28) }
        : undefined;

    return submitClassicOperations(input.sourceKeypair, [op], memoInput);
  }

  async function submitChangeTrust(input: {
    sourceKeypair: Keypair;
    assetCode: string;
    assetIssuer: ClassicAddress;
    limit?: string | undefined;
  }): Promise<{ hash: string; ledger: number }> {
    const op = buildChangeTrustOperation({
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      limit: input.limit,
    });
    return submitClassicOperations(input.sourceKeypair, [op]);
  }

  async function reclaimZeroBalanceTrustlines(input: {
    sourceKeypair: Keypair;
    trustlines: readonly ZeroBalanceTrustline[];
  }): Promise<{ hash: string; ledger: number; reclaimedXlm: string }> {
    const batch = input.trustlines.slice(0, 100);
    const ops = buildLumenWipeReclaimOperations(batch);
    const result = await submitClassicOperations(input.sourceKeypair, ops);
    return {
      ...result,
      reclaimedXlm: (batch.length * 0.5).toFixed(1),
    };
  }

  async function claimClaimableBalance(input: {
    sourceKeypair: Keypair;
    balanceId: string;
  }): Promise<{ hash: string; ledger: number }> {
    const op = buildClaimClaimableBalanceOperation(input.balanceId);
    return submitClassicOperations(input.sourceKeypair, [op]);
  }

  async function submitSdexSellOffer(input: {
    sourceKeypair: Keypair;
    selling: ClassicAssetInput;
    buying: ClassicAssetInput;
    amount: string;
    price: string;
    offerId?: string | undefined;
  }): Promise<{ hash: string; ledger: number }> {
    const op = buildManageSellOfferOperation({
      selling: input.selling,
      buying: input.buying,
      amount: input.amount,
      price: input.price,
      offerId: input.offerId,
    });
    return submitClassicOperations(input.sourceKeypair, [op]);
  }

  return {
    fetchAccountState,
    fetchRecentPayments,
    fetchClaimableBalances,
    fetchOpenOffers,
    fundWithFriendbot,
    buildAndSubmitPayment,
    submitChangeTrust,
    reclaimZeroBalanceTrustlines,
    claimClaimableBalance,
    submitSdexSellOffer,
  };
}
