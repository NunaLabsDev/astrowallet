import { evaluateSecretStrength } from "@astrowallet/stellar-core";
import { parseStartAppParam } from "@astrowallet/tg-protocol";
import { describe, expect, it } from "vitest";
import {
  SessionMnemonicVault,
  inspectDappAuthEntrySecurity,
  mapSep7MemoKind,
} from "./state/session-vault.js";
import { shouldAllowMiniAppAccess } from "./telegram/webapp.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015";

const TESTNET_SWAP_AUTH_XDR =
  "AAAACc7gMC1ZhE0yvcqRXIID3USzP7t+3BkFHqN6vt8o7NRyAAAAAAAAAAEAB6EgAAAAAAAAAAEDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwAAAARzd2FwAAAAAAAAAAA=";
const TESTNET_UPGRADE_AUTH_XDR =
  "AAAACc7gMC1ZhE0yvcqRXIID3USzP7t+3BkFHqN6vt8o7NRyAAAAAAAAAAEAB6EgAAAAAAAAAAEDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwAAAAd1cGdyYWRlAAAAAAAAAAAA";

describe("PWA Client Security Hardening", () => {
  it("stores unlocked mnemonic in zeroizable Uint8Array SessionMnemonicVault", () => {
    const vault = new SessionMnemonicVault();
    expect(vault.has()).toBe(false);
    expect(() => vault.withMnemonic((m) => m)).toThrow(/Vault is locked/i);

    vault.set("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
    expect(vault.has()).toBe(true);
    expect(vault.withMnemonic((m) => m.split(" ").length)).toBe(12);

    vault.clear();
    expect(vault.has()).toBe(false);
    expect(() => vault.withMnemonic((m) => m)).toThrow(/Vault is locked/i);
  });

  it("inspects Soroban auth entries, rejects cross-network networkId, and blocks malicious invocations", async () => {
    const safe = await inspectDappAuthEntrySecurity(TESTNET_SWAP_AUTH_XDR, TESTNET_PASSPHRASE);
    expect(safe.summary.invocation.functionName).toBe("swap");
    expect(safe.blockedReason).toBeUndefined();

    await expect(
      inspectDappAuthEntrySecurity(TESTNET_SWAP_AUTH_XDR, MAINNET_PASSPHRASE),
    ).rejects.toThrow(/networkId mismatch/i);

    const malicious = await inspectDappAuthEntrySecurity(
      TESTNET_UPGRADE_AUTH_XDR,
      TESTNET_PASSPHRASE,
    );
    expect(malicious.blockedReason).toMatch(/Dangerous Soroban Function/i);
  });

  it("maps all SEP-0007 memo types accurately", () => {
    expect(mapSep7MemoKind("MEMO_TEXT")).toBe("text");
    expect(mapSep7MemoKind("MEMO_ID")).toBe("id");
    expect(mapSep7MemoKind("MEMO_HASH")).toBe("hash");
    expect(mapSep7MemoKind("MEMO_RETURN")).toBe("return");
    expect(mapSep7MemoKind("MEMO_NONE")).toBe("none");
  });

  it("enforces secret strength thresholds for wallet onboarding", () => {
    expect(evaluateSecretStrength("123456").acceptable).toBe(false);
    expect(evaluateSecretStrength("000000").acceptable).toBe(false);
    expect(evaluateSecretStrength("839201").acceptable).toBe(true);
    expect(evaluateSecretStrength("DeepOrbital#2026").level).toBe("strong");
  });

  it("enforces 100% Telegram-only Mini App access gate", () => {
    expect(
      shouldAllowMiniAppAccess({
        inTelegram: false,
        allowDevOutsideTelegram: false,
        authStatus: "outside",
      }),
    ).toBe(false);

    expect(
      shouldAllowMiniAppAccess({
        inTelegram: false,
        allowDevOutsideTelegram: true,
        authStatus: "outside",
      }),
    ).toBe(true);

    expect(
      shouldAllowMiniAppAccess({
        inTelegram: true,
        allowDevOutsideTelegram: true,
        authStatus: "checking",
      }),
    ).toBe(false);

    expect(
      shouldAllowMiniAppAccess({
        inTelegram: true,
        allowDevOutsideTelegram: false,
        authStatus: "error",
      }),
    ).toBe(false);

    expect(
      shouldAllowMiniAppAccess({
        inTelegram: true,
        allowDevOutsideTelegram: false,
        authStatus: "verified",
      }),
    ).toBe(true);
  });

  it("parses Telegram startapp intent and tab routing parameters cleanly", () => {
    const sig = "A".repeat(64);
    expect(parseStartAppParam(`i-it_abc123-${sig}`)).toEqual({
      kind: "intent",
      intentId: "it_abc123",
      sig: "a".repeat(64),
    });

    expect(parseStartAppParam("t-ton")).toEqual({ kind: "tab", tab: "ton" });
    expect(parseStartAppParam("t-accounts")).toEqual({ kind: "tab", tab: "accounts" });

    expect(parseStartAppParam("")).toBeNull();
    expect(parseStartAppParam("i-it_abc123-short")).toBeNull();
    expect(parseStartAppParam("unknown-param")).toBeNull();
  });
});
