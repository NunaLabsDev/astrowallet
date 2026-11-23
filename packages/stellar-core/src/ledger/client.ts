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
  buildCancelClaimOperation,
  buildClaimOperation,
  buildCreateClaimOperation,
  buildExtendClaimTtlOperation,
  buildRefundExpiredOperation,
  buildRefundExpiredToOperation,
  generateEphemeralClaimKey,
  signClaimEscrowPayload,
} from "../claim-escrow/index.js";
import { assertFriendbotAllowed, createFailoverEndpoints } from "../network.js";
import {
  buildSacTransferOperation,
  resolveSacContractId,
} from "../smart-account/index.js";

export interface AccountSignerRecord {
  key: string;
  weight: number;
  type: string;
  sponsor?: string | undefined;
}

export interface AccountDataEntryRecord {
  key: string;
  value: string;
}

export interface LiquidityPoolReservePosition {
  assetCode: string;
  assetIssuer?: string | undefined;
  poolAmount: string;
  userAmount: string;
}

export interface LiquidityPoolSharePosition {
  poolId: string;
  sharesBalance: string;
  totalShares: string;
  totalTrustlines: number;
  sharePct: number;
  reserves: readonly LiquidityPoolReservePosition[];
}

export interface StellarAccountState {
  funded: boolean;
  balances: AssetBalance[];
  liquidityPoolPositions?: readonly LiquidityPoolSharePosition[] | undefined;
  subentryCount: number;
  numSponsoring: number;
  numSponsored: number;
  minReserveXlm: string;
  spendableXlm: string;
  reclaimableXlm: string;
  reclaimableTrustlines: readonly ZeroBalanceTrustline[];
  sequence?: string | undefined;
  lastModifiedLedger?: number | undefined;
  homeDomain?: string | undefined;
  sponsor?: string | undefined;
  thresholds?: { lowThreshold: number; medThreshold: number; highThreshold: number } | undefined;
  flags?:
    | {
        authRequired: boolean;
        authRevocable: boolean;
        authImmutable: boolean;
        authClawbackEnabled: boolean;
      }
    | undefined;
  signers?: readonly AccountSignerRecord[] | undefined;
  dataEntries?: readonly AccountDataEntryRecord[] | undefined;
}

export interface AccountTradeRecord {
  id: string;
  ledgerCloseTime: string;
  baseAssetCode: string;
  baseAssetIssuer?: string | undefined;
  baseAmount: string;
  counterAssetCode: string;
  counterAssetIssuer?: string | undefined;
  counterAmount: string;
  price: string;
  baseIsSeller: boolean;
  baseAccount?: string | undefined;
  counterAccount?: string | undefined;
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

export interface RelayIntentAuth {
  intentId: string;
  sig: string;
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
  fetchRecentTrades(address: string, limit?: number): Promise<AccountTradeRecord[]>;
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
    intentAuth?: RelayIntentAuth | undefined;
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
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  cancelClaimEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  refundExpiredClaimEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    recipientAddress?: StellarAddress | undefined;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  extendClaimEscrowTtl(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
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
  const raw = line as unknown as {
    asset_type?: string;
    asset_code?: string;
    asset_issuer?: string;
    balance: string;
    limit?: string;
    buying_liabilities?: string;
    selling_liabilities?: string;
    is_authorized?: boolean;
    is_authorized_to_maintain_liabilities?: boolean;
    is_clawback_enabled?: boolean;
    sponsor?: string;
    last_modified_ledger?: number;
  };
  if (raw.asset_type === "native") {
    return {
      assetCode: "XLM",
      balance: raw.balance,
      isVerifiedAsset: true,
      ...(raw.buying_liabilities ? { buyingLiabilities: raw.buying_liabilities } : {}),
      ...(raw.selling_liabilities ? { sellingLiabilities: raw.selling_liabilities } : {}),
    };
  }
  if (raw.asset_type === "credit_alphanum4" || raw.asset_type === "credit_alphanum12") {
    return {
      assetCode: raw.asset_code ?? "ASSET",
      assetIssuer: raw.asset_issuer,
      balance: raw.balance,
      isVerifiedAsset: false,
      ...(raw.limit ? { limit: raw.limit } : {}),
      ...(raw.buying_liabilities ? { buyingLiabilities: raw.buying_liabilities } : {}),
      ...(raw.selling_liabilities ? { sellingLiabilities: raw.selling_liabilities } : {}),
      ...(typeof raw.is_authorized === "boolean" ? { isAuthorized: raw.is_authorized } : {}),
      ...(typeof raw.is_authorized_to_maintain_liabilities === "boolean"
        ? { isAuthorizedToMaintainLiabilities: raw.is_authorized_to_maintain_liabilities }
        : {}),
      ...(typeof raw.is_clawback_enabled === "boolean"
        ? { isClawbackEnabled: raw.is_clawback_enabled }
        : {}),
      ...(raw.sponsor ? { sponsor: raw.sponsor } : {}),
      ...(typeof raw.last_modified_ledger === "number"
        ? { lastModifiedLedger: raw.last_modified_ledger }
        : {}),
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
    relaySubmitter?:
      | ((input: {
          signedTxXdrBase64: string;
          sourceKeypair: Keypair;
          intentAuth?: RelayIntentAuth | undefined;
        }) => Promise<{ hash: string; ledger?: number | undefined } | null>)
      | undefined;
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
    intentAuth?: RelayIntentAuth,
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

      if (config.relaySubmitter) {
        try {
          const relayed = await config.relaySubmitter({
            signedTxXdrBase64: preparedTx.toXDR(),
            sourceKeypair,
            intentAuth,
          });
          if (relayed && typeof relayed.hash === "string" && relayed.hash.trim().length > 0) {
            const relayedHash = relayed.hash.trim();
            if (typeof relayed.ledger === "number" && relayed.ledger > 0) {
              return { hash: relayedHash, ledger: relayed.ledger };
            }
            try {
              return await withRpcFailover(async (server) => {
                let polled = await server.getTransaction(relayedHash);
                for (
                  let i = 0;
                  i < 15 && polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND;
                  i += 1
                ) {
                  if (pollIntervalMs > 0) {
                    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
                  }
                  polled = await server.getTransaction(relayedHash);
                }
                if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
                  throw new NonRetryableSorobanError(
                    `Soroban relayed transaction failed on ledger (${relayedHash})`,
                  );
                }
                return {
                  hash: relayedHash,
                  ledger:
                    polled.status === rpc.Api.GetTransactionStatus.SUCCESS ? polled.ledger : 0,
                };
              });
            } catch (pollErr) {
              if (pollErr instanceof NonRetryableSorobanError) {
                throw pollErr;
              }
              return { hash: relayedHash, ledger: 0 };
            }
          }
        } catch (relayErr) {
          if (relayErr instanceof NonRetryableSorobanError) {
            throw relayErr;
          }
          // Fall back to direct Soroban RPC submission when relayer is unavailable
        }
      }

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

      const rawAccount = account as unknown as {
        sequence?: string;
        last_modified_ledger?: number;
        home_domain?: string;
        sponsor?: string;
        thresholds?: { low_threshold?: number; med_threshold?: number; high_threshold?: number };
        flags?: {
          auth_required?: boolean;
          auth_revocable?: boolean;
          auth_immutable?: boolean;
          auth_clawback_enabled?: boolean;
        };
        signers?: Array<{ key?: string; weight?: number; type?: string; sponsor?: string }>;
        data_attr?: Record<string, string>;
      };

      const signers: AccountSignerRecord[] = (rawAccount.signers ?? [])
        .filter((s): s is { key: string; weight: number; type: string; sponsor?: string } =>
          typeof s.key === "string" && typeof s.weight === "number",
        )
        .map((s) => ({
          key: s.key,
          weight: s.weight,
          type: s.type ?? "ed25519_public_key",
          ...(s.sponsor ? { sponsor: s.sponsor } : {}),
        }));

      const dataEntries: AccountDataEntryRecord[] = Object.entries(rawAccount.data_attr ?? {}).map(
        ([key, b64]) => {
          let decoded = b64;
          try {
            const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
            decoded = new TextDecoder().decode(bytes);
          } catch {
            // Keep base64 if non-UTF8
          }
          return { key, value: decoded };
        },
      );

      const lpRawBalances = (account.balances as Array<{
        asset_type?: string;
        balance?: string;
        liquidity_pool_id?: string;
      }>).filter(
        (b) =>
          b.asset_type === "liquidity_pool_shares" &&
          typeof b.liquidity_pool_id === "string" &&
          Number(b.balance ?? "0") > 0,
      );

      let liquidityPoolPositions: LiquidityPoolSharePosition[] = [];
      if (lpRawBalances.length > 0) {
        const targets = lpRawBalances.slice(0, 10);
        const resolvedPools = await Promise.all(
          targets.map(async (lpBal): Promise<LiquidityPoolSharePosition | null> => {
            const poolId = lpBal.liquidity_pool_id!;
            const userShares = Number(lpBal.balance ?? "0");
            try {
              const poolData = await withHorizonFailover(async (server) => {
                const builder = (
                  server as unknown as {
                    liquidityPools?: () => {
                      liquidityPoolId: (id: string) => { call: () => Promise<unknown> };
                    };
                  }
                ).liquidityPools?.();
                if (builder) {
                  return (await builder.liquidityPoolId(poolId).call()) as {
                    total_shares?: string;
                    total_trustlines?: number;
                    reserves?: Array<{ asset?: string; amount?: string }>;
                  };
                }
                const serverBase = (
                  server as unknown as { serverURL?: { toString(): string } }
                ).serverURL
                  ?.toString()
                  .replace(/\/+$/, "");
                if (!serverBase) return null;
                const r = await fetch(`${serverBase}/liquidity_pools/${encodeURIComponent(poolId)}`);
                if (!r.ok) return null;
                return (await r.json()) as {
                  total_shares?: string;
                  total_trustlines?: number;
                  reserves?: Array<{ asset?: string; amount?: string }>;
                };
              });
              if (!poolData) return null;
              const totalSharesNum = Number(poolData.total_shares ?? "0");
              const ratio = totalSharesNum > 0 ? userShares / totalSharesNum : 0;
              const reserves: LiquidityPoolReservePosition[] = (poolData.reserves ?? []).map(
                (r) => {
                  const rawAsset = r.asset ?? "native";
                  const [code, issuer] =
                    rawAsset === "native" ? ["XLM", undefined] : rawAsset.split(":");
                  const poolAmtNum = Number(r.amount ?? "0");
                  return {
                    assetCode: code || "ASSET",
                    ...(issuer ? { assetIssuer: issuer } : {}),
                    poolAmount: r.amount ?? "0",
                    userAmount: (poolAmtNum * ratio).toFixed(7),
                  };
                },
              );
              return {
                poolId,
                sharesBalance: lpBal.balance ?? "0",
                totalShares: poolData.total_shares ?? "0",
                totalTrustlines: poolData.total_trustlines ?? 0,
                sharePct: ratio * 100,
                reserves,
              };
            } catch {
              return null;
            }
          }),
        );
        liquidityPoolPositions = resolvedPools.filter(
          (p): p is LiquidityPoolSharePosition => p !== null,
        );
      }

      return {
        funded: true,
        balances,
        ...(liquidityPoolPositions.length > 0 ? { liquidityPoolPositions } : {}),
        subentryCount: reserve.subentryCount,
        numSponsoring: reserve.numSponsoring,
        numSponsored: reserve.numSponsored,
        minReserveXlm: reserve.minReserveXlm,
        spendableXlm: reserve.spendableXlm,
        reclaimableXlm: reserve.reclaimableXlm,
        reclaimableTrustlines: reserve.reclaimableTrustlines,
        ...(rawAccount.sequence ? { sequence: rawAccount.sequence } : {}),
        ...(typeof rawAccount.last_modified_ledger === "number"
          ? { lastModifiedLedger: rawAccount.last_modified_ledger }
          : {}),
        ...(rawAccount.home_domain ? { homeDomain: rawAccount.home_domain } : {}),
        ...(rawAccount.sponsor ? { sponsor: rawAccount.sponsor } : {}),
        ...(rawAccount.thresholds
          ? {
              thresholds: {
                lowThreshold: rawAccount.thresholds.low_threshold ?? 0,
                medThreshold: rawAccount.thresholds.med_threshold ?? 0,
                highThreshold: rawAccount.thresholds.high_threshold ?? 0,
              },
            }
          : {}),
        ...(rawAccount.flags
          ? {
              flags: {
                authRequired: Boolean(rawAccount.flags.auth_required),
                authRevocable: Boolean(rawAccount.flags.auth_revocable),
                authImmutable: Boolean(rawAccount.flags.auth_immutable),
                authClawbackEnabled: Boolean(rawAccount.flags.auth_clawback_enabled),
              },
            }
          : {}),
        ...(signers.length > 0 ? { signers } : {}),
        ...(dataEntries.length > 0 ? { dataEntries } : {}),
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

  async function fetchRecentTrades(
    address: string,
    limit = 20,
  ): Promise<AccountTradeRecord[]> {
    const lookupAddress = address.startsWith("M")
      ? decodeMuxedAddress(address as MuxedAddress).baseAddress
      : address;
    if (lookupAddress.startsWith("C")) {
      return [];
    }
    try {
      const page = await withHorizonFailover((server) =>
        server.trades().forAccount(lookupAddress).order("desc").limit(limit).call(),
      );
      return page.records.map((rec) => {
        const raw = rec as unknown as {
          id: string;
          ledger_close_time: string;
          base_asset_type?: string;
          base_asset_code?: string;
          base_asset_issuer?: string;
          base_amount: string;
          counter_asset_type?: string;
          counter_asset_code?: string;
          counter_asset_issuer?: string;
          counter_amount: string;
          price?: { n?: string | number; d?: string | number };
          base_is_seller?: boolean;
          base_account?: string;
          counter_account?: string;
        };
        const n = Number(raw.price?.n ?? 0);
        const d = Number(raw.price?.d ?? 1);
        const price =
          Number.isFinite(n) && Number.isFinite(d) && d > 0 ? (n / d).toPrecision(6) : "0";
        return {
          id: raw.id,
          ledgerCloseTime: raw.ledger_close_time,
          baseAssetCode: raw.base_asset_type === "native" ? "XLM" : (raw.base_asset_code ?? "ASSET"),
          baseAssetIssuer: raw.base_asset_issuer,
          baseAmount: raw.base_amount,
          counterAssetCode:
            raw.counter_asset_type === "native" ? "XLM" : (raw.counter_asset_code ?? "ASSET"),
          counterAssetIssuer: raw.counter_asset_issuer,
          counterAmount: raw.counter_amount,
          price,
          baseIsSeller: Boolean(raw.base_is_seller),
          baseAccount: raw.base_account,
          counterAccount: raw.counter_account,
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
    intentAuth?: RelayIntentAuth | undefined;
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
    const res = await submitSorobanOperation(
      input.sourceKeypair,
      op,
      undefined,
      input.intentAuth,
    );
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
    intentAuth?: RelayIntentAuth | undefined;
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
    return submitSorobanOperation(input.sourceKeypair, op, undefined, input.intentAuth);
  }

  async function cancelClaimEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }> {
    const op = buildCancelClaimOperation({
      escrowContractId: input.escrowContractId,
      claimIdHex: input.claimIdHex,
    });
    return submitSorobanOperation(input.sourceKeypair, op, undefined, input.intentAuth);
  }

  async function refundExpiredClaimEscrow(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
    recipientAddress?: StellarAddress | undefined;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }> {
    const op = input.recipientAddress
      ? buildRefundExpiredToOperation({
          escrowContractId: input.escrowContractId,
          claimIdHex: input.claimIdHex,
          recipientAddress: input.recipientAddress,
        })
      : buildRefundExpiredOperation({
          escrowContractId: input.escrowContractId,
          claimIdHex: input.claimIdHex,
        });
    return submitSorobanOperation(input.sourceKeypair, op, undefined, input.intentAuth);
  }

  async function extendClaimEscrowTtl(input: {
    sourceKeypair: Keypair;
    escrowContractId: ContractAddress;
    claimIdHex: string;
  }): Promise<{ hash: string; ledger: number }> {
    const op = buildExtendClaimTtlOperation({
      escrowContractId: input.escrowContractId,
      claimIdHex: input.claimIdHex,
    });
    return submitSorobanOperation(input.sourceKeypair, op);
  }

  return {
    fetchAccountState,
    fetchRecentPayments,
    fetchRecentTrades,
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
    cancelClaimEscrow,
    refundExpiredClaimEscrow,
    extendClaimEscrowTtl,
  };
}
