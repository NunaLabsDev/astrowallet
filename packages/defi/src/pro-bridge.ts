import {
  Account,
  Address,
  Asset,
  BASE_FEE,
  Contract,
  StrKey,
  TransactionBuilder,
  nativeToScVal,
  rpc,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";

export interface LayerZeroSendParamInput {
  dstEid: number;
  toBytes32: Uint8Array;
  amountLdStroops7: bigint;
  minAmountLdStroops7: bigint;
  extraOptionsBytes?: Uint8Array | undefined;
  composeMsgBytes?: Uint8Array | undefined;
  oftCmdBytes?: Uint8Array | undefined;
}

export interface LayerZeroOftQuoteResult {
  oftContractId: ContractAddress;
  dstEid: number;
  amountSentLdStroops7: bigint;
  amountReceivedLdStroops7: bigint;
  minAmountLdStroops7: bigint;
  feeDetailsCount: number;
  nativeFeeStroops: bigint;
  zroFee: bigint;
}

export interface CctpApproveBuildResult {
  alreadyApproved: boolean;
  allowanceStroops7: bigint;
  expirationLedger?: number | undefined;
  unsignedXdr?: string | undefined;
  minResourceFee?: string | undefined;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (clean.length === 0) return new Uint8Array(0);
  if (clean.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(clean)) {
    throw new Error("Hex payload must have an even number of hexadecimal characters");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): `0x${string}` {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${hex}`;
}

/**
 * Derives the deterministic Stellar Asset Contract (`C...`) ID for a Classic asset on a given network passphrase.
 */
export function deriveAssetContractId(
  assetCode: string,
  assetIssuer: string,
  networkPassphrase: string,
): ContractAddress {
  return new Asset(assetCode.trim(), assetIssuer.trim()).contractId(
    networkPassphrase,
  ) as ContractAddress;
}

/**
 * Decodes a 56-char `C...` Soroban contract strkey into a 32-byte `0x...` payload
 * (`mintRecipient` / `destinationCaller` for Circle CCTP V2 inbound Stellar forwarding).
 */
export function contractStrkeyToBytes32Hex(contractId: string): `0x${string}` {
  const clean = contractId.trim();
  if (!StrKey.isValidContract(clean)) {
    throw new Error(`Invalid Stellar C... contract strkey: ${contractId}`);
  }
  return bytesToHex(StrKey.decodeContract(clean));
}

/**
 * Left-pads a 20-byte EVM `0x...` address to a 32-byte array required by CCTP V2 and LayerZero V2 OFT.
 */
export function evmAddressToBytes32(evmAddress: string): Uint8Array {
  const clean = evmAddress.trim();
  if (!/^0x[0-9a-fA-F]{40}$/.test(clean)) {
    throw new Error(`Invalid EVM 20-byte hex address: ${evmAddress}`);
  }
  const raw20 = hexToBytes(clean);
  const out = new Uint8Array(32);
  out.set(raw20, 12);
  return out;
}

/**
 * Builds Circle CCTP V2 `CctpForwarder` hook data:
 * - bytes 0..23: zero magic
 * - bytes 24..27: BE uint32 version (`0`)
 * - bytes 28..31: BE uint32 recipient strkey byte length
 * - bytes 32..: UTF-8 Stellar strkey (`G...`, `C...`, or `M...`)
 */
export function buildCctpForwarderHookData(recipientStrkey: string): {
  hex: `0x${string}`;
  bytes: Uint8Array;
} {
  const clean = recipientStrkey.trim();
  const valid =
    StrKey.isValidEd25519PublicKey(clean) ||
    StrKey.isValidContract(clean) ||
    StrKey.isValidMed25519PublicKey(clean);
  if (!valid) {
    throw new Error(`Invalid Stellar G.../C.../M... CCTP forward recipient: ${recipientStrkey}`);
  }
  const recipientBytes = new TextEncoder().encode(clean);
  const hookData = new Uint8Array(32 + recipientBytes.length);
  const view = new DataView(hookData.buffer);
  view.setUint32(24, 0, false);
  view.setUint32(28, recipientBytes.length, false);
  hookData.set(recipientBytes, 32);
  return {
    hex: bytesToHex(hookData),
    bytes: hookData,
  };
}

function zeroBytes32(): Uint8Array {
  return new Uint8Array(32);
}

function readonlyAddress(): string {
  return StrKey.encodeEd25519PublicKey(new Uint8Array(32));
}

/**
 * Encodes LayerZero V2 `SendParam` struct (`#[contracttype]`) with Soroban canonical alphabetical key order.
 */
export function buildLayerZeroSendParamScVal(input: LayerZeroSendParamInput): xdr.ScVal {
  if (!Number.isInteger(input.dstEid) || input.dstEid <= 0 || input.dstEid > 0xffffffff) {
    throw new Error(`Invalid LayerZero destination EID: ${input.dstEid}`);
  }
  if (input.toBytes32.length !== 32) {
    throw new Error(`LayerZero recipient must be exactly 32 bytes (got ${input.toBytes32.length})`);
  }
  if (input.amountLdStroops7 <= 0n) {
    throw new Error("LayerZero OFT amount_ld must be greater than zero");
  }
  if (input.minAmountLdStroops7 < 0n || input.minAmountLdStroops7 > input.amountLdStroops7) {
    throw new Error("LayerZero OFT min_amount_ld must be between 0 and amount_ld");
  }

  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("amount_ld"),
      val: nativeToScVal(input.amountLdStroops7, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("compose_msg"),
      val: xdr.ScVal.scvBytes(input.composeMsgBytes ?? new Uint8Array(0)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("dst_eid"),
      val: nativeToScVal(input.dstEid, { type: "u32" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("extra_options"),
      val: xdr.ScVal.scvBytes(input.extraOptionsBytes ?? new Uint8Array(0)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("min_amount_ld"),
      val: nativeToScVal(input.minAmountLdStroops7, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("oft_cmd"),
      val: xdr.ScVal.scvBytes(input.oftCmdBytes ?? new Uint8Array(0)),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("to"),
      val: xdr.ScVal.scvBytes(input.toBytes32),
    }),
  ]);
}

/**
 * Encodes LayerZero V2 `MessagingFee` struct (`native_fee`, `zro_fee`) in alphabetical key order.
 */
export function buildLayerZeroMessagingFeeScVal(input: {
  nativeFeeStroops: bigint;
  zroFee?: bigint | undefined;
}): xdr.ScVal {
  const zroFee = input.zroFee ?? 0n;
  if (input.nativeFeeStroops < 0n || zroFee < 0n) {
    throw new Error("LayerZero messaging fees cannot be negative");
  }
  return xdr.ScVal.scvMap([
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("native_fee"),
      val: nativeToScVal(input.nativeFeeStroops, { type: "i128" }),
    }),
    new xdr.ScMapEntry({
      key: xdr.ScVal.scvSymbol("zro_fee"),
      val: nativeToScVal(zroFee, { type: "i128" }),
    }),
  ]);
}

async function withBridgeRpcFailover<T>(
  rpcUrls: readonly string[],
  fn: (server: rpc.Server) => Promise<T>,
): Promise<T> {
  const cleanUrls = rpcUrls.map((u) => u.trim()).filter(Boolean);
  if (cleanUrls.length === 0) {
    throw new Error("At least one Soroban RPC URL is required");
  }
  let lastError: unknown;
  for (const url of cleanUrls) {
    const server = new rpc.Server(url, { allowHttp: url.startsWith("http://") });
    try {
      return await fn(server);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("All Soroban RPC endpoints failed");
}

async function simulateReadCall(input: {
  server: rpc.Server;
  contractId: string;
  networkPassphrase: string;
  method: string;
  args: xdr.ScVal[];
}): Promise<unknown> {
  const tx = new TransactionBuilder(new Account(readonlyAddress(), "0"), {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(new Contract(input.contractId).call(input.method, ...input.args))
    .setTimeout(25)
    .build();

  const sim = await input.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Soroban simulation failed (${input.method}): ${sim.error}`);
  }
  return sim.result?.retval ? scValToNative(sim.result.retval) : null;
}

async function buildAndSimulateWriteTx(input: {
  server: rpc.Server;
  caller: ClassicAddress;
  networkPassphrase: string;
  operation: xdr.Operation;
}): Promise<{ unsignedXdr: string; minResourceFee: string }> {
  const account = await input.server.getAccount(input.caller);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: input.networkPassphrase,
  })
    .addOperation(input.operation)
    .setTimeout(60)
    .build();

  const sim = await input.server.simulateTransaction(tx);
  if (rpc.Api.isSimulationRestore(sim)) {
    throw new Error("Soroban state archive restore required before submitting bridge transaction");
  }
  if (rpc.Api.isSimulationError(sim)) {
    throw new Error(`Bridge transaction simulation failed: ${sim.error}`);
  }
  const assembled = rpc.assembleTransaction(tx, sim).build();
  return {
    unsignedXdr: assembled.toXDR(),
    minResourceFee: sim.minResourceFee || "0",
  };
}

/**
 * Checks existing SEP-41 USDC allowance for `TokenMessengerMinter` and builds `approve` if needed.
 */
export async function buildCctpApproveXdr(input: {
  from: ClassicAddress;
  usdcSacContractId: ContractAddress;
  tokenMessengerMinterContractId: ContractAddress;
  amountStroops7: bigint;
  expirationLedgerOffset?: number | undefined;
  rpcUrls: readonly string[];
  networkPassphrase: string;
}): Promise<CctpApproveBuildResult> {
  if (!StrKey.isValidEd25519PublicKey(input.from)) {
    throw new Error("CCTP burn sender must be a valid Stellar G... public key");
  }
  if (
    !StrKey.isValidContract(input.usdcSacContractId) ||
    !StrKey.isValidContract(input.tokenMessengerMinterContractId)
  ) {
    throw new Error("Valid Soroban C... contract IDs are required for USDC SAC and TokenMessengerMinter");
  }
  if (input.amountStroops7 <= 0n) {
    throw new Error("CCTP amount must be greater than zero");
  }

  return withBridgeRpcFailover(input.rpcUrls, async (server) => {
    const rawAllowance = await simulateReadCall({
      server,
      contractId: input.usdcSacContractId,
      networkPassphrase: input.networkPassphrase,
      method: "allowance",
      args: [
        new Address(input.from).toScVal(),
        new Address(input.tokenMessengerMinterContractId).toScVal(),
      ],
    }).catch(() => 0);

    const allowanceBig = BigInt(String(rawAllowance ?? 0));
    if (allowanceBig >= input.amountStroops7) {
      return {
        alreadyApproved: true,
        allowanceStroops7: allowanceBig,
      };
    }

    const latest = await server.getLatestLedger();
    const offset = Math.max(50, Math.min(input.expirationLedgerOffset ?? 120, 1000));
    const expirationLedger = latest.sequence + offset;

    const usdc = new Contract(input.usdcSacContractId);
    const op = usdc.call(
      "approve",
      new Address(input.from).toScVal(),
      new Address(input.tokenMessengerMinterContractId).toScVal(),
      nativeToScVal(input.amountStroops7, { type: "i128" }),
      nativeToScVal(expirationLedger, { type: "u32" }),
    );
    const built = await buildAndSimulateWriteTx({
      server,
      caller: input.from,
      networkPassphrase: input.networkPassphrase,
      operation: op,
    });
    return {
      alreadyApproved: false,
      allowanceStroops7: allowanceBig,
      expirationLedger,
      unsignedXdr: built.unsignedXdr,
      minResourceFee: built.minResourceFee,
    };
  });
}

/**
 * Builds and simulates Circle CCTP V2 `TokenMessengerMinter.deposit_for_burn(...)` on Stellar.
 */
export async function buildCctpDepositForBurnXdr(input: {
  from: ClassicAddress;
  usdcSacContractId: ContractAddress;
  tokenMessengerMinterContractId: ContractAddress;
  destinationDomain: number;
  mintRecipientBytes32: Uint8Array;
  destinationCallerBytes32?: Uint8Array | undefined;
  amountStroops7: bigint;
  maxFeeStroops7?: bigint | undefined;
  minFinalityThreshold?: number | undefined;
  rpcUrls: readonly string[];
  networkPassphrase: string;
}): Promise<{ unsignedXdr: string; minResourceFee: string }> {
  if (!StrKey.isValidEd25519PublicKey(input.from)) {
    throw new Error("CCTP deposit_for_burn caller must be a valid Stellar G... address");
  }
  if (input.mintRecipientBytes32.length !== 32) {
    throw new Error("CCTP mint_recipient must be 32 bytes");
  }
  if (input.amountStroops7 <= 0n) {
    throw new Error("CCTP burn amount must be greater than zero");
  }
  const destCaller = input.destinationCallerBytes32 ?? zeroBytes32();
  if (destCaller.length !== 32) {
    throw new Error("CCTP destination_caller must be 32 bytes");
  }
  const maxFee = input.maxFeeStroops7 ?? 100_000n; // Default ~$0.01 USDC in 7-dec stroops
  if (maxFee < 0n) {
    throw new Error("CCTP maxFee must be non-negative");
  }
  if (input.amountStroops7 <= maxFee) {
    throw new Error("CCTP burn amount must exceed maxFee");
  }
  const finality = input.minFinalityThreshold ?? 2000; // Standard finality on Stellar

  return withBridgeRpcFailover(input.rpcUrls, async (server) => {
    const tmm = new Contract(input.tokenMessengerMinterContractId);
    const op = tmm.call(
      "deposit_for_burn",
      new Address(input.from).toScVal(),
      nativeToScVal(input.amountStroops7, { type: "i128" }),
      nativeToScVal(input.destinationDomain, { type: "u32" }),
      xdr.ScVal.scvBytes(input.mintRecipientBytes32),
      new Address(input.usdcSacContractId).toScVal(),
      xdr.ScVal.scvBytes(destCaller),
      nativeToScVal(maxFee, { type: "i128" }),
      nativeToScVal(finality, { type: "u32" }),
    );
    return buildAndSimulateWriteTx({
      server,
      caller: input.from,
      networkPassphrase: input.networkPassphrase,
      operation: op,
    });
  });
}

/**
 * Builds and simulates Circle CCTP V2 inbound `CctpForwarder.mint_and_forward(message, attestation)`.
 */
export async function buildCctpMintAndForwardXdr(input: {
  caller: ClassicAddress;
  cctpForwarderContractId: ContractAddress;
  messageHex: string;
  attestationHex: string;
  rpcUrls: readonly string[];
  networkPassphrase: string;
}): Promise<{ unsignedXdr: string; minResourceFee: string }> {
  if (!StrKey.isValidEd25519PublicKey(input.caller)) {
    throw new Error("Caller must be a valid Stellar G... address");
  }
  if (!StrKey.isValidContract(input.cctpForwarderContractId)) {
    throw new Error("Invalid CctpForwarder C... contract ID");
  }
  const messageBytes = hexToBytes(input.messageHex);
  const attestationBytes = hexToBytes(input.attestationHex);
  if (messageBytes.length === 0 || attestationBytes.length === 0) {
    throw new Error("Both Iris message hex and attestation hex are required");
  }

  return withBridgeRpcFailover(input.rpcUrls, async (server) => {
    const forwarder = new Contract(input.cctpForwarderContractId);
    const op = forwarder.call(
      "mint_and_forward",
      xdr.ScVal.scvBytes(messageBytes),
      xdr.ScVal.scvBytes(attestationBytes),
    );
    return buildAndSimulateWriteTx({
      server,
      caller: input.caller,
      networkPassphrase: input.networkPassphrase,
      operation: op,
    });
  });
}

/**
 * Performs live read-only LayerZero V2 OFT pathway checks (`is_paused`, `peer(dst_eid)`),
 * discovers `amount_received_ld` via `quote_oft(min=0)`, re-quotes with slippage floor, and prices `quote_send` in XLM stroops.
 */
export async function quoteLayerZeroOftBridge(input: {
  oftContractId: ContractAddress;
  from: string;
  dstEid: number;
  toBytes32: Uint8Array;
  amountLdStroops7: bigint;
  slippageBps?: number | undefined;
  rpcUrls: readonly string[];
  networkPassphrase: string;
}): Promise<LayerZeroOftQuoteResult> {
  if (!StrKey.isValidContract(input.oftContractId)) {
    throw new Error(`Invalid OFT contract ID: ${input.oftContractId}`);
  }
  const cleanFrom = input.from.trim();
  if (!StrKey.isValidEd25519PublicKey(cleanFrom) && !StrKey.isValidContract(cleanFrom)) {
    throw new Error(`Invalid sender address: ${input.from}`);
  }
  const slippageBps = input.slippageBps ?? 50;
  if (!Number.isInteger(slippageBps) || slippageBps < 0 || slippageBps >= 5000) {
    throw new Error("Slippage tolerance must be between 0 and 4999 bps");
  }

  return withBridgeRpcFailover(input.rpcUrls, async (server) => {
    const isSimError = (err: unknown): boolean =>
      err instanceof Error && err.message.startsWith("Soroban simulation failed");

    const [pausedRaw, peerRaw] = await Promise.all([
      simulateReadCall({
        server,
        contractId: input.oftContractId,
        networkPassphrase: input.networkPassphrase,
        method: "is_paused",
        args: [],
      }).catch((err) => {
        if (isSimError(err)) return false;
        throw err;
      }),
      simulateReadCall({
        server,
        contractId: input.oftContractId,
        networkPassphrase: input.networkPassphrase,
        method: "peer",
        args: [nativeToScVal(input.dstEid, { type: "u32" })],
      }).catch((err) => {
        if (isSimError(err)) {
          const msg = err.message;
          if (/Missing contract|Function|not found|InvalidAction/i.test(msg)) {
            throw new Error(
              "Contract is not a valid LayerZero V2 OFT deployment on this network",
            );
          }
          return undefined;
        }
        throw err;
      }),
    ]);

    if (pausedRaw === true) {
      throw new Error("LayerZero OFT bridge contract is currently paused on-chain");
    }
    if (peerRaw === null || peerRaw === undefined) {
      throw new Error(`No LayerZero peer wired on OFT for destination EID ${input.dstEid}`);
    }

    const fromScVal = new Address(cleanFrom).toScVal();
    const discoverParam = buildLayerZeroSendParamScVal({
      dstEid: input.dstEid,
      toBytes32: input.toBytes32,
      amountLdStroops7: input.amountLdStroops7,
      minAmountLdStroops7: 0n,
    });

    const quoteOftRaw = await simulateReadCall({
      server,
      contractId: input.oftContractId,
      networkPassphrase: input.networkPassphrase,
      method: "quote_oft",
      args: [fromScVal, discoverParam],
    });
    if (!Array.isArray(quoteOftRaw) || quoteOftRaw.length < 3) {
      throw new Error("Unexpected LayerZero quote_oft return payload");
    }
    const feeDetails = Array.isArray(quoteOftRaw[1]) ? quoteOftRaw[1] : [];
    const receipt = quoteOftRaw[2] as Record<string, unknown>;
    const amountSentLd = BigInt(String(receipt?.amount_sent_ld ?? input.amountLdStroops7));
    const amountReceivedLd = BigInt(String(receipt?.amount_received_ld ?? 0));
    if (amountReceivedLd <= 0n) {
      throw new Error("LayerZero quote_oft returned zero received amount");
    }

    const minAmountLd =
      (amountReceivedLd * BigInt(10_000 - slippageBps)) / 10_000n;
    if (minAmountLd <= 0n) {
      throw new Error("Minimum received amount after slippage fell to zero");
    }

    const finalParam = buildLayerZeroSendParamScVal({
      dstEid: input.dstEid,
      toBytes32: input.toBytes32,
      amountLdStroops7: input.amountLdStroops7,
      minAmountLdStroops7: minAmountLd,
    });

    // Re-run quote_oft with actual slippage floor and price MessagingFee in XLM stroops
    await simulateReadCall({
      server,
      contractId: input.oftContractId,
      networkPassphrase: input.networkPassphrase,
      method: "quote_oft",
      args: [fromScVal, finalParam],
    });

    const messagingFeeRaw = (await simulateReadCall({
      server,
      contractId: input.oftContractId,
      networkPassphrase: input.networkPassphrase,
      method: "quote_send",
      args: [fromScVal, finalParam, nativeToScVal(false, { type: "bool" })],
    })) as Record<string, unknown> | null;

    const nativeFeeStroops = BigInt(String(messagingFeeRaw?.native_fee ?? 0));
    const zroFee = BigInt(String(messagingFeeRaw?.zro_fee ?? 0));
    if (nativeFeeStroops < 0n) {
      throw new Error("LayerZero quote_send returned negative messaging fee");
    }

    return {
      oftContractId: input.oftContractId,
      dstEid: input.dstEid,
      amountSentLdStroops7: amountSentLd,
      amountReceivedLdStroops7: amountReceivedLd,
      minAmountLdStroops7: minAmountLd,
      feeDetailsCount: feeDetails.length,
      nativeFeeStroops,
      zroFee,
    };
  });
}

/**
 * Builds and simulates a single-signature LayerZero V2 `OFT.send(from, send_param, fee, refund_address)` transaction.
 */
export async function buildLayerZeroOftSendXdr(input: {
  oftContractId: ContractAddress;
  from: ClassicAddress;
  refundAddress?: ClassicAddress | undefined;
  dstEid: number;
  toBytes32: Uint8Array;
  amountLdStroops7: bigint;
  minAmountLdStroops7: bigint;
  nativeFeeStroops: bigint;
  zroFee?: bigint | undefined;
  rpcUrls: readonly string[];
  networkPassphrase: string;
}): Promise<{ unsignedXdr: string; minResourceFee: string }> {
  if (!StrKey.isValidContract(input.oftContractId)) {
    throw new Error(`Invalid OFT contract ID: ${input.oftContractId}`);
  }
  if (!StrKey.isValidEd25519PublicKey(input.from)) {
    throw new Error(`Invalid sender G... address: ${input.from}`);
  }
  const refundAddress = input.refundAddress ?? input.from;
  if (!StrKey.isValidEd25519PublicKey(refundAddress)) {
    throw new Error(`Invalid refund G... address: ${refundAddress}`);
  }

  const sendParam = buildLayerZeroSendParamScVal({
    dstEid: input.dstEid,
    toBytes32: input.toBytes32,
    amountLdStroops7: input.amountLdStroops7,
    minAmountLdStroops7: input.minAmountLdStroops7,
  });
  const fee = buildLayerZeroMessagingFeeScVal({
    nativeFeeStroops: input.nativeFeeStroops,
    zroFee: input.zroFee,
  });

  return withBridgeRpcFailover(input.rpcUrls, async (server) => {
    const oft = new Contract(input.oftContractId);
    const op = oft.call(
      "send",
      new Address(input.from).toScVal(),
      sendParam,
      fee,
      new Address(refundAddress).toScVal(),
    );
    return buildAndSimulateWriteTx({
      server,
      caller: input.from,
      networkPassphrase: input.networkPassphrase,
      operation: op,
    });
  });
}
