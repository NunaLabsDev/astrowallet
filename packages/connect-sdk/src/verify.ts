import type { AstroNetwork, LoginResult } from "./types.js";

const SEP53_PREFIX = "Stellar Signed Message:\n";
const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CLASSIC_ACCOUNT_VERSION_BYTE = 6 << 3;

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function decodeBase32(encoded: string): Uint8Array {
  let buffer = 0;
  let bitsLeft = 0;
  const bytes: number[] = [];
  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (!ch) throw new Error("Empty base32 character");
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) throw new Error(`Invalid base32 character "${ch}"`);
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

/**
 * Pure StrKey G... decoder without depending on `@stellar/stellar-sdk`.
 */
export function decodeStellarClassicPublicKey(address: string): Uint8Array {
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    throw new Error("Invalid Classic Stellar public key");
  }
  const decoded = decodeBase32(address);
  if (decoded.length !== 35 || decoded[0] !== CLASSIC_ACCOUNT_VERSION_BYTE) {
    throw new Error("Invalid Stellar StrKey payload");
  }
  const expectedCrc = crc16Xmodem(decoded.subarray(0, 33));
  const actualCrc = (decoded[33] ?? 0) | ((decoded[34] ?? 0) << 8);
  if (expectedCrc !== actualCrc) {
    throw new Error("StrKey checksum mismatch");
  }
  return new Uint8Array(decoded.subarray(1, 33));
}

function decodeBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

export async function sha256Hex(raw: string): Promise<string> {
  const bytes = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Verifies a Stellar SEP-53 Ed25519 signature offline against a G... public address.
 */
export async function verifySep53Signature(input: {
  address: string;
  message: string;
  signatureBase64: string;
}): Promise<boolean> {
  try {
    const publicKey = decodeStellarClassicPublicKey(input.address);
    const sigBytes = decodeBase64(input.signatureBase64);
    if (sigBytes.length !== 64) {
      return false;
    }
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${SEP53_PREFIX}${input.message}`),
    );
    const key = await crypto.subtle.importKey(
      "raw",
      publicKey as BufferSource,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      { name: "Ed25519" },
      key,
      sigBytes as BufferSource,
      digest,
    );
  } catch {
    return false;
  }
}

export interface ExpectedLoginProofClaims {
  network?: AstroNetwork | undefined;
  botUsername?: string | undefined;
  nonce?: string | undefined;
  domain?: string | undefined;
  nowUnixSeconds?: number | undefined;
}

/**
 * Verifies an AstroConnect Sign-In proof offline (SEP-53 signature + challenge field bindings + expiry).
 */
export async function verifyAstroLoginProof(
  proof: Pick<LoginResult, "address" | "challengeMessage" | "signatureBase64" | "network">,
  expected: ExpectedLoginProofClaims = {},
): Promise<{ valid: true } | { valid: false; reason: string }> {
  const sigOk = await verifySep53Signature({
    address: proof.address,
    message: proof.challengeMessage,
    signatureBase64: proof.signatureBase64,
  });
  if (!sigOk) {
    return { valid: false, reason: "Invalid SEP-53 Ed25519 signature" };
  }

  const lines = proof.challengeMessage.split("\n");
  if (lines[0] !== "AstroConnect Sign-In v1") {
    return { valid: false, reason: "Unexpected challenge header" };
  }

  const getField = (prefix: string): string | undefined => {
    const line = lines.find((l) => l.startsWith(prefix));
    return line ? line.slice(prefix.length).trim() : undefined;
  };

  const net = getField("Network:");
  const expectedNet = expected.network ?? proof.network;
  if (net !== expectedNet) {
    return { valid: false, reason: "Network mismatch in challenge" };
  }

  if (expected.botUsername) {
    const cleanBot = expected.botUsername.trim().replace(/^@/, "");
    const escapedBot = cleanBot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const appLine = getField("App:") ?? "";
    const trailingBotPattern = new RegExp(`\\s\\(@${escapedBot}\\)$`, "i");
    const botTagMatches = appLine.match(/\(@[A-Za-z0-9_]+\)/g) ?? [];
    if (!trailingBotPattern.test(appLine) || botTagMatches.length !== 1) {
      return { valid: false, reason: "Bot username mismatch in challenge" };
    }
  }

  if (expected.nonce && getField("Nonce:") !== expected.nonce) {
    return { valid: false, reason: "Nonce mismatch in challenge" };
  }

  if (expected.domain && getField("Domain:") !== expected.domain.trim()) {
    return { valid: false, reason: "Domain mismatch in challenge" };
  }

  const expiresAtRaw = getField("Expires At:");
  const expiresAt = expiresAtRaw ? Number(expiresAtRaw) : Number.NaN;
  const nowSec = expected.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(expiresAt) || expiresAt <= nowSec) {
    return { valid: false, reason: "Challenge expired" };
  }

  return { valid: true };
}
