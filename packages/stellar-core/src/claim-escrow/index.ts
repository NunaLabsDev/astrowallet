import type {
  ClassicAddress,
  ContractAddress,
  StellarAddress,
} from "@astrowallet/domain";
import {
  Address,
  Keypair,
  Operation,
  StrKey,
  nativeToScVal,
  type xdr,
} from "@stellar/stellar-sdk";

const CLAIM_SIGN_PREFIX = new TextEncoder().encode("AW_CLAIM_V2:");

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) {
    out += b.toString(16).padStart(2, "0");
  }
  return out;
}

function hexToBytes(hex: string, expectedBytes?: number): Uint8Array {
  const cleaned = hex.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]+$/.test(cleaned) || cleaned.length % 2 !== 0) {
    throw new Error("Invalid hexadecimal string");
  }
  const out = new Uint8Array(cleaned.length / 2);
  for (let i = 0; i < cleaned.length; i += 2) {
    out[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
  }
  if (expectedBytes !== undefined && out.length !== expectedBytes) {
    throw new Error(`Expected ${expectedBytes} bytes, got ${out.length}`);
  }
  return out;
}

export interface EphemeralClaimKey {
  publicKeyHex: string;
  secretSeedHex: string;
  keypair: Keypair;
}

/**
 * Generates an ephemeral Ed25519 claim keypair for front-run-resistant Telegram Claim Links.
 */
export function generateEphemeralClaimKey(): EphemeralClaimKey {
  const keypair = Keypair.random();
  return {
    publicKeyHex: bytesToHex(keypair.rawPublicKey()),
    secretSeedHex: bytesToHex(keypair.rawSecretKey()),
    keypair,
  };
}

/**
 * Constructs the canonical domain-separated payload verified on-chain by `ClaimEscrowContract::claim`:
 * `"AW_CLAIM_V2:" || escrow_address.to_xdr() || claim_id || recipient_address.to_xdr()`.
 */
export function buildClaimEscrowSignPayload(
  escrowContractId: ContractAddress,
  claimIdHex: string,
  recipientAddress: StellarAddress,
): Uint8Array {
  if (!StrKey.isValidContract(escrowContractId)) {
    throw new Error("Invalid claim escrow C... contract address");
  }
  const claimIdBytes = hexToBytes(claimIdHex, 32);
  const escrowXdr = new Uint8Array(new Address(escrowContractId).toScVal().toXDR());
  const recipientXdr = new Uint8Array(new Address(recipientAddress).toScVal().toXDR());

  const payload = new Uint8Array(
    CLAIM_SIGN_PREFIX.length +
      escrowXdr.length +
      claimIdBytes.length +
      recipientXdr.length,
  );

  let offset = 0;
  payload.set(CLAIM_SIGN_PREFIX, offset);
  offset += CLAIM_SIGN_PREFIX.length;
  payload.set(escrowXdr, offset);
  offset += escrowXdr.length;
  payload.set(claimIdBytes, offset);
  offset += claimIdBytes.length;
  payload.set(recipientXdr, offset);
  return payload;
}

/**
 * Signs a recipient-bound Claim Escrow authorization using the link's 32-byte ephemeral seed.
 */
export function signClaimEscrowPayload(
  secretSeedHex: string,
  escrowContractId: ContractAddress,
  claimIdHex: string,
  recipientAddress: StellarAddress,
): string {
  const seed = hexToBytes(secretSeedHex, 32);
  const kp = Keypair.fromRawEd25519Seed(seed);
  try {
    const payload = buildClaimEscrowSignPayload(
      escrowContractId,
      claimIdHex,
      recipientAddress,
    );
    const sig = kp.sign(payload);
    return bytesToHex(new Uint8Array(sig));
  } finally {
    seed.fill(0);
  }
}

export function buildCreateClaimOperation(input: {
  escrowContractId: ContractAddress;
  claimIdHex: string;
  senderAddress: ClassicAddress;
  tokenContractId: ContractAddress;
  amountStroops: bigint;
  claimPubkeyHex: string;
  expiresAtUnix: number;
}): xdr.Operation {
  if (input.amountStroops <= 0n) {
    throw new Error("Claim escrow amount must be positive");
  }
  const claimId = hexToBytes(input.claimIdHex, 32);
  const claimPubkey = hexToBytes(input.claimPubkeyHex, 32);

  return Operation.invokeContractFunction({
    contract: input.escrowContractId,
    function: "create_claim",
    args: [
      nativeToScVal(claimId, { type: "bytes" }),
      new Address(input.senderAddress).toScVal(),
      new Address(input.tokenContractId).toScVal(),
      nativeToScVal(input.amountStroops, { type: "i128" }),
      nativeToScVal(claimPubkey, { type: "bytes" }),
      nativeToScVal(BigInt(Math.trunc(input.expiresAtUnix)), { type: "u64" }),
    ],
  });
}

export function buildClaimOperation(input: {
  escrowContractId: ContractAddress;
  claimIdHex: string;
  recipientAddress: StellarAddress;
  signatureHex: string;
}): xdr.Operation {
  const claimId = hexToBytes(input.claimIdHex, 32);
  const signature = hexToBytes(input.signatureHex, 64);

  return Operation.invokeContractFunction({
    contract: input.escrowContractId,
    function: "claim",
    args: [
      nativeToScVal(claimId, { type: "bytes" }),
      new Address(input.recipientAddress).toScVal(),
      nativeToScVal(signature, { type: "bytes" }),
    ],
  });
}

export function buildCancelClaimOperation(input: {
  escrowContractId: ContractAddress;
  claimIdHex: string;
}): xdr.Operation {
  const claimId = hexToBytes(input.claimIdHex, 32);
  return Operation.invokeContractFunction({
    contract: input.escrowContractId,
    function: "cancel_claim",
    args: [nativeToScVal(claimId, { type: "bytes" })],
  });
}

export function buildRefundExpiredOperation(input: {
  escrowContractId: ContractAddress;
  claimIdHex: string;
}): xdr.Operation {
  const claimId = hexToBytes(input.claimIdHex, 32);
  return Operation.invokeContractFunction({
    contract: input.escrowContractId,
    function: "refund_expired",
    args: [nativeToScVal(claimId, { type: "bytes" })],
  });
}
