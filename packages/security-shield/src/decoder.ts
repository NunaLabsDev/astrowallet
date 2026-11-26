import {
  Address,
  FeeBumpTransaction,
  TransactionBuilder,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";

export interface DecodedMemo {
  type: "none" | "text" | "id" | "hash" | "return";
  value?: string | undefined;
}

export interface DecodedAssetRef {
  code: string;
  issuer?: string | undefined;
}

export interface DecodedSorobanInvocation {
  contractId?: string | undefined;
  functionName: string;
  args: readonly string[];
  subInvocations: readonly DecodedSorobanInvocation[];
}

export interface DecodedOperation {
  type: string;
  source?: string | undefined;
  destination?: string | undefined;
  amount?: string | undefined;
  asset?: DecodedAssetRef | undefined;
  sendAsset?: DecodedAssetRef | undefined;
  destAsset?: DecodedAssetRef | undefined;
  signerKey?: string | undefined;
  signerWeight?: number | undefined;
  masterWeight?: number | undefined;
  lowThreshold?: number | undefined;
  medThreshold?: number | undefined;
  highThreshold?: number | undefined;
  homeDomain?: string | undefined;
  sponsoredId?: string | undefined;
  soroban?: DecodedSorobanInvocation | undefined;
}

export interface DecodedTransactionSummary {
  isFeeBump: boolean;
  feeSource?: string | undefined;
  sourceAccount: string;
  feeStroops: string;
  sorobanResourceFeeStroops?: string | undefined;
  memo: DecodedMemo;
  operations: readonly DecodedOperation[];
}

function safeFormatScVal(val: xdr.ScVal): string {
  try {
    const native = scValToNative(val);
    if (native instanceof Uint8Array) {
      return Array.from(native, (b) => b.toString(16).padStart(2, "0")).join("");
    }
    if (typeof native === "bigint") return native.toString();
    if (typeof native === "string") return native;
    if (typeof native === "number" || typeof native === "boolean") return String(native);
    return JSON.stringify(native);
  } catch {
    return val.type;
  }
}

function decodeFunctionName(raw: { toString(): string } | Uint8Array | string): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof Uint8Array) return new TextDecoder().decode(raw);
  return raw.toString();
}

function decodeAuthInvocation(
  inv: xdr.SorobanAuthorizedInvocation,
): DecodedSorobanInvocation | null {
  const fn = inv.function;
  const subList: DecodedSorobanInvocation[] = [];
  for (const child of inv.subInvocations) {
    const decodedChild = decodeAuthInvocation(child);
    if (decodedChild) subList.push(decodedChild);
  }

  if (fn.type === "sorobanAuthorizedFunctionTypeContractFn") {
    const contractFn = fn.contractFn;
    let contractId: string | undefined;
    try {
      contractId = Address.fromScAddress(contractFn.contractAddress).toString();
    } catch {
      contractId = undefined;
    }
    const fnName = decodeFunctionName(contractFn.functionName);
    const args = contractFn.args.map(safeFormatScVal);
    return {
      contractId,
      functionName: fnName,
      args,
      subInvocations: subList,
    };
  }

  return {
    functionName: fn.type,
    args: [],
    subInvocations: subList,
  };
}

function extractSorobanOp(opRecord: Record<string, unknown>): DecodedSorobanInvocation | undefined {
  const func = opRecord.func as xdr.HostFunction | undefined;
  const auth = (opRecord.auth as xdr.SorobanAuthorizationEntry[] | undefined) ?? [];

  const subInvocations: DecodedSorobanInvocation[] = [];
  for (const entry of auth) {
    const root = decodeAuthInvocation(entry.rootInvocation);
    if (root) {
      subInvocations.push(root);
    }
  }

  if (!func) return undefined;

  if (func.type === "hostFunctionTypeInvokeContract") {
    const invokeArgs = func.invokeContract;
    let contractId: string | undefined;
    try {
      contractId = Address.fromScAddress(invokeArgs.contractAddress).toString();
    } catch {
      contractId = undefined;
    }
    const functionName = decodeFunctionName(invokeArgs.functionName);
    const args = invokeArgs.args.map(safeFormatScVal);
    return {
      contractId,
      functionName,
      args,
      subInvocations,
    };
  }

  return {
    functionName: func.type,
    args: [],
    subInvocations,
  };
}

function extractAssetRef(raw: unknown): DecodedAssetRef | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const asset = raw as { isNative?: () => boolean; getCode?: () => string; getIssuer?: () => string; code?: string; issuer?: string };
  if (typeof asset.isNative === "function" && asset.isNative()) {
    return { code: "XLM" };
  }
  const code = typeof asset.getCode === "function" ? asset.getCode() : asset.code;
  const issuer = typeof asset.getIssuer === "function" ? asset.getIssuer() : asset.issuer;
  if (!code) return undefined;
  return {
    code,
    issuer: issuer || undefined,
  };
}

/**
 * Pure TypeScript zero-WASM transaction envelope decoder.
 * Extracts Classic and Soroban operations, arguments, and nested authorization trees.
 */
export function decodeTransactionEnvelope(
  xdrBase64: string,
  networkPassphrase: string,
): DecodedTransactionSummary {
  const parsed = TransactionBuilder.fromXDR(xdrBase64, networkPassphrase);
  const isFeeBump = parsed instanceof FeeBumpTransaction;
  const innerTx = isFeeBump ? parsed.innerTransaction : parsed;

  const memoType = innerTx.memo.type as DecodedMemo["type"];
  let memoValue: string | undefined;
  if (innerTx.memo.value) {
    if (typeof innerTx.memo.value === "string") {
      memoValue = innerTx.memo.value;
    } else if (innerTx.memo.value instanceof Uint8Array) {
      memoValue = Array.from(innerTx.memo.value)
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
    } else {
      memoValue = String(innerTx.memo.value);
    }
  }

  const operations: DecodedOperation[] = innerTx.operations.map((op) => {
    const rec = op as unknown as Record<string, unknown>;
    const type = String(rec.type ?? "unknown");
    const source = typeof rec.source === "string" ? rec.source : undefined;
    const destination = typeof rec.destination === "string" ? rec.destination : undefined;
    const amount =
      typeof rec.amount === "string"
        ? rec.amount
        : typeof rec.startingBalance === "string"
          ? rec.startingBalance
          : typeof rec.sendAmount === "string"
            ? rec.sendAmount
            : typeof rec.destAmount === "string"
              ? rec.destAmount
              : typeof rec.destMin === "string"
                ? rec.destMin
                : undefined;

    const asset = extractAssetRef(rec.asset ?? rec.line);
    const sendAsset = extractAssetRef(rec.sendAsset);
    const destAsset = extractAssetRef(rec.destAsset);

    let signerKey: string | undefined;
    let signerWeight: number | undefined;
    if (rec.signer && typeof rec.signer === "object") {
      const s = rec.signer as {
        ed25519PublicKey?: string;
        sha256Hash?: string;
        preAuthTx?: string;
        weight?: number | string;
      };
      signerKey = s.ed25519PublicKey ?? s.sha256Hash ?? s.preAuthTx;
      signerWeight =
        typeof s.weight === "number"
          ? s.weight
          : typeof s.weight === "string"
            ? Number(s.weight)
            : undefined;
    }

    const numOrUndef = (v: unknown): number | undefined =>
      typeof v === "number" ? v : typeof v === "string" && v !== "" ? Number(v) : undefined;

    return {
      type,
      source,
      destination,
      amount,
      asset,
      sendAsset,
      destAsset,
      signerKey,
      signerWeight,
      masterWeight: numOrUndef(rec.masterWeight),
      lowThreshold: numOrUndef(rec.lowThreshold),
      medThreshold: numOrUndef(rec.medThreshold),
      highThreshold: numOrUndef(rec.highThreshold),
      homeDomain: typeof rec.homeDomain === "string" ? rec.homeDomain : undefined,
      sponsoredId: typeof rec.sponsoredId === "string" ? rec.sponsoredId : undefined,
      soroban: type === "invokeHostFunction" ? extractSorobanOp(rec) : undefined,
    };
  });

  const txExt = (
    innerTx as unknown as {
      tx?: {
        ext?: {
          type?: string;
          sorobanData?: { resourceFee?: bigint | { toString(): string } };
        };
      };
    }
  ).tx?.ext;
  const sorobanResourceFeeStroops =
    txExt?.type === "sorobanData" && txExt.sorobanData?.resourceFee !== undefined
      ? txExt.sorobanData.resourceFee.toString()
      : undefined;

  return {
    isFeeBump,
    feeSource: isFeeBump ? parsed.feeSource : undefined,
    sourceAccount: innerTx.source,
    feeStroops: String(parsed.fee),
    sorobanResourceFeeStroops,
    memo: {
      type: memoType,
      value: memoValue,
    },
    operations,
  };
}

export interface DecodedHostFunction {
  type: string;
  contractId?: string | undefined;
  functionName?: string | undefined;
  args?: readonly string[] | undefined;
}

/**
 * Decodes a Base64 `HostFunction` XDR (Soroban relay payloads) without exposing the SDK to callers.
 * Throws on malformed XDR so relays can reject with HTTP 400.
 */
export function decodeHostFunctionXdr(funcXdrBase64: string): DecodedHostFunction {
  const hostFn = xdr.HostFunction.fromXDR(funcXdrBase64.trim(), "base64");
  if (hostFn.type === "hostFunctionTypeInvokeContract") {
    const invoke = hostFn.invokeContract;
    let contractId: string | undefined;
    try {
      contractId = Address.fromScAddress(invoke.contractAddress).toString();
    } catch {
      contractId = undefined;
    }
    return {
      type: hostFn.type,
      contractId,
      functionName: decodeFunctionName(invoke.functionName),
      args: invoke.args.map(safeFormatScVal),
    };
  }
  return { type: hostFn.type };
}

export interface DecodedAuthEntrySummary {
  kind: "hash_id_preimage" | "soroban_authorization_entry";
  credentialsType?: string | undefined;
  networkIdHex?: string | undefined;
  address?: string | undefined;
  nonce?: string | undefined;
  signatureExpirationLedger?: number | undefined;
  invocation: DecodedSorobanInvocation;
}

function bytesToHex(input: Uint8Array | { toBytes(): Uint8Array }): string {
  const bytes = input instanceof Uint8Array ? input : input.toBytes();
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function safeScAddressToString(scAddr: unknown): string | undefined {
  if (!scAddr || typeof scAddr !== "object") return undefined;
  try {
    return Address.fromScAddress(scAddr as xdr.ScAddress).toString();
  } catch {
    return undefined;
  }
}

/**
 * Decodes either a Soroban `HashIdPreimage` (both legacy and `WithAddress` arms)
 * or a `SorobanAuthorizationEntry` Base64 XDR into an inspectable invocation tree.
 */
export function decodeAuthEntryXdr(rawEntryXdr: string): DecodedAuthEntrySummary {
  const cleaned = rawEntryXdr.trim();
  if (!cleaned) {
    throw new Error("Authorization entry XDR is required");
  }

  let preimage: xdr.HashIdPreimage | null = null;
  try {
    preimage = xdr.HashIdPreimage.fromXDR(cleaned, "base64");
  } catch {
    preimage = null;
  }

  if (preimage !== null) {
    if (preimage.type === "envelopeTypeSorobanAuthorization") {
      const auth = preimage.sorobanAuthorization;
      const invocation = decodeAuthInvocation(auth.invocation);
      if (!invocation) {
        throw new Error("Unable to decode Soroban authorization invocation");
      }
      return {
        kind: "hash_id_preimage",
        networkIdHex: bytesToHex(auth.networkId),
        nonce: auth.nonce.toString(),
        signatureExpirationLedger: Number(auth.signatureExpirationLedger),
        invocation,
      };
    }

    if (preimage.type === "envelopeTypeSorobanAuthorizationWithAddress") {
      const auth = preimage.sorobanAuthorizationWithAddress;
      const invocation = decodeAuthInvocation(auth.invocation);
      if (!invocation) {
        throw new Error("Unable to decode Soroban authorization invocation");
      }
      return {
        kind: "hash_id_preimage",
        networkIdHex: bytesToHex(auth.networkId),
        address: safeScAddressToString(auth.address),
        nonce: auth.nonce.toString(),
        signatureExpirationLedger: Number(auth.signatureExpirationLedger),
        invocation,
      };
    }

    throw new Error(`Unsupported HashIdPreimage type for Soroban auth: ${preimage.type}`);
  }

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(cleaned, "base64");
  } catch (err) {
    throw new Error(
      `Invalid Soroban authorization entry XDR: ${err instanceof Error ? err.message : "decode failed"}`,
    );
  }

  const invocation = decodeAuthInvocation(entry.rootInvocation);
  if (!invocation) {
    throw new Error("Unable to decode SorobanAuthorizationEntry root invocation");
  }

  const credentialsType = entry.credentials.type;
  const credRecord = entry.credentials as unknown as Record<string, unknown>;
  const addrStruct = (
    credRecord.address ??
    credRecord.addressV2 ??
    credRecord.addressWithDelegates
  ) as
    | {
        address?: unknown;
        nonce?: { toString(): string };
        signatureExpirationLedger?: number | bigint;
      }
    | undefined;

  return {
    kind: "soroban_authorization_entry",
    credentialsType,
    address: addrStruct ? safeScAddressToString(addrStruct.address) : undefined,
    nonce: addrStruct?.nonce ? addrStruct.nonce.toString() : undefined,
    signatureExpirationLedger:
      addrStruct?.signatureExpirationLedger !== undefined
        ? Number(addrStruct.signatureExpirationLedger)
        : undefined,
    invocation,
  };
}

/**
 * Recomputes AstroWallet's CAP-46 counterfactual Soroban Smart Account `C...` address
 * from its `G...` guardian, WASM hash, network passphrase, and optional credential ID.
 */
export async function deriveCounterfactualContractAddress(input: {
  guardianAddress: string;
  wasmHashHex: string;
  networkPassphrase: string;
  credentialIdB64?: string | undefined;
}): Promise<string> {
  const { StrKey } = await import("@stellar/stellar-sdk");
  if (!StrKey.isValidEd25519PublicKey(input.guardianAddress)) {
    throw new Error("Invalid Classic G... guardianAddress");
  }
  const cleanHash = input.wasmHashHex.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(cleanHash)) {
    throw new Error("wasmHashHex must be a 64-character hex string");
  }

  const encoder = new TextEncoder();
  const saltSeed = [
    "astrowallet:smart-account:v1",
    input.guardianAddress,
    cleanHash,
    input.credentialIdB64 ?? "default",
  ].join(":");

  const saltBuf = await crypto.subtle.digest("SHA-256", encoder.encode(saltSeed));
  const netBuf = await crypto.subtle.digest("SHA-256", encoder.encode(input.networkPassphrase));

  const fromAddress = new xdr.ContractIdPreimageFromAddress({
    address: new Address(input.guardianAddress).toScAddress(),
    salt: new Uint8Array(saltBuf),
  });
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: new Uint8Array(netBuf),
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(fromAddress),
    }),
  );
  const xdrBytes = Uint8Array.from(preimage.toXDR());
  const contractBuf = await crypto.subtle.digest("SHA-256", xdrBytes);
  return StrKey.encodeContract(new Uint8Array(contractBuf));
}
