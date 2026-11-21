import {
  calculateAccountReserveSummary,
  type AssetBalance,
  type ClassicAddress,
  type ContractAddress,
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
  rpc,
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
  resolveStellarAsset,
  type ClassicAssetInput,
  type TypedMemoInput,
} from "../classic/index.js";
import {
  buildClaimOperation,
  buildCreateClaimOperation,
  generateEphemeralClaimKey,
  signClaimEscrowPayload,
} from "../claim-escrow/index.js";
import { assertFriendbotAllowed, createFailoverEndpoints } from "../network.js";
import {
  buildSacTransferOperation,
  resolveSacContractId,
} from "../smart-account/index.js";

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
  submitPathPaymentStrictSend(input: {
    sourceKeypair: Keypair;
    sendAsset: ClassicAssetInput;
    sendAmount: string;
    destination?: StellarAddress | undefined;
    destAsset: ClassicAssetInput;
    destMin: string;
    path?: readonly ClassicAssetInput[] | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  submitManageData(input: {
    sourceKeypair: Keypair;
    name: string;
    value: string | null;
  }): Promise<{ hash: string; ledger: number }>;
  fundClaimEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string | undefined;
    expiresAtUnix: number;
    cancellable?: boolean | undefined;
  }): Promise<{
    hash: string;
    ledger: number;
    claimSecretSeedHex: string;
    expiresAtUnix: number;
  }>;
  claimFromEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    claimSecretSeedHex: string;
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

function decimalToStroops7(amount: string): bigint {
  const cleaned = amount.trim();
  if (!/^\d+(?:\.\d{1,7})?$/.test(cleaned)) {
    throw new Error("Amount must be a positive decimal with up to 7 fractional digits");
  }
  const [wholePart, fracPart = ""] = cleaned.split(".");
  const stroops =
    BigInt(wholePart ?? "0") * 10_000_000n + BigInt(fracPart.padEnd(7, "0"));
  if (stroops <= 0n) {
    throw new Error("Amount must be greater than zero");
  }
  return stroops;
}

async function resolveDynamicFeeStroops(server: Horizon.Server): Promise<string> {
  try {
    const stats = (await server.feeStats()) as {
      fee_charged?: { p90?: string; mode?: string };
    };
    const raw = Number(stats.fee_charged?.p90 ?? stats.fee_charged?.mode ?? BASE_FEE);
    const base = Number(BASE_FEE);
    if (!Number.isFinite(raw) || raw < base) {
      return BASE_FEE;
    }
    return String(Math.min(Math.trunc(raw), 50_000));
  } catch {
    return BASE_FEE;
  }
}

async function resolveSorobanInclusionFeeStroops(server: rpc.Server): Promise<string> {
  try {
    const stats = await server.getFeeStats();
    const raw = Number(
      stats.sorobanInclusionFee?.p90 ?? stats.sorobanInclusionFee?.mode ?? BASE_FEE,
    );
    const base = Number(BASE_FEE);
    if (!Number.isFinite(raw) || raw < base) {
      return BASE_FEE;
    }
    return String(Math.min(Math.trunc(raw), 50_000));
  } catch {
    return BASE_FEE;
  }
}

class NonRetryableSorobanError extends Error {}

const DEFAULT_SOROBAN_MAX_RESOURCE_FEE_STROOPS = 5_000_000n;
const accountSequenceQueues = new Map<string, Promise<unknown>>();

function enqueueAccountTx<T>(accountId: string, fn: () => Promise<T>): Promise<T> {
  const prev = accountSequenceQueues.get(accountId) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  const settled = next.then(
    () => undefined,
    () => undefined,
  );
  accountSequenceQueues.set(accountId, settled);
  void settled.then(() => {
    if (accountSequenceQueues.get(accountId) === settled) {
      accountSequenceQueues.delete(accountId);
    }
  });
  return next;
}

/**
 * Creates a live Horizon + Soroban RPC client driven strictly by validated environment configuration.
 */
export function createStellarClient(
  config: Pick<
    PwaConfig | ServerConfig,
    "network" | "networkPassphrase" | "horizonUrls" | "friendbotUrl"
  > & {
    rpcUrls?: readonly string[] | undefined;
    sorobanMaxResourceFeeStroops?: string | bigint | undefined;
    sorobanPollIntervalMs?: number | undefined;
    rpcServerFactory?: ((url: string) => rpc.Server) | undefined;
    horizonServerFactory?: ((url: string) => Horizon.Server) | undefined;
  },
): StellarClient {
  const endpoints = createFailoverEndpoints(config.horizonUrls);
  const rpcEndpoints = config.rpcUrls?.length
    ? createFailoverEndpoints(config.rpcUrls)
    : null;
  const maxResourceFeeStroops =
    typeof config.sorobanMaxResourceFeeStroops === "bigint"
      ? config.sorobanMaxResourceFeeStroops
      : typeof config.sorobanMaxResourceFeeStroops === "string" &&
          /^\d+$/.test(config.sorobanMaxResourceFeeStroops.trim())
        ? BigInt(config.sorobanMaxResourceFeeStroops.trim())
        : DEFAULT_SOROBAN_MAX_RESOURCE_FEE_STROOPS;
  const pollIntervalMs = config.sorobanPollIntervalMs ?? 1_000;

  async function withHorizonFailover<T>(
    fn: (server: Horizon.Server) => Promise<T>,
  ): Promise<T> {
    const urls = endpoints.list();
    let lastError: unknown;
    for (let i = 0; i < urls.length; i += 1) {
      const url = endpoints.current();
      const server = config.horizonServerFactory
        ? config.horizonServerFactory(url)
        : new Horizon.Server(url, {
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

  async function withRpcFailover<T>(
    fn: (server: rpc.Server) => Promise<T>,
  ): Promise<T> {
    if (!rpcEndpoints) {
      throw new Error("Soroban RPC URLs are required for smart contract operations");
    }
    const urls = rpcEndpoints.list();
    let lastError: unknown;
    for (let i = 0; i < urls.length; i += 1) {
      const url = rpcEndpoints.current();
      const server = config.rpcServerFactory
        ? config.rpcServerFactory(url)
        : new rpc.Server(url, {
            allowHttp: url.startsWith("http://"),
          });
      try {
        return await fn(server);
      } catch (err) {
        if (err instanceof NonRetryableSorobanError) {
          throw err;
        }
        lastError = err;
        rpcEndpoints.next();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All Soroban RPC endpoints failed");
  }

  async function submitClassicOperations(
    sourceKeypair: Keypair,
    operations: readonly xdr.Operation[],
    memoInput?: TypedMemoInput,
  ): Promise<{ hash: string; ledger: number }> {
    const sourceAddress = sourceKeypair.publicKey();
    return enqueueAccountTx(sourceAddress, async () => {
      const { sourceAccount, fee } = await withHorizonFailover(async (server) => {
        const [acc, dynamicFee] = await Promise.all([
          server.loadAccount(sourceAddress),
          resolveDynamicFeeStroops(server),
        ]);
        return { sourceAccount: acc, fee: dynamicFee };
      });
      const builder = new TransactionBuilder(sourceAccount, {
        fee,
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
    });
  }

  async function submitSorobanOperation(
    sourceKeypair: Keypair,
    operation: xdr.Operation,
    memoInput?: TypedMemoInput,
  ): Promise<{ hash: string; ledger: number }> {
    const sourceAddress = sourceKeypair.publicKey();
    return enqueueAccountTx(sourceAddress, async () => {
      const preparedTx = await withRpcFailover(async (server) => {
        const [sourceAccount, inclusionFee] = await Promise.all([
          server.getAccount(sourceAddress),
          resolveSorobanInclusionFeeStroops(server),
        ]);
        const builder = new TransactionBuilder(sourceAccount, {
          fee: inclusionFee,
          networkPassphrase: config.networkPassphrase,
        }).addOperation(operation);

        if (memoInput && memoInput.kind !== "none") {
          builder.addMemo(buildStellarMemo(memoInput));
        }

        const tx = builder.setTimeout(60).build();
        const sim = await server.simulateTransaction(tx);
        if (rpc.Api.isSimulationRestore(sim)) {
          throw new NonRetryableSorobanError(
            "Soroban archived state restore required before submission",
          );
        }
        if (rpc.Api.isSimulationError(sim)) {
          throw new NonRetryableSorobanError(`Soroban simulation failed: ${sim.error}`);
        }

        const simulatedResourceFee = BigInt(sim.minResourceFee || "0");
        if (simulatedResourceFee > maxResourceFeeStroops) {
          throw new NonRetryableSorobanError(
            `Soroban simulated resource fee (${simulatedResourceFee} stroops) exceeds limit (${maxResourceFeeStroops} stroops)`,
          );
        }

        return rpc.assembleTransaction(tx, sim).build();
      });

      // Assemble and sign exactly once before broadcasting across failover RPC nodes
      preparedTx.sign(sourceKeypair);

      return withRpcFailover(async (server) => {
        const sent = await server.sendTransaction(preparedTx);
        if (sent.status === "ERROR") {
          throw new NonRetryableSorobanError(`Soroban sendTransaction failed (${sent.hash})`);
        }

        let polled = await server.getTransaction(sent.hash);
        for (
          let i = 0;
          i < 18 && polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND;
          i += 1
        ) {
          if (pollIntervalMs > 0) {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
          }
          polled = await server.getTransaction(sent.hash);
        }

        if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new NonRetryableSorobanError(
            `Soroban transaction failed on ledger (${sent.hash})`,
          );
        }
        if (polled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
          throw new NonRetryableSorobanError(
            `Soroban transaction confirmation timed out (${sent.hash})`,
          );
        }

        return {
          hash: sent.hash,
          ledger: polled.ledger,
        };
      });
    });
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
        if (
          rec.type === "path_payment_strict_send" ||
          rec.type === "path_payment_strict_receive"
        ) {
          const pathRec = rec as unknown as {
            id: string;
            created_at: string;
            transaction_hash: string;
            from: string;
            to: string;
            amount: string;
            asset_type?: string;
            asset_code?: string;
            asset_issuer?: string;
          };
          return {
            id: pathRec.id,
            type: "payment",
            createdAt: pathRec.created_at,
            txHash: pathRec.transaction_hash,
            from: pathRec.from,
            to: pathRec.to,
            amount: pathRec.amount,
            assetCode:
              pathRec.asset_type === "native" ? "XLM" : (pathRec.asset_code ?? "ASSET"),
            assetIssuer: pathRec.asset_issuer,
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

    const memoInput: TypedMemoInput | undefined = input.typedMemo
      ? input.typedMemo
      : input.memoText && input.memoText.trim() !== ""
        ? { kind: "text", value: input.memoText.trim().slice(0, 28) }
        : undefined;

    if (destAddress.startsWith("C")) {
      const sacContractId = resolveSacContractId({
        assetCode: input.assetCode,
        assetIssuer: input.assetIssuer,
        networkPassphrase: config.networkPassphrase,
      });
      const sacOp = buildSacTransferOperation({
        sacContractId,
        fromAddress: input.sourceKeypair.publicKey() as ClassicAddress,
        toAddress: destAddress,
        amountStroops: decimalToStroops7(input.amount),
      });
      return submitSorobanOperation(input.sourceKeypair, sacOp, memoInput);
    }

    if (destAddress.startsWith("M")) {
      const destState = await fetchAccountState(destAddress);
      if (!destState.funded) {
        throw new Error("Destination M... base account is unfunded on ledger");
      }
    } else if (isNativeXlm) {
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

  async function submitPathPaymentStrictSend(input: {
    sourceKeypair: Keypair;
    sendAsset: ClassicAssetInput;
    sendAmount: string;
    destination?: StellarAddress | undefined;
    destAsset: ClassicAssetInput;
    destMin: string;
    path?: readonly ClassicAssetInput[] | undefined;
  }): Promise<{ hash: string; ledger: number }> {
    const sendAsset = resolveStellarAsset(input.sendAsset);
    const destAsset = resolveStellarAsset(input.destAsset);
    const path = (input.path ?? []).map((hop) => resolveStellarAsset(hop));
    const op = Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount: input.sendAmount,
      destination: input.destination ?? input.sourceKeypair.publicKey(),
      destAsset,
      destMin: input.destMin,
      path,
    });
    return submitClassicOperations(input.sourceKeypair, [op]);
  }

  async function submitManageData(input: {
    sourceKeypair: Keypair;
    name: string;
    value: string | null;
  }): Promise<{ hash: string; ledger: number }> {
    const cleanName = input.name.trim();
    if (!cleanName || new TextEncoder().encode(cleanName).length > 64) {
      throw new Error("ManageData key name must be 1 to 64 UTF-8 bytes");
    }
    const op = Operation.manageData({
      name: cleanName,
      value: input.value,
    });
    return submitClassicOperations(input.sourceKeypair, [op]);
  }

  async function fundClaimEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string | undefined;
    expiresAtUnix: number;
    cancellable?: boolean | undefined;
  }): Promise<{
    hash: string;
    ledger: number;
    claimSecretSeedHex: string;
    expiresAtUnix: number;
  }> {
    const ephemeral = generateEphemeralClaimKey();
    const tokenContractId = resolveSacContractId({
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      networkPassphrase: config.networkPassphrase,
    });
    const op = buildCreateClaimOperation({
      escrowContractId: input.escrowContractId,
      claimIdHex: input.claimIdHex,
      senderAddress: input.sourceKeypair.publicKey() as ClassicAddress,
      tokenContractId,
      amountStroops: decimalToStroops7(input.amount),
      claimPubkeyHex: ephemeral.publicKeyHex,
      expiresAtUnix: input.expiresAtUnix,
      cancellable: input.cancellable,
    });
    const res = await submitSorobanOperation(input.sourceKeypair, op);
    return {
      ...res,
      claimSecretSeedHex: ephemeral.secretSeedHex,
      expiresAtUnix: input.expiresAtUnix,
    };
  }

  async function claimFromEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    claimSecretSeedHex: string;
  }): Promise<{ hash: string; ledger: number }> {
    const recipientAddress = input.sourceKeypair.publicKey() as ClassicAddress;
    const signatureHex = signClaimEscrowPayload(
      input.claimSecretSeedHex,
      input.escrowContractId,
      input.claimIdHex,
      recipientAddress,
    );
    const op = buildClaimOperation({
      escrowContractId: input.escrowContractId,
      claimIdHex: input.claimIdHex,
      recipientAddress,
      signatureHex,
    });
    return submitSorobanOperation(input.sourceKeypair, op);
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
    submitPathPaymentStrictSend,
    submitManageData,
    fundClaimEscrow,
    claimFromEscrow,
  };
}
