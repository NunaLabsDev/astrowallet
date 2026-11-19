import { sha256 } from "@noble/hashes/sha2.js";
import {
  defaultCapabilitiesForKind,
  type AccountCapabilities,
  type ClassicAddress,
  type ContractAddress,
  type StellarAddress,
} from "@astrowallet/domain";
import {
  Address,
  Asset,
  Operation,
  StrKey,
  nativeToScVal,
  xdr,
} from "@stellar/stellar-sdk";

export interface CounterfactualSmartAccountInput {
  guardianAddress: ClassicAddress;
  wasmHashHex: string;
  networkPassphrase: string;
  credentialIdB64?: string | undefined;
  dailySpendLimitXlm?: string | undefined;
}

export interface SmartAccountDescriptor {
  readonly contractAddress: ContractAddress;
  readonly guardianAddress: ClassicAddress;
  readonly wasmHashHex: string;
  readonly saltHex: string;
  readonly dailySpendLimitXlm: string;
  readonly capabilities: AccountCapabilities;
}

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string, expectedLength?: number): Uint8Array {
  const cleaned = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error("Expected a valid even-length hexadecimal string");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  if (expectedLength !== undefined && out.length !== expectedLength) {
    throw new Error(`Expected ${expectedLength} bytes, got ${out.length}`);
  }
  return out;
}

/**
 * Computes the deterministic Stellar CAP-46 counterfactual C... Soroban Smart Account address
 * deployed by the user's SEP-0005 G... Recovery Guardian.
 */
export function deriveCounterfactualSmartAccount(
  input: CounterfactualSmartAccountInput,
): SmartAccountDescriptor {
  if (!/^[a-fA-F0-9]{64}$/.test(input.wasmHashHex)) {
    throw new Error("wasmHashHex must be a 64-character hex string");
  }
  if (!StrKey.isValidEd25519PublicKey(input.guardianAddress)) {
    throw new Error("guardianAddress must be a valid Classic G... address");
  }

  const saltSeed = [
    "astrowallet:smart-account:v1",
    input.guardianAddress,
    input.wasmHashHex.toLowerCase(),
    input.credentialIdB64 ?? "default",
  ].join(":");
  const saltBytes = sha256(new TextEncoder().encode(saltSeed));
  const networkId = sha256(new TextEncoder().encode(input.networkPassphrase));

  const fromAddress = new xdr.ContractIdPreimageFromAddress({
    address: new Address(input.guardianAddress).toScAddress(),
    salt: saltBytes,
  });
  const preimage = xdr.HashIdPreimage.envelopeTypeContractId(
    new xdr.HashIdPreimageContractId({
      networkId: networkId,
      contractIdPreimage: xdr.ContractIdPreimage.contractIdPreimageFromAddress(fromAddress),
    }),
  );

  const contractHash = sha256(preimage.toXDR());
  const contractAddress = StrKey.encodeContract(
    contractHash,
  ) as ContractAddress;

  return {
    contractAddress,
    guardianAddress: input.guardianAddress,
    wasmHashHex: input.wasmHashHex.toLowerCase(),
    saltHex: bytesToHex(saltBytes),
    dailySpendLimitXlm: input.dailySpendLimitXlm ?? "500.00",
    capabilities: defaultCapabilitiesForKind("smart"),
  };
}

/**
 * Builds the Soroban `createCustomContract` CAP-46 operation deploying a counterfactual
 * Smart Account C... deterministically from the user's G... guardian address and salt.
 */
export function buildDeploySmartAccountOperation(input: {
  guardianAddress: ClassicAddress;
  wasmHashHex: string;
  saltHex: string;
}): xdr.Operation {
  if (!StrKey.isValidEd25519PublicKey(input.guardianAddress)) {
    throw new Error("guardianAddress must be a valid Classic G... address");
  }
  const wasmHash = hexToBytes(input.wasmHashHex, 32);
  const salt = hexToBytes(input.saltHex, 32);

  return Operation.createCustomContract({
    address: new Address(input.guardianAddress),
    wasmHash: wasmHash,
    salt: salt,
  });
}

/**
 * Resolves the canonical Stellar Asset Contract (SAC) C... address for XLM or any classic asset.
 */
export function resolveSacContractId(input: {
  assetCode: string;
  assetIssuer?: string | undefined;
  networkPassphrase: string;
}): ContractAddress {
  const asset =
    input.assetCode === "XLM" && !input.assetIssuer
      ? Asset.native()
      : new Asset(input.assetCode, input.assetIssuer ?? "");
  return asset.contractId(input.networkPassphrase) as ContractAddress;
}

/**
 * Builds a 1-tap SAC `transfer(from, to, amount)` Soroban operation bridging linked G... and C... accounts.
 */
export function buildSacTransferOperation(input: {
  sacContractId: ContractAddress;
  fromAddress: StellarAddress;
  toAddress: StellarAddress;
  amountStroops: bigint;
}): xdr.Operation {
  if (input.amountStroops <= 0n) {
    throw new Error("amountStroops must be positive");
  }

  return Operation.invokeContractFunction({
    contract: input.sacContractId,
    function: "transfer",
    args: [
      new Address(input.fromAddress).toScVal(),
      new Address(input.toAddress).toScVal(),
      nativeToScVal(input.amountStroops, { type: "i128" }),
    ],
  });
}

export type RelaySubmissionPayload =
  | {
      mode: "soroban";
      funcXdrBase64: string;
      authEntriesXdrBase64: readonly string[];
    }
  | {
      mode: "feebump";
      signedTxXdrBase64: string;
    };

export interface GuardianRecoveryRotationInput {
  contractAddress: ContractAddress;
  currentGuardianAddress: ClassicAddress;
  newGuardianAddress: ClassicAddress;
  newPasskeyPubKeyHex?: string | undefined;
}

/**
 * Builds a Soroban `rotate_guardian` invocation to rotate a Smart Account's G... Recovery Guardian
 * (and optional secp256r1 passkey signer) cleanly on-chain.
 */
export function buildGuardianRecoveryRotationOperation(
  input: GuardianRecoveryRotationInput,
): xdr.Operation {
  if (!StrKey.isValidContract(input.contractAddress)) {
    throw new Error("Invalid Soroban Smart Account C... contract address");
  }
  if (!StrKey.isValidEd25519PublicKey(input.currentGuardianAddress)) {
    throw new Error("Invalid current Classic G... Recovery Guardian address");
  }
  if (!StrKey.isValidEd25519PublicKey(input.newGuardianAddress)) {
    throw new Error("Invalid new Classic G... Recovery Guardian address");
  }
  if (input.currentGuardianAddress === input.newGuardianAddress) {
    throw new Error("New Recovery Guardian address must differ from current Guardian");
  }

  return Operation.invokeContractFunction({
    contract: input.contractAddress,
    function: "rotate_guardian",
    args: [
      new Address(input.currentGuardianAddress).toScVal(),
      new Address(input.newGuardianAddress).toScVal(),
      nativeToScVal(input.newPasskeyPubKeyHex ?? "", { type: "string" }),
    ],
  });
}
