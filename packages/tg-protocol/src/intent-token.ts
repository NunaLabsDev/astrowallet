import type { StellarNetwork } from "@astrowallet/domain";

export interface IntentTokenClaims {
  intentId: string;
  network: StellarNetwork;
  telegramUserId: string;
  expiresAt: number;
}

export type VerifyIntentResult =
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

function buildCanonicalMessage(claims: IntentTokenClaims): string {
  return `${claims.network}:${claims.intentId}:${claims.telegramUserId}:${claims.expiresAt}`;
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

/**
 * Computes an HMAC-SHA256 hex signature binding intent ID, network, Telegram user ID, and expiry.
 */
export async function signIntentToken(
  claims: IntentTokenClaims,
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
  const sig = await subtle.sign("HMAC", key, encoder.encode(buildCanonicalMessage(claims)));
  return toHex(sig);
}

/**
 * Verifies an intent token fail-closed against TTL expiry, network binding, and HMAC signature.
 */
export async function verifyIntentToken(
  claims: IntentTokenClaims,
  signatureHex: string,
  hmacSecret: string,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifyIntentResult> {
  if (
    !claims.intentId ||
    !/^\d{1,20}$/.test(claims.telegramUserId) ||
    !/^[a-f0-9]{64}$/i.test(signatureHex)
  ) {
    return { valid: false, reason: "malformed" };
  }

  if (claims.expiresAt <= nowUnixSeconds) {
    return { valid: false, reason: "expired" };
  }

  const expectedHex = await signIntentToken(claims, hmacSecret);
  if (!constantTimeEqualHex(expectedHex, signatureHex.toLowerCase())) {
    return { valid: false, reason: "invalid_signature" };
  }

  return { valid: true };
}

interface MinimalUrlInstance {
  pathname: string;
  searchParams: { set(name: string, value: string): void };
  toString(): string;
}

/**
 * Builds the HTTPS Intent URL opened from Telegram inline keyboard buttons.
 */
export function buildIntentDeepLink(
  pwaOrigin: string,
  intentId: string,
  signatureHex: string,
): string {
  const UrlCtor = (globalThis as unknown as { URL?: new (input: string) => MinimalUrlInstance }).URL;
  if (!UrlCtor) {
    throw new Error("Global WHATWG URL constructor is required");
  }
  const base = new UrlCtor(pwaOrigin);
  base.pathname = `/intent/${encodeURIComponent(intentId)}`;
  base.searchParams.set("sig", signatureHex);
  return base.toString();
}
