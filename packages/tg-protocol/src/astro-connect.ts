import type { ClassicAddress, StellarNetwork } from "@astrowallet/domain";
import { verifyConnectSignature } from "./connect-challenge.js";

export interface ConnectRequestTokenClaims {
  requestId: string;
  network: StellarNetwork;
  expiresAt: number;
}

export type VerifyConnectTokenResult =
  | { valid: true }
  | { valid: false; reason: "malformed" | "expired" | "invalid_signature" };

interface MinimalTextEncoder {
  encode(input: string): Uint8Array;
}

interface MinimalSubtleCrypto {
  importKey(
    format: "raw",
    keyData: Uint8Array,
    algorithm: { name: "HMAC"; hash: "SHA-256" },
    extractable: boolean,
    keyUsages: readonly ("sign" | "verify")[],
  ): Promise<unknown>;
  sign(algorithm: "HMAC", key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}

function getWebCrypto(): { subtle: MinimalSubtleCrypto; encoder: MinimalTextEncoder } {
  const g = globalThis as unknown as {
    crypto?: { subtle?: MinimalSubtleCrypto };
    TextEncoder?: new () => MinimalTextEncoder;
  };
  const subtle = g.crypto?.subtle;
  const Encoder = g.TextEncoder;
  if (!subtle || !Encoder) {
    throw new Error("Web Crypto SubtleCrypto and TextEncoder are required");
  }
  return { subtle, encoder: new Encoder() };
}

function toHex(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function buildCanonicalConnectMessage(claims: ConnectRequestTokenClaims): string {
  return `connect:${claims.network}:${claims.requestId}:${claims.expiresAt}`;
}

/**
 * Computes a 128-bit (32 hex chars) HMAC-SHA256 signature binding requestId, network, and expiry.
 * Compact length keeps Telegram `startapp=c-<requestId>-<sig>` comfortably under 64 characters.
 */
export async function signConnectRequestToken(
  claims: ConnectRequestTokenClaims,
  hmacSecret: string,
): Promise<string> {
  if (!hmacSecret || hmacSecret.length < 32) {
    throw new Error("INTENT_HMAC_SECRET must be at least 32 characters");
  }
  const { subtle, encoder } = getWebCrypto();
  const key = await subtle.importKey(
    "raw",
    encoder.encode(hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await subtle.sign(
    "HMAC",
    key,
    encoder.encode(buildCanonicalConnectMessage(claims)),
  );
  return toHex(sig).slice(0, 32);
}

/**
 * Verifies a compact AstroConnect request token fail-closed against expiry, network, and HMAC.
 */
export async function verifyConnectRequestToken(
  claims: ConnectRequestTokenClaims,
  signatureHex: string,
  hmacSecret: string,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyConnectTokenResult> {
  if (
    !/^[A-Za-z0-9_-]{8,32}$/.test(claims.requestId) ||
    !/^[a-f0-9]{32}$/i.test(signatureHex)
  ) {
    return { valid: false, reason: "malformed" };
  }
  if (claims.expiresAt <= nowUnixSeconds) {
    return { valid: false, reason: "expired" };
  }
  const expectedHex = await signConnectRequestToken(claims, hmacSecret);
  if (!constantTimeEqualHex(expectedHex, signatureHex.toLowerCase())) {
    return { valid: false, reason: "invalid_signature" };
  }
  return { valid: true };
}

export interface FormatAstroAuthMessageInput {
  appName: string;
  botUsername: string;
  network: StellarNetwork;
  requestId: string;
  nonce: string;
  issuedAt: number;
  expiresAt: number;
  domain?: string | undefined;
  statement?: string | undefined;
}

/**
 * Formats a deterministic, human-readable SEP-53 Sign-In with AstroWallet challenge message.
 */
export function formatAstroAuthMessage(input: FormatAstroAuthMessageInput): string {
  const cleanBot = input.botUsername.trim().replace(/^@/, "");
  const cleanApp = input.appName.trim().replace(/[\r\n]+/g, " ");
  const lines = [
    "AstroConnect Sign-In v1",
    `App: ${cleanApp} (@${cleanBot})`,
    `Network: ${input.network}`,
    `Request ID: ${input.requestId}`,
    `Nonce: ${input.nonce}`,
    `Issued At: ${input.issuedAt}`,
    `Expires At: ${input.expiresAt}`,
  ];
  if (input.domain?.trim()) {
    lines.push(`Domain: ${input.domain.trim().replace(/[\r\n]+/g, " ")}`);
  }
  if (input.statement?.trim()) {
    lines.push(`Statement: ${input.statement.trim().replace(/[\r\n]+/g, " ")}`);
  }
  return lines.join("\n");
}

/**
 * Builds a Telegram-exclusive Boomerang return URL (`https://t.me/<bot>[/<short>]?startapp=...`).
 * Never produces arbitrary external web redirects, preventing open-redirect phishing.
 */
export function buildSafeTelegramReturnUrl(
  app: {
    botUsername: string;
    miniAppShortName?: string | undefined;
    returnStartAppParam?: string | undefined;
  },
  fallbackStartParam?: string,
): string {
  const bot = app.botUsername.trim().replace(/^@/, "");
  if (!/^[A-Za-z0-9_]{5,32}$/.test(bot)) {
    throw new Error("Invalid Telegram botUsername for Boomerang return");
  }
  const short = app.miniAppShortName?.trim();
  if (short && !/^[A-Za-z0-9_]{3,64}$/.test(short)) {
    throw new Error("Invalid Telegram miniAppShortName for Boomerang return");
  }
  const base = short ? `https://t.me/${bot}/${short}` : `https://t.me/${bot}`;
  const startParam = app.returnStartAppParam?.trim() || fallbackStartParam?.trim();
  if (!startParam) {
    return base;
  }
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(startParam)) {
    throw new Error("Invalid startapp parameter for Boomerang return");
  }
  return short
    ? `${base}?startapp=${encodeURIComponent(startParam)}`
    : `${base}?start=${encodeURIComponent(startParam)}`;
}

/**
 * Verifies a SEP-53 Ed25519 signature over an AstroConnect Sign-In message.
 */
export async function verifyAstroConnectAuthProof(input: {
  address: ClassicAddress;
  challengeMessage: string;
  signatureBase64: string;
}): Promise<boolean> {
  return verifyConnectSignature({
    address: input.address,
    message: input.challengeMessage,
    signatureBase64: input.signatureBase64,
  });
}
