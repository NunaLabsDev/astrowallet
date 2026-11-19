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
  type xdr,
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

/**
 * Computes a deterministic counterfactual C... Soroban Smart Account address
 * paired with the user's SEP-0005 G... account as on-chain Recovery Guardian.
 */
export function deriveCounterfactualSmartAccount(
  input: CounterfactualSmartAccountInput,
): SmartAccountDescriptor {
  if (!/^[a-fA-F0-9]{64}$/.test(input.wasmHashHex)) {
    throw new Error("wasmHashHex must be a 64-character hex string");
  }

  const saltSeed = [
    "astrowallet:smart-account:v1",
    input.guardianAddress,
    input.wasmHashHex.toLowerCase(),
    input.credentialIdB64 ?? "default",
  ].join(":");
  const saltBytes = sha256(new TextEncoder().encode(saltSeed));
  const networkId = sha256(new TextEncoder().encode(input.networkPassphrase));
  const guardianPubKey = StrKey.decodeEd25519PublicKey(input.guardianAddress);

  // Deterministic contract ID preimage digest: sha256(networkId || "C_ID" || guardianPubKey || salt)
  const preimage = new Uint8Array(32 + 4 + 32 + 32);
  preimage.set(networkId, 0);
  preimage.set(new TextEncoder().encode("C_ID"), 32);
  preimage.set(guardianPubKey, 36);
  preimage.set(saltBytes, 68);

  const contractHash = sha256(preimage);
  const contractAddress = StrKey.encodeContract(contractHash) as ContractAddress;

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
