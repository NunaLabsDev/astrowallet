import { describe, expect, it } from "vitest";
import {
  buildMiniAppWebAppUrl,
  buildTelegramMiniAppLink,
  computeTelegramInitDataHash,
  encodeStartAppIntentParam,
  encodeStartAppTabParam,
  parseStartAppParam,
  signMiniAppSessionToken,
  verifyMiniAppSessionToken,
  verifyTelegramInitData,
} from "./mini-app.js";

const BOT_TOKEN = "123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi";
const HMAC_SECRET = "0123456789abcdef0123456789abcdef";

async function buildSignedInitData(
  fields: Record<string, string>,
  botToken = BOT_TOKEN,
): Promise<string> {
  const pairs = Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const checkString = pairs.map(([k, v]) => `${k}=${v}`).join("\n");
  const hash = await computeTelegramInitDataHash(checkString, botToken);
  const params = new URLSearchParams(fields);
  params.set("hash", hash);
  return params.toString();
}

describe("Telegram Mini App initData, sessions, and startapp routing", () => {
  it("verifies valid signed initData within TTL", async () => {
    const now = 1_900_000_100;
    const raw = await buildSignedInitData({
      auth_date: String(now - 20),
      query_id: "AAHdF6IQAAAAAN0XohDhrOrc",
      start_param: encodeStartAppTabParam("ton"),
      user: JSON.stringify({
        id: 424242,
        username: "AliceStellar",
        first_name: "Alice",
        language_code: "es",
      }),
    });

    const verified = await verifyTelegramInitData(raw, BOT_TOKEN, { nowUnixSeconds: now });
    expect(verified.valid).toBe(true);
    if (verified.valid) {
      expect(verified.data.user.id).toBe("424242");
      expect(verified.data.user.usernameLower).toBe("alicestellar");
      expect(verified.data.startParam).toBe("t-ton");
      expect(verified.data.authDate).toBe(now - 20);
    }
  });

  it("rejects tampered, expired, or userless initData fail-closed", async () => {
    const now = 1_900_000_500;
    const validRaw = await buildSignedInitData({
      auth_date: String(now - 10),
      user: JSON.stringify({ id: 424242, username: "alice" }),
    });
    const tampered = validRaw.replace("alice", "mallory");
    expect(await verifyTelegramInitData(tampered, BOT_TOKEN, { nowUnixSeconds: now })).toEqual({
      valid: false,
      reason: "invalid_signature",
    });

    const expiredRaw = await buildSignedInitData({
      auth_date: String(now - 400),
      user: JSON.stringify({ id: 424242 }),
    });
    expect(await verifyTelegramInitData(expiredRaw, BOT_TOKEN, { nowUnixSeconds: now })).toEqual({
      valid: false,
      reason: "expired",
    });

    const missingUserRaw = await buildSignedInitData({
      auth_date: String(now - 5),
      query_id: "q123",
    });
    expect(
      await verifyTelegramInitData(missingUserRaw, BOT_TOKEN, { nowUnixSeconds: now }),
    ).toEqual({
      valid: false,
      reason: "missing_user",
    });
  });

  it("signs and verifies Mini App session tokens with network isolation and TTL", async () => {
    const now = 1_900_000_000;
    const token = await signMiniAppSessionToken(
      {
        telegramUserId: "424242",
        usernameLower: "alice",
        network: "testnet",
        issuedAt: now,
        expiresAt: now + 900,
      },
      HMAC_SECRET,
    );

    const ok = await verifyMiniAppSessionToken(token, "testnet", HMAC_SECRET, now + 60);
    expect(ok.valid).toBe(true);
    if (ok.valid) {
      expect(ok.claims.telegramUserId).toBe("424242");
    }

    expect(
      await verifyMiniAppSessionToken(token, "mainnet", HMAC_SECRET, now + 60),
    ).toEqual({ valid: false, reason: "wrong_network" });

    expect(
      await verifyMiniAppSessionToken(token, "testnet", HMAC_SECRET, now + 900),
    ).toEqual({ valid: false, reason: "expired" });
  });

  it("encodes and parses startapp params and Telegram Mini App links", () => {
    const sig = "a".repeat(64);
    const param = encodeStartAppIntentParam("it_abc123", sig);
    expect(param).toBe(`i-it_abc123-${sig}`);
    expect(parseStartAppParam(param)).toEqual({
      kind: "intent",
      intentId: "it_abc123",
      sig,
    });
    expect(parseStartAppParam("t-ton")).toEqual({ kind: "tab", tab: "ton" });
    expect(parseStartAppParam("invalid-!@#")).toBeNull();

    expect(
      buildMiniAppWebAppUrl("https://app.example.org", { intentId: "it_1", sig }),
    ).toBe(`https://app.example.org/intent/it_1?sig=${sig}`);

    expect(
      buildTelegramMiniAppLink({
        botUsername: "@AstroWalletTestBot",
        shortName: "wallet",
        pwaOrigin: "https://app.example.org",
        intentId: "it_1",
        sig,
      }),
    ).toBe(`https://t.me/AstroWalletTestBot/wallet?startapp=i-it_1-${sig}`);
  });
});
