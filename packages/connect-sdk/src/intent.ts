import type {
  CrossAppIntentEnvelopeV1,
  IntentTokenClaims,
  VerifyIntentResult,
} from "./types.js";
import { sha256Hex } from "./verify.js";

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Bit-exact 4-field canonical HMAC message for AstroWallet IntentTokens:
 * `${network}:${intentId}:${telegramUserId}:${expiresAt}`
 */
export function buildCanonicalIntentMessage(claims: IntentTokenClaims): string {
  return `${claims.network}:${claims.intentId}:${claims.telegramUserId}:${claims.expiresAt}`;
}

/**
 * Signs an AstroWallet IntentToken using HMAC-SHA256.
 */
export async function signIntentToken(
  claims: IntentTokenClaims,
  hmacSecret: string,
): Promise<string> {
  if (!hmacSecret || hmacSecret.length < 32) {
    throw new Error("INTENT_HMAC_SECRET must be at least 32 characters");
  }
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(hmacSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(buildCanonicalIntentMessage(claims)),
  );
  return toHex(sig);
}

/**
 * Verifies a 4-field IntentToken fail-closed against TTL expiry and HMAC signature.
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

/**
 * Builds a protocol-agnostic CrossAppIntentEnvelope v1 with SHA-256 XDR binding.
 */
export async function buildCrossAppIntentEnvelope(input: {
  originApp: string;
  subAction: string;
  humanSummary: string;
  unsignedXdr: string;
  returnStartAppParam?: string | undefined;
  fromAsset?: string | undefined;
  toAsset?: string | undefined;
  amount?: string | undefined;
  expectedOutputAmount?: string | undefined;
  provider?: string | undefined;
  priceImpactPct?: string | undefined;
}): Promise<CrossAppIntentEnvelopeV1> {
  const xdrSha256 = await sha256Hex(input.unsignedXdr);
  return {
    originApp: input.originApp,
    subAction: input.subAction,
    humanSummary: input.humanSummary,
    unsignedXdr: input.unsignedXdr,
    xdrSha256,
    ...(input.returnStartAppParam ? { returnStartAppParam: input.returnStartAppParam } : {}),
    ...(input.fromAsset ? { fromAsset: input.fromAsset } : {}),
    ...(input.toAsset ? { toAsset: input.toAsset } : {}),
    ...(input.amount ? { amount: input.amount } : {}),
    ...(input.expectedOutputAmount
      ? { expectedOutputAmount: input.expectedOutputAmount }
      : {}),
    ...(input.provider ? { provider: input.provider } : {}),
    ...(input.priceImpactPct ? { priceImpactPct: input.priceImpactPct } : {}),
  };
}

/**
 * Builds a Telegram Mini App deep link (`https://t.me/<bot>/<shortName>?startapp=...`).
 */
export function buildTelegramMiniAppLink(opts: {
  botUsername: string;
  miniAppShortName?: string | undefined;
  startParam?: string | undefined;
  useStartApp?: boolean | undefined;
}): string {
  const cleanBot = opts.botUsername.trim().replace(/^@/, "");
  const cleanShort = opts.miniAppShortName?.trim();
  const base = cleanShort
    ? `https://t.me/${cleanBot}/${cleanShort}`
    : `https://t.me/${cleanBot}`;
  const url = new URL(base);
  if (opts.startParam) {
    url.searchParams.set(opts.useStartApp === false ? "start" : "startapp", opts.startParam);
  }
  return url.toString();
}

export function buildAstroWalletIntentDeepLink(opts: {
  astroWalletBotUsername: string;
  astroWalletMiniAppShortName?: string | undefined;
  intentId: string;
  sig: string;
}): string {
  return buildTelegramMiniAppLink({
    botUsername: opts.astroWalletBotUsername,
    miniAppShortName: opts.astroWalletMiniAppShortName,
    startParam: `i-${opts.intentId}-${opts.sig.toLowerCase()}`,
    useStartApp: true,
  });
}

export function buildAstroWalletOnboardingDeepLink(opts: {
  astroWalletBotUsername: string;
  astroWalletMiniAppShortName?: string | undefined;
}): string {
  return buildTelegramMiniAppLink({
    botUsername: opts.astroWalletBotUsername,
    miniAppShortName: opts.astroWalletMiniAppShortName,
    startParam: "t-vault",
    useStartApp: true,
  });
}
