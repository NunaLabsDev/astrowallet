import type {
  ClassicAddress,
  ContractAddress,
  StellarNetwork,
} from "@astrowallet/domain";
import { verifyAsync } from "@noble/ed25519";
import { decodeClassicPublicKey } from "./strkey.js";

const SEP53_PREFIX = "Stellar Signed Message:\n";

export interface ConnectChallengePayload {
  challengeId: string;
  network: StellarNetwork;
  telegramUserId: string;
  usernameLower?: string | undefined;
  issuedAt: number;
  expiresAt: number;
}

export interface VerifyConnectSignatureInput {
  address: ClassicAddress;
  message: string;
  signatureBase64: string;
}

interface MinimalSubtleDigest {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

function getCryptoDigest(): { subtle: MinimalSubtleDigest; encode: (s: string) => Uint8Array } {
  const g = globalThis as unknown as {
    crypto?: { subtle?: MinimalSubtleDigest };
    TextEncoder?: new () => { encode(input: string): Uint8Array };
  };
  const subtle = g.crypto?.subtle;
  const Encoder = g.TextEncoder;
  if (!subtle || !Encoder) {
    throw new Error("Web Crypto SubtleCrypto and TextEncoder are required");
  }
  const encoder = new Encoder();
  return {
    subtle,
    encode: (s: string) => encoder.encode(s),
  };
}

function decodeBase64Bytes(b64: string): Uint8Array {
  const atobFn = (globalThis as unknown as { atob?: (s: string) => string }).atob;
  if (!atobFn) {
    throw new Error("Global atob helper is required");
  }
  const bin = atobFn(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

/**
 * Produces a deterministic canonical challenge message signed by the user's wallet.
 */
export function formatConnectChallengeMessage(payload: ConnectChallengePayload): string {
  return [
    "astrowallet-connect:v1",
    payload.network,
    payload.telegramUserId,
    payload.challengeId,
    String(payload.issuedAt),
    String(payload.expiresAt),
  ].join(":");
}

/**
 * Verifies an Ed25519 SEP-53 challenge signature against a Stellar Classic G... address.
 */
export async function verifyConnectSignature(
  input: VerifyConnectSignatureInput,
): Promise<boolean> {
  try {
    const publicKey = decodeClassicPublicKey(input.address);
    const sigBytes = decodeBase64Bytes(input.signatureBase64);
    if (sigBytes.length !== 64) {
      return false;
    }

    const { subtle, encode } = getCryptoDigest();
    const digestBuf = await subtle.digest(
      "SHA-256",
      encode(`${SEP53_PREFIX}${input.message}`),
    );
    return await verifyAsync(sigBytes, new Uint8Array(digestBuf), publicKey);
  } catch {
    return false;
  }
}

/**
 * Formats the canonical SEP-53 challenge message proving a Classic G... Recovery Guardian
 * authorizes linking a paired Soroban Smart Account C... address.
 */
export function formatSmartAccountLinkMessage(
  challengeMessage: string,
  contractAddress: ContractAddress,
): string {
  return `${challengeMessage}:smart:${contractAddress}`;
}

export interface VerifySmartAccountGuardianSignatureInput {
  contractAddress: ContractAddress;
  guardianAddress: ClassicAddress;
  challengeMessage: string;
  signatureBase64: string;
}

/**
 * Verifies a Soroban Smart Account C... link challenge via its paired Classic G... Guardian's Ed25519 signature.
 */
export async function verifySmartAccountGuardianSignature(
  input: VerifySmartAccountGuardianSignatureInput,
): Promise<boolean> {
  if (!/^C[A-Z2-7]{55}$/.test(input.contractAddress)) {
    return false;
  }
  const boundMessage = formatSmartAccountLinkMessage(
    input.challengeMessage,
    input.contractAddress,
  );
  return verifyConnectSignature({
    address: input.guardianAddress,
    message: boundMessage,
    signatureBase64: input.signatureBase64,
  });
}
