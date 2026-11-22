import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import {
  Account,
  Asset,
  BASE_FEE,
  Contract,
  FeeBumpTransaction,
  Federation,
  Horizon,
  Operation,
  StrKey,
  TransactionBuilder,
  Address,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
  type Keypair,
} from "@stellar/stellar-sdk";
import { createFailoverEndpoints } from "../network.js";

export interface Sep7ParsedUri {
  operation: "pay" | "tx";
  destination?: string | undefined;
  amount?: string | undefined;
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  memo?: string | undefined;
  memoType?: string | undefined;
  xdr?: string | undefined;
  callback?: string | undefined;
  originDomain?: string | undefined;
  msg?: string | undefined;
}

export interface BuildSep7PayInput {
  destination: string;
  amount?: string | undefined;
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  memo?: string | undefined;
  memoType?: "MEMO_TEXT" | "MEMO_ID" | "MEMO_HASH" | "MEMO_RETURN" | undefined;
  msg?: string | undefined;
}

export interface SorobanTelemetry {
  rpcUrl: string;
  healthStatus: string;
  latestLedger: number;
  oldestLedger: number;
  protocolVersion: number;
  rpcVersion: string;
  captiveCoreVersion: string;
  sorobanInclusionFeeP50: string;
  classicInclusionFeeP50: string;
}

export interface SorobanSimulationSummary {
  ok: boolean;
  latestLedger: number;
  minResourceFee?: string | undefined;
  eventsCount: number;
  decodedResult?: unknown;
  rawReturnXdr?: string | undefined;
  error?: string | undefined;
}

export interface SorobanInvokeResult {
  hash: string;
  ledger: number;
  status: string;
  decodedResult?: unknown;
}

export type DevTemplateKind = "self_payment" | "manage_data" | "change_trust";

function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  }
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      out[String(k)] = toJsonSafe(v);
    }
    return out;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = toJsonSafe(v);
    }
    return out;
  }
  return value;
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]*$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Bytes argument must be an even-length hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < clean.length; i += 2) {
    out[i / 2] = parseInt(clean.slice(i, i + 2), 16);
  }
  return out;
}

/**
 * Builds a standard SEP-0007 `web+stellar:pay?...` payment URI.
 */
export function buildSep7PayUri(input: BuildSep7PayInput): string {
  const dest = input.destination.trim();
  if (!dest) {
    throw new Error("Destination address is required for SEP-0007 URI");
  }

  const params = new URLSearchParams();
  params.set("destination", dest);

  if (input.amount && input.amount.trim()) {
    params.set("amount", input.amount.trim());
  }
  if (
    input.assetCode &&
    input.assetCode.trim().toUpperCase() !== "XLM" &&
    input.assetIssuer
  ) {
    params.set("asset_code", input.assetCode.trim().toUpperCase());
    params.set("asset_issuer", input.assetIssuer.trim());
  }
  if (input.memo && input.memo.trim()) {
    params.set("memo", input.memo.trim());
    params.set("memo_type", input.memoType ?? "MEMO_TEXT");
  }
  if (input.msg && input.msg.trim()) {
    params.set("msg", input.msg.trim());
  }

  return `web+stellar:pay?${params.toString()}`;
}

/**
 * Parses a SEP-0007 `web+stellar:pay?...` or `web+stellar:tx?...` URI cleanly.
 */
export function parseSep7Uri(rawUri: string): Sep7ParsedUri {
  const trimmed = rawUri.trim();
  const match = trimmed.match(/^web\+stellar:(pay|tx)\?(.+)$/i);
  if (!match?.[1] || !match[2]) {
    throw new Error("Invalid SEP-0007 URI (expected web+stellar:pay?... or web+stellar:tx?...)");
  }
  const operation = match[1].toLowerCase() as "pay" | "tx";
  const params = new URLSearchParams(match[2]);

  return {
    operation,
    destination: params.get("destination") ?? undefined,
    amount: params.get("amount") ?? undefined,
    assetCode: params.get("asset_code") ?? undefined,
    assetIssuer: params.get("asset_issuer") ?? undefined,
    memo: params.get("memo") ?? undefined,
    memoType: params.get("memo_type") ?? undefined,
    xdr: params.get("xdr") ?? undefined,
    callback: params.get("callback") ?? undefined,
    originDomain: params.get("origin_domain") ?? undefined,
    msg: params.get("msg") ?? undefined,
  };
}

/**
 * Parses and signs a Base64 Transaction or FeeBumpTransaction envelope using the provided Keypair.
 */
export function signTransactionXdrEnvelope(
  xdrBase64: string,
  networkPassphrase: string,
  keypair: Keypair,
): string {
  const tx = TransactionBuilder.fromXDR(xdrBase64.trim(), networkPassphrase);
  tx.sign(keypair);
  return tx.toXDR();
}

/**
 * Resolves a SEP-0002 Stellar Federation address (e.g. `alice*domain.com`).
 */
export async function resolveFederationAddress(handle: string): Promise<{
  accountId: ClassicAddress;
  memoType?: string | undefined;
  memo?: string | undefined;
}> {
  const cleaned = handle.trim();
  if (!cleaned.includes("*")) {
    throw new Error("Federation address must contain '*' (for example user*domain.com)");
  }
  const record = await Federation.Server.resolve(cleaned);
  return {
    accountId: record.account_id as ClassicAddress,
    memoType: record.memo_type ? String(record.memo_type) : undefined,
    memo: record.memo !== undefined && record.memo !== null ? String(record.memo) : undefined,
  };
}

/**
 * Converts a JSON array of typed descriptors (`{ type, value }`) or plain JSON literals into `xdr.ScVal[]`.
 */
export function parseDevScValArgs(argsJson: string): xdr.ScVal[] {
  const cleaned = argsJson.trim();
  if (!cleaned) return [];

  const parsed: unknown = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) {
    throw new Error("Contract arguments JSON must be an array, e.g. [] or [{\"type\":\"u32\",\"value\":0}]");
  }

  return parsed.map((item) => {
    if (
      item &&
      typeof item === "object" &&
      "type" in item &&
      "value" in item &&
      typeof (item as { type: unknown }).type === "string"
    ) {
      const argType = (item as { type: string }).type.trim();
      const val = (item as { value: unknown }).value;

      switch (argType) {
        case "address":
          return new Address(String(val)).toScVal();
        case "symbol":
          return xdr.ScVal.scvSymbol(String(val));
        case "string":
          return xdr.ScVal.scvString(String(val));
        case "bool":
          return xdr.ScVal.scvBool(Boolean(val));
        case "bytes":
          return nativeToScVal(hexToBytes(String(val)), { type: "bytes" });
        case "u32":
        case "i32":
          return nativeToScVal(Number(val), { type: argType });
        case "u64":
        case "i64":
        case "u128":
        case "i128":
        case "u256":
        case "i256":
          return nativeToScVal(BigInt(String(val)), { type: argType });
        case "void":
          return xdr.ScVal.scvVoid();
        default:
          throw new Error(`Unsupported Soroban ScVal arg type "${argType}"`);
      }
    }

    if (
      typeof item === "string" &&
      (StrKey.isValidEd25519PublicKey(item) || StrKey.isValidContract(item))
    ) {
      return new Address(item).toScVal();
    }

    return nativeToScVal(item);
  });
}

function readonlySimAddress(): string {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32));
}

function txContainsSorobanOp(envelopeXdr: string, networkPassphrase: string): boolean {
  const tx = TransactionBuilder.fromXDR(envelopeXdr, networkPassphrase);
  const ops = tx instanceof FeeBumpTransaction ? tx.innerTransaction.operations : tx.operations;
  return ops.some(
    (op) =>
      op.type === "invokeHostFunction" ||
      op.type === "extendFootprintTtl" ||
      op.type === "restoreFootprint",
  );
}

/**
 * Creates a full Soroban RPC + XDR + Federation Developer client backed by RPC/Horizon failover.
 */
class NonRetryableDevLabError extends Error {}

export function createSorobanDevClient(input: {
  rpcUrls: readonly string[];
  horizonUrls?: readonly string[] | undefined;
  networkPassphrase: string;
  maxResourceFeeStroops?: string | bigint | undefined;
  relaySubmitter?:
    | ((input: {
        signedTxXdrBase64: string;
        sourceKeypair: Keypair;
        intentAuth?: { intentId: string; sig: string } | undefined;
      }) => Promise<{ hash: string; ledger?: number | undefined } | null>)
    | undefined;
}) {
  const rpcEndpoints = createFailoverEndpoints(input.rpcUrls);
  const horizonEndpoints = createFailoverEndpoints(
    input.horizonUrls && input.horizonUrls.length > 0 ? input.horizonUrls : input.rpcUrls,
  );
  const maxResourceFeeStroops =
    typeof input.maxResourceFeeStroops === "bigint"
      ? input.maxResourceFeeStroops
      : typeof input.maxResourceFeeStroops === "string" &&
          /^\d+$/.test(input.maxResourceFeeStroops.trim())
        ? BigInt(input.maxResourceFeeStroops.trim())
        : 5_000_000n;

  async function withRpcFailover<T>(fn: (server: rpc.Server) => Promise<T>): Promise<T> {
    const urls = rpcEndpoints.list();
    let lastError: unknown;
    for (let i = 0; i < urls.length; i += 1) {
      const url = rpcEndpoints.current();
      const server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
      try {
        return await fn(server);
      } catch (err) {
        if (err instanceof NonRetryableDevLabError) {
          throw err;
        }
        lastError = err;
        rpcEndpoints.next();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All Soroban RPC endpoints failed");
  }

  async function withHorizonFailover<T>(fn: (server: Horizon.Server) => Promise<T>): Promise<T> {
    const urls = horizonEndpoints.list();
    let lastError: unknown;
    for (let i = 0; i < urls.length; i += 1) {
      const url = horizonEndpoints.current();
      const server = new Horizon.Server(url, { allowHttp: url.startsWith("http://") });
      try {
        return await fn(server);
      } catch (err) {
        lastError = err;
        horizonEndpoints.next();
      }
    }
    throw lastError instanceof Error ? lastError : new Error("All Horizon endpoints failed");
  }

  async function fetchNetworkTelemetry(): Promise<SorobanTelemetry> {
    return withRpcFailover(async (server) => {
      const [health, latest, fees, version] = await Promise.all([
        server.getHealth(),
        server.getLatestLedger(),
        server.getFeeStats(),
        server.getVersionInfo(),
      ]);

      return {
        rpcUrl: server.serverURL.toString(),
        healthStatus: health.status,
        latestLedger: latest.sequence,
        oldestLedger: health.oldestLedger,
        protocolVersion: version.protocolVersion,
        rpcVersion: version.version,
        captiveCoreVersion: version.captiveCoreVersion,
        sorobanInclusionFeeP50: fees.sorobanInclusionFee.p50,
        classicInclusionFeeP50: fees.inclusionFee.p50,
      };
    });
  }

  async function simulateContractCall(params: {
    contractId: ContractAddress;
    fnName: string;
    argsJson: string;
    sourceAddress?: ClassicAddress | undefined;
  }): Promise<SorobanSimulationSummary> {
    const scArgs = parseDevScValArgs(params.argsJson);
    const contract = new Contract(params.contractId);
    const sourceId = params.sourceAddress ?? readonlySimAddress();

    return withRpcFailover(async (server) => {
      const sourceAccount = params.sourceAddress
        ? await server.getAccount(params.sourceAddress).catch(() => new Account(sourceId, "0"))
        : new Account(sourceId, "0");

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: input.networkPassphrase,
      })
        .addOperation(contract.call(params.fnName.trim(), ...scArgs))
        .setTimeout(30)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        return {
          ok: false,
          latestLedger: sim.latestLedger,
          eventsCount: sim.events.length,
          error: sim.error,
        };
      }

      const retval = sim.result?.retval;
      return {
        ok: true,
        latestLedger: sim.latestLedger,
        minResourceFee: sim.minResourceFee,
        eventsCount: sim.events.length,
        rawReturnXdr: retval?.toXDR("base64"),
        decodedResult: retval ? toJsonSafe(scValToNative(retval)) : null,
      };
    });
  }

  async function invokeContractWrite(params: {
    sourceKeypair: Keypair;
    contractId: ContractAddress;
    fnName: string;
    argsJson: string;
  }): Promise<SorobanInvokeResult> {
    const scArgs = parseDevScValArgs(params.argsJson);
    const contract = new Contract(params.contractId);
    const sourceAddress = params.sourceKeypair.publicKey();

    const assembled = await withRpcFailover(async (server) => {
      const sourceAccount = await server.getAccount(sourceAddress);
      let inclusionFee = BASE_FEE;
      try {
        const feeStats = await server.getFeeStats();
        const raw = Number(
          feeStats.sorobanInclusionFee?.p90 ?? feeStats.sorobanInclusionFee?.mode ?? BASE_FEE,
        );
        if (Number.isFinite(raw) && raw >= Number(BASE_FEE)) {
          inclusionFee = String(Math.min(Math.trunc(raw), 50_000));
        }
      } catch {
        inclusionFee = BASE_FEE;
      }

      const tx = new TransactionBuilder(sourceAccount, {
        fee: inclusionFee,
        networkPassphrase: input.networkPassphrase,
      })
        .addOperation(contract.call(params.fnName.trim(), ...scArgs))
        .setTimeout(45)
        .build();

      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationRestore(sim)) {
        throw new NonRetryableDevLabError(
          "Soroban archived state restore required before invocation",
        );
      }
      if (rpc.Api.isSimulationError(sim)) {
        throw new NonRetryableDevLabError(`Soroban simulation failed: ${sim.error}`);
      }
      const simResourceFee = BigInt(sim.minResourceFee || "0");
      if (simResourceFee > maxResourceFeeStroops) {
        throw new NonRetryableDevLabError(
          `Soroban simulated resource fee (${simResourceFee}) exceeds limit (${maxResourceFeeStroops})`,
        );
      }

      return rpc.assembleTransaction(tx, sim).build();
    });

    assembled.sign(params.sourceKeypair);

    return withRpcFailover(async (server) => {
      const sent = await server.sendTransaction(assembled);
      if (sent.status === "ERROR") {
        throw new NonRetryableDevLabError(`Soroban sendTransaction ERROR (${sent.hash})`);
      }

      let polled = await server.getTransaction(sent.hash);
      for (
        let i = 0;
        i < 18 && polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND;
        i += 1
      ) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        polled = await server.getTransaction(sent.hash);
      }

      if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
        throw new NonRetryableDevLabError(`Soroban transaction failed on ledger (${sent.hash})`);
      }
      if (polled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
        throw new NonRetryableDevLabError(
          `Soroban transaction confirmation timed out (${sent.hash})`,
        );
      }

      return {
        hash: sent.hash,
        ledger: polled.ledger,
        status: polled.status,
        decodedResult: polled.returnValue ? toJsonSafe(scValToNative(polled.returnValue)) : null,
      };
    });
  }

  async function simulateRawXdr(xdrBase64: string): Promise<SorobanSimulationSummary> {
    const tx = TransactionBuilder.fromXDR(xdrBase64.trim(), input.networkPassphrase);
    return withRpcFailover(async (server) => {
      const sim = await server.simulateTransaction(tx);
      if (rpc.Api.isSimulationError(sim)) {
        return {
          ok: false,
          latestLedger: sim.latestLedger,
          eventsCount: sim.events.length,
          error: sim.error,
        };
      }
      const retval = sim.result?.retval;
      return {
        ok: true,
        latestLedger: sim.latestLedger,
        minResourceFee: sim.minResourceFee,
        eventsCount: sim.events.length,
        rawReturnXdr: retval?.toXDR("base64"),
        decodedResult: retval ? toJsonSafe(scValToNative(retval)) : null,
      };
    });
  }

  async function submitRawSignedXdr(
    signedXdrBase64: string,
    opts?: {
      sourceKeypair?: Keypair | undefined;
      intentAuth?: { intentId: string; sig: string } | undefined;
    },
  ): Promise<{
    hash: string;
    ledger: number;
    channel: "soroban-rpc" | "horizon";
  }> {
    const cleaned = signedXdrBase64.trim();
    const parsed = TransactionBuilder.fromXDR(cleaned, input.networkPassphrase);

    if (txContainsSorobanOp(cleaned, input.networkPassphrase)) {
      if (input.relaySubmitter && opts?.sourceKeypair) {
        try {
          const relayed = await input.relaySubmitter({
            signedTxXdrBase64: cleaned,
            sourceKeypair: opts.sourceKeypair,
            intentAuth: opts.intentAuth,
          });
          if (relayed && typeof relayed.hash === "string" && relayed.hash.trim().length > 0) {
            const relayedHash = relayed.hash.trim();
            if (typeof relayed.ledger === "number" && relayed.ledger > 0) {
              return { hash: relayedHash, ledger: relayed.ledger, channel: "soroban-rpc" };
            }
            try {
              return await withRpcFailover(async (server) => {
                let polled = await server.getTransaction(relayedHash);
                for (
                  let i = 0;
                  i < 15 && polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND;
                  i += 1
                ) {
                  await new Promise((resolve) => setTimeout(resolve, 1000));
                  polled = await server.getTransaction(relayedHash);
                }
                if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
                  throw new NonRetryableDevLabError(
                    `Soroban relayed transaction failed (${relayedHash})`,
                  );
                }
                return {
                  hash: relayedHash,
                  ledger:
                    polled.status === rpc.Api.GetTransactionStatus.SUCCESS ? polled.ledger : 0,
                  channel: "soroban-rpc" as const,
                };
              });
            } catch (pollErr) {
              if (pollErr instanceof NonRetryableDevLabError) {
                throw pollErr;
              }
              return { hash: relayedHash, ledger: 0, channel: "soroban-rpc" };
            }
          }
        } catch (relayErr) {
          if (relayErr instanceof NonRetryableDevLabError) {
            throw relayErr;
          }
          // Fall back cleanly to direct Soroban RPC submission
        }
      }

      return withRpcFailover(async (server) => {
        const sent = await server.sendTransaction(parsed);
        if (sent.status === "ERROR") {
          const reason = sent.errorResult ? ` — ${sent.errorResult.toXDR("base64").slice(0, 64)}` : "";
          throw new NonRetryableDevLabError(`Soroban RPC rejected signed XDR (${sent.hash}${reason})`);
        }
        let polled = await server.getTransaction(sent.hash);
        for (
          let i = 0;
          i < 18 && polled.status === rpc.Api.GetTransactionStatus.NOT_FOUND;
          i += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, 1000));
          polled = await server.getTransaction(sent.hash);
        }
        if (polled.status === rpc.Api.GetTransactionStatus.FAILED) {
          throw new NonRetryableDevLabError(`Soroban transaction failed (${sent.hash})`);
        }
        if (polled.status !== rpc.Api.GetTransactionStatus.SUCCESS) {
          throw new NonRetryableDevLabError(
            `Soroban transaction confirmation timed out (${sent.hash})`,
          );
        }
        return {
          hash: sent.hash,
          ledger: polled.ledger,
          channel: "soroban-rpc" as const,
        };
      });
    }

    return withHorizonFailover(async (server) => {
      const submitted = await server.submitTransaction(parsed);
      return {
        hash: submitted.hash,
        ledger: submitted.ledger,
        channel: "horizon" as const,
      };
    });
  }

  async function buildTemplateUnsignedXdr(params: {
    sourceAddress: ClassicAddress;
    template: DevTemplateKind;
  }): Promise<string> {
    const account = await withHorizonFailover((server) =>
      server.loadAccount(params.sourceAddress),
    );
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: input.networkPassphrase,
    });

    if (params.template === "self_payment") {
      builder.addOperation(
        Operation.payment({
          destination: params.sourceAddress,
          asset: Asset.native(),
          amount: "0.0001000",
        }),
      );
    } else if (params.template === "manage_data") {
      builder.addOperation(
        Operation.manageData({
          name: "astrowallet.dev",
          value: "verified",
        }),
      );
    } else {
      builder.addOperation(
        Operation.changeTrust({
          asset: new Asset("ASTRO", params.sourceAddress),
          limit: "100",
        }),
      );
    }

    return builder.setTimeout(120).build().toXDR();
  }

  return {
    fetchNetworkTelemetry,
    simulateContractCall,
    invokeContractWrite,
    simulateRawXdr,
    submitRawSignedXdr,
    buildTemplateUnsignedXdr,
  };
}
