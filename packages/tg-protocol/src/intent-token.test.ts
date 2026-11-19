import { describe, expect, it } from "vitest";
import {
  buildIntentDeepLink,
  signIntentToken,
  verifyIntentToken,
  type IntentTokenClaims,
} from "./intent-token.js";

const SECRET = "0123456789abcdef0123456789abcdef";

const BASE_CLAIMS: IntentTokenClaims = {
  intentId: "it_99887766",
  network: "testnet",
  telegramUserId: "42424242",
  expiresAt: 1_900_000_300,
};

describe("Telegram Intent Token HMAC verification", () => {
  it("verifies a valid token within TTL", async () => {
    const sig = await signIntentToken(BASE_CLAIMS, SECRET);
    const res = await verifyIntentToken(BASE_CLAIMS, sig, SECRET, 1_900_000_000);
    expect(res).toEqual({ valid: true });
  });

  it("rejects expired tokens", async () => {
    const sig = await signIntentToken(BASE_CLAIMS, SECRET);
    const res = await verifyIntentToken(BASE_CLAIMS, sig, SECRET, 1_900_000_300);
    expect(res).toEqual({ valid: false, reason: "expired" });
  });

  it("rejects tampered signatures", async () => {
    const sig = await signIntentToken(BASE_CLAIMS, SECRET);
    const tampered = (sig.startsWith("a") ? "b" : "a") + sig.slice(1);
    const res = await verifyIntentToken(BASE_CLAIMS, tampered, SECRET, 1_900_000_000);
    expect(res).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("rejects cross-network token replay (testnet -> mainnet)", async () => {
    const sig = await signIntentToken(BASE_CLAIMS, SECRET);
    const res = await verifyIntentToken(
      { ...BASE_CLAIMS, network: "mainnet" },
      sig,
      SECRET,
      1_900_000_000,
    );
    expect(res).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("rejects telegramUserId mismatch", async () => {
    const sig = await signIntentToken(BASE_CLAIMS, SECRET);
    const res = await verifyIntentToken(
      { ...BASE_CLAIMS, telegramUserId: "999999" },
      sig,
      SECRET,
      1_900_000_000,
    );
    expect(res).toEqual({ valid: false, reason: "invalid_signature" });
  });

  it("builds valid intent deep links", () => {
    const url = buildIntentDeepLink(
      "https://testnet.astrowallet.example",
      "it_99887766",
      "deadbeef",
    );
    expect(url).toBe("https://testnet.astrowallet.example/intent/it_99887766?sig=deadbeef");
  });
});
