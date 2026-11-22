import type { ClassicAddress } from "@astrowallet/domain";
import { describe, expect, it } from "vitest";
import {
  buildSafeTelegramReturnUrl,
  formatAstroAuthMessage,
  signConnectRequestToken,
  verifyAstroConnectAuthProof,
  verifyConnectRequestToken,
} from "./astro-connect.js";
import {
  buildTelegramMiniAppConnectLink,
  encodeStartAppConnectParam,
  parseStartAppParam,
} from "./mini-app.js";

const SECRET = "0123456789abcdef0123456789abcdef";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeClassicStrKey(pubKey: Uint8Array): ClassicAddress {
  const payload = new Uint8Array(35);
  payload[0] = 6 << 3;
  payload.set(pubKey, 1);
  const crc = crc16Xmodem(payload.subarray(0, 33));
  payload[33] = crc & 0xff;
  payload[34] = (crc >> 8) & 0xff;
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of payload) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  return out as ClassicAddress;
}

describe("AstroConnect protocol primitives", () => {
  it("signs and verifies compact 32-hex connect tokens within Telegram 64-char startapp limits", async () => {
    const requestId = "ac_1234567890ab";
    const expiresAt = Math.floor(Date.now() / 1000) + 300;
    const sig = await signConnectRequestToken(
      { requestId, network: "testnet", expiresAt },
      SECRET,
    );
    expect(sig).toMatch(/^[a-f0-9]{32}$/);

    const startParam = encodeStartAppConnectParam(requestId, sig);
    expect(startParam.length).toBeLessThanOrEqual(64);
    expect(parseStartAppParam(startParam)).toEqual({
      kind: "connect",
      requestId,
      sig,
    });

    const ok = await verifyConnectRequestToken(
      { requestId, network: "testnet", expiresAt },
      sig,
      SECRET,
      expiresAt - 10,
    );
    expect(ok).toEqual({ valid: true });

    const expired = await verifyConnectRequestToken(
      { requestId, network: "testnet", expiresAt },
      sig,
      SECRET,
      expiresAt + 1,
    );
    expect(expired).toEqual({ valid: false, reason: "expired" });

    const wrongNet = await verifyConnectRequestToken(
      { requestId, network: "mainnet", expiresAt },
      sig,
      SECRET,
      expiresAt - 10,
    );
    expect(wrongNet).toEqual({ valid: false, reason: "invalid_signature" });

    const link = buildTelegramMiniAppConnectLink({
      botUsername: "AstroWalletAppBot",
      shortName: "wallet",
      pwaOrigin: "https://wallet.example",
      requestId,
      sig,
    });
    expect(link).toBe(
      `https://t.me/AstroWalletAppBot/wallet?startapp=${encodeURIComponent(startParam)}`,
    );
  });

  it("validates Telegram-exclusive Boomerang return URLs and rejects invalid params", () => {
    expect(
      buildSafeTelegramReturnUrl({
        botUsername: "@ExternalSorobanBot",
        miniAppShortName: "trade",
        returnStartAppParam: "session_done",
      }),
    ).toBe("https://t.me/ExternalSorobanBot/trade?startapp=session_done");

    expect(
      buildSafeTelegramReturnUrl(
        { botUsername: "BotWithoutShortName" },
        "connected",
      ),
    ).toBe("https://t.me/BotWithoutShortName?start=connected");

    expect(() =>
      buildSafeTelegramReturnUrl({
        botUsername: "evil.com/phish",
      }),
    ).toThrow();
  });

  it("formats canonical SEP-53 auth messages and verifies Ed25519 signatures", async () => {
    const kp = (await crypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as { publicKey: CryptoKey; privateKey: CryptoKey };
    const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
    const address = encodeClassicStrKey(pubRaw);

    const msg = formatAstroAuthMessage({
      appName: "Soroban Perps",
      botUsername: "@SorobanPerpsBot",
      network: "testnet",
      requestId: "ac_abcdef123456",
      nonce: "nonce_99887766",
      issuedAt: 1700000000,
      expiresAt: 1700000300,
      domain: "perps.example",
      statement: "Sign in to Soroban Perps",
    });

    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`Stellar Signed Message:\n${msg}`),
    );
    const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", kp.privateKey, digest));
    const signatureBase64 = btoa(String.fromCharCode(...sig));

    expect(
      await verifyAstroConnectAuthProof({
        address,
        challengeMessage: msg,
        signatureBase64,
      }),
    ).toBe(true);

    expect(
      await verifyAstroConnectAuthProof({
        address,
        challengeMessage: `${msg}\ntampered`,
        signatureBase64,
      }),
    ).toBe(false);
  });
});
