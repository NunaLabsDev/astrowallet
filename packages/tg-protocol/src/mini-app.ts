import type { StellarNetwork } from "@astrowallet/domain";

export interface VerifiedTelegramUser {
  id: string;
  username?: string | undefined;
  usernameLower?: string | undefined;
  firstName?: string | undefined;
  lastName?: string | undefined;
  languageCode?: string | undefined;
}

export interface VerifiedTelegramInitData {
  user: VerifiedTelegramUser;
  authDate: number;
  queryId?: string | undefined;
  startParam?: string | undefined;
  chatType?: string | undefined;
  chatInstance?: string | undefined;
}

export type VerifyInitDataResult =
  | { valid: true; data: VerifiedTelegramInitData }
  | {
      valid: false;
      reason: "malformed" | "expired" | "invalid_signature" | "missing_user";
    };

export interface MiniAppSessionClaims {
  telegramUserId: string;
  usernameLower?: string | undefined;
  network: StellarNetwork;
  issuedAt: number;
  expiresAt: number;
}

export type VerifySessionResult =
  | { valid: true; claims: MiniAppSessionClaims }
  | {
      valid: false;
      reason: "malformed" | "expired" | "wrong_network" | "invalid_signature";
    };

export type ParsedStartAppParam =
  | { kind: "intent"; intentId: string; sig: string }
  | { kind: "tab"; tab: string };

interface MinimalTextEncoder {
  encode(input: string): Uint8Array;
}

interface MinimalTextDecoder {
  decode(input: Uint8Array): string;
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

interface MinimalSearchParams {
  entries(): IterableIterator<[string, string]>;
  get(name: string): string | null;
}

interface MinimalUrl {
  pathname: string;
  searchParams: { set(name: string, value: string): void };
  toString(): string;
}

function getCryptoGlobals() {
  const g = globalThis as unknown as {
    crypto?: { subtle?: MinimalSubtleCrypto };
    TextEncoder?: new () => MinimalTextEncoder;
    TextDecoder?: new () => MinimalTextDecoder;
    URLSearchParams?: new (init?: string) => MinimalSearchParams;
    URL?: new (input: string) => MinimalUrl;
    btoa?: (data: string) => string;
    atob?: (data: string) => string;
  };
  if (!g.crypto?.subtle || !g.TextEncoder || !g.TextDecoder || !g.URLSearchParams || !g.URL || !g.btoa || !g.atob) {
    throw new Error("Web Crypto, TextEncoder/Decoder, URL/URLSearchParams, and base64 helpers are required");
  }
  return {
    subtle: g.crypto.subtle,
    encoder: new g.TextEncoder(),
    decoder: new g.TextDecoder(),
    URLSearchParamsCtor: g.URLSearchParams,
    URLCtor: g.URL,
    encodeB64: g.btoa,
    decodeB64: g.atob,
  };
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

function toBase64Url(bytes: Uint8Array): string {
  const { encodeB64 } = getCryptoGlobals();
  let binary = "";
  for (const b of bytes) {
    binary += String.fromCharCode(b);
  }
  return encodeB64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(b64Url: string): Uint8Array {
  const { decodeB64 } = getCryptoGlobals();
  const normalized = b64Url.replace(/-/g, "+").replace(/_/g, "/");
  const pad = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const binary = decodeB64(normalized + pad);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

async function hmacSha256Raw(keyBytes: Uint8Array, messageBytes: Uint8Array): Promise<ArrayBuffer> {
  const { subtle } = getCryptoGlobals();
  const key = await subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return subtle.sign("HMAC", key, messageBytes);
}

/**
 * Computes the official Telegram WebApp initData HMAC-SHA256 hex digest:
 * secret_key = HMAC-SHA256("WebAppData", botToken)
 * hash = HMAC-SHA256(secret_key, dataCheckString)
 */
export async function computeTelegramInitDataHash(
  dataCheckString: string,
  botToken: string,
): Promise<string> {
  if (!botToken) {
    throw new Error("TG_BOT_TOKEN is required to verify Telegram initData");
  }
  const { encoder } = getCryptoGlobals();
  const secretKeyBuf = await hmacSha256Raw(
    encoder.encode("WebAppData"),
    encoder.encode(botToken),
  );
  const sigBuf = await hmacSha256Raw(
    new Uint8Array(secretKeyBuf),
    encoder.encode(dataCheckString),
  );
  return toHex(sigBuf);
}

/**
 * Verifies raw Telegram.WebApp.initData fail-closed (HMAC-SHA256 + auth_date TTL + parsed user).
 */
export async function verifyTelegramInitData(
  rawInitData: string,
  botToken: string,
  opts?: {
    nowUnixSeconds?: number | undefined;
    maxAgeSeconds?: number | undefined;
  },
): Promise<VerifyInitDataResult> {
  const trimmed = rawInitData.trim();
  if (!trimmed) {
    return { valid: false, reason: "malformed" };
  }

  const { URLSearchParamsCtor } = getCryptoGlobals();
  const params = new URLSearchParamsCtor(trimmed);
  const hash = params.get("hash") ?? "";
  const authDateRaw = params.get("auth_date") ?? "";
  if (!/^[a-f0-9]{64}$/i.test(hash) || !/^\d{1,15}$/.test(authDateRaw)) {
    return { valid: false, reason: "malformed" };
  }

  const pairs: Array<[string, string]> = [];
  for (const [k, v] of params.entries()) {
    if (k === "hash") continue;
    pairs.push([k, v]);
  }
  pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const dataCheckString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");

  const expectedHash = await computeTelegramInitDataHash(dataCheckString, botToken);
  if (!constantTimeEqualHex(expectedHash, hash.toLowerCase())) {
    return { valid: false, reason: "invalid_signature" };
  }

  const userJson = params.get("user");
  if (!userJson) {
    return { valid: false, reason: "missing_user" };
  }

  let parsedUser: {
    id?: unknown;
    username?: unknown;
    first_name?: unknown;
    last_name?: unknown;
    language_code?: unknown;
  };
  try {
    parsedUser = JSON.parse(userJson) as typeof parsedUser;
  } catch {
    return { valid: false, reason: "missing_user" };
  }

  const rawId =
    typeof parsedUser?.id === "number" && Number.isInteger(parsedUser.id)
      ? String(parsedUser.id)
      : typeof parsedUser?.id === "string"
        ? parsedUser.id.trim()
        : "";
  if (!/^\d{1,20}$/.test(rawId)) {
    return { valid: false, reason: "missing_user" };
  }

  const authDate = Number(authDateRaw);
  const nowUnixSeconds = opts?.nowUnixSeconds ?? Math.floor(Date.now() / 1000);
  const maxAgeSeconds = opts?.maxAgeSeconds ?? 300;
  if (
    !Number.isFinite(authDate) ||
    authDate <= 0 ||
    authDate > nowUnixSeconds + 60 ||
    nowUnixSeconds - authDate > maxAgeSeconds
  ) {
    return { valid: false, reason: "expired" };
  }

  const username =
    typeof parsedUser.username === "string" && parsedUser.username.trim()
      ? parsedUser.username.trim()
      : undefined;

  return {
    valid: true,
    data: {
      user: {
        id: rawId,
        username,
        usernameLower: username?.toLowerCase(),
        firstName: typeof parsedUser.first_name === "string" ? parsedUser.first_name : undefined,
        lastName: typeof parsedUser.last_name === "string" ? parsedUser.last_name : undefined,
        languageCode:
          typeof parsedUser.language_code === "string" ? parsedUser.language_code : undefined,
      },
      authDate,
      queryId: params.get("query_id") ?? undefined,
      startParam: params.get("start_param") ?? undefined,
      chatType: params.get("chat_type") ?? undefined,
      chatInstance: params.get("chat_instance") ?? undefined,
    },
  };
}

/**
 * Mints a short-lived HMAC-signed Mini App session token after initData validation.
 */
export async function signMiniAppSessionToken(
  claims: MiniAppSessionClaims,
  hmacSecret: string,
): Promise<string> {
  if (!hmacSecret || hmacSecret.length < 32) {
    throw new Error("INTENT_HMAC_SECRET must be at least 32 characters");
  }
  const { encoder } = getCryptoGlobals();
  const payloadB64 = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const sigBuf = await hmacSha256Raw(
    encoder.encode(hmacSecret),
    encoder.encode(`tg-session:v1:${payloadB64}`),
  );
  return `${payloadB64}.${toHex(sigBuf)}`;
}

/**
 * Verifies a Mini App session bearer token fail-closed (signature, network binding, expiry).
 */
export async function verifyMiniAppSessionToken(
  token: string,
  expectedNetwork: StellarNetwork,
  hmacSecret: string,
  nowUnixSeconds: number = Math.floor(Date.now() / 1000),
): Promise<VerifySessionResult> {
  if (!hmacSecret || hmacSecret.length < 32) {
    throw new Error("INTENT_HMAC_SECRET must be at least 32 characters");
  }
  const parts = token.trim().split(".");
  if (parts.length !== 2) {
    return { valid: false, reason: "malformed" };
  }
  const [payloadB64 = "", sigHex = ""] = parts;
  if (!payloadB64 || !/^[a-f0-9]{64}$/i.test(sigHex)) {
    return { valid: false, reason: "malformed" };
  }

  const { encoder, decoder } = getCryptoGlobals();
  const expectedSigBuf = await hmacSha256Raw(
    encoder.encode(hmacSecret),
    encoder.encode(`tg-session:v1:${payloadB64}`),
  );
  if (!constantTimeEqualHex(toHex(expectedSigBuf), sigHex.toLowerCase())) {
    return { valid: false, reason: "invalid_signature" };
  }

  let claims: MiniAppSessionClaims;
  try {
    const json = decoder.decode(fromBase64Url(payloadB64));
    claims = JSON.parse(json) as MiniAppSessionClaims;
  } catch {
    return { valid: false, reason: "malformed" };
  }

  if (
    !claims ||
    typeof claims.telegramUserId !== "string" ||
    !/^\d{1,20}$/.test(claims.telegramUserId) ||
    typeof claims.expiresAt !== "number"
  ) {
    return { valid: false, reason: "malformed" };
  }

  if (claims.network !== expectedNetwork) {
    return { valid: false, reason: "wrong_network" };
  }

  if (claims.expiresAt <= nowUnixSeconds) {
    return { valid: false, reason: "expired" };
  }

  return { valid: true, claims };
}

export function encodeStartAppIntentParam(intentId: string, sig: string): string {
  return `i-${intentId}-${sig.toLowerCase()}`;
}

export function encodeStartAppTabParam(tab: string): string {
  return `t-${tab.toLowerCase()}`;
}

export function parseStartAppParam(raw: string): ParsedStartAppParam | null {
  const trimmed = raw.trim();
  const intentMatch = trimmed.match(/^i-([A-Za-z0-9_-]+)-([a-f0-9]{64})$/i);
  if (intentMatch?.[1] && intentMatch[2]) {
    return {
      kind: "intent",
      intentId: intentMatch[1],
      sig: intentMatch[2].toLowerCase(),
    };
  }
  const tabMatch = trimmed.match(/^t-([a-z0-9_-]{1,32})$/i);
  if (tabMatch?.[1]) {
    return {
      kind: "tab",
      tab: tabMatch[1].toLowerCase(),
    };
  }
  return null;
}

export function buildMiniAppWebAppUrl(
  pwaOrigin: string,
  opts?: { intentId?: string | undefined; sig?: string | undefined; tab?: string | undefined },
): string {
  const { URLCtor } = getCryptoGlobals();
  const base = new URLCtor(pwaOrigin);
  if (opts?.intentId && opts?.sig) {
    base.pathname = `/intent/${encodeURIComponent(opts.intentId)}`;
    base.searchParams.set("sig", opts.sig);
    return base.toString();
  }
  base.pathname = "/app";
  if (opts?.tab) {
    base.searchParams.set("tab", opts.tab);
  }
  return base.toString();
}

export function buildTelegramMiniAppLink(opts: {
  botUsername?: string | undefined;
  shortName?: string | undefined;
  pwaOrigin: string;
  intentId?: string | undefined;
  sig?: string | undefined;
  tab?: string | undefined;
}): string {
  const bot = opts.botUsername?.trim().replace(/^@/, "");
  if (!bot) {
    return buildMiniAppWebAppUrl(opts.pwaOrigin, {
      intentId: opts.intentId,
      sig: opts.sig,
      tab: opts.tab,
    });
  }
  const short = opts.shortName?.trim();
  const { URLCtor } = getCryptoGlobals();
  const url = new URLCtor(short ? `https://t.me/${bot}/${short}` : `https://t.me/${bot}`);
  if (opts.intentId && opts.sig) {
    url.searchParams.set("startapp", encodeStartAppIntentParam(opts.intentId, opts.sig));
  } else if (opts.tab) {
    url.searchParams.set("startapp", encodeStartAppTabParam(opts.tab));
  }
  return url.toString();
}
