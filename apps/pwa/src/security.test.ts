import {
  evaluateCloudBackupSecretStrength,
  evaluateSecretStrength,
} from "@astrowallet/stellar-core";
import { parseStartAppParam } from "@astrowallet/tg-protocol";
import { describe, expect, it } from "vitest";
import {
  buildWordQuizChallenges,
  formatSeedBackupFilename,
  parseSeedWordCount,
  pickVerificationIndices,
} from "./components/onboarding-helpers.js";
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

    expect(evaluateCloudBackupSecretStrength("839201").acceptable).toBe(false);
    expect(evaluateCloudBackupSecretStrength("1234567890").acceptable).toBe(false);
    expect(evaluateCloudBackupSecretStrength("OrbitSky#2026").acceptable).toBe(true);
    expect(evaluateCloudBackupSecretStrength("stellar-ton-vault-2026").acceptable).toBe(true);
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

  it("builds unique sorted onboarding verification indices and 4-choice blind quiz challenges", () => {
    const indices12 = pickVerificationIndices(12, 3);
    expect(indices12).toHaveLength(3);
    expect(new Set(indices12).size).toBe(3);
    expect(indices12).toEqual([...indices12].sort((a, b) => a - b));
    for (const idx of indices12) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(12);
    }

    const indices24 = pickVerificationIndices(24, 3);
    expect(indices24).toHaveLength(3);
    for (const idx of indices24) {
      expect(idx).toBeLessThan(24);
    }

    const sample12 = [
      "abandon",
      "ability",
      "able",
      "about",
      "above",
      "absent",
      "absorb",
      "abstract",
      "absurd",
      "abuse",
      "access",
      "accident",
    ];
    const challenges = buildWordQuizChallenges(sample12);
    expect(challenges).toHaveLength(3);
    for (const c of challenges) {
      expect(c.expectedWord).toBe(sample12[c.wordIndex]);
      expect(c.choices).toHaveLength(4);
      expect(new Set(c.choices).size).toBe(4);
      expect(c.choices).toContain(c.expectedWord);
    }

    // Even a phrase with repeated words yields 4 distinct choices via fallback decoys.
    const repeated = Array.from({ length: 12 }, () => "abandon");
    repeated[11] = "about";
    const repeatedChallenges = buildWordQuizChallenges(repeated, [0, 5, 11]);
    for (const c of repeatedChallenges) {
      expect(c.choices).toHaveLength(4);
      expect(new Set(c.choices).size).toBe(4);
      expect(c.choices).toContain(c.expectedWord);
    }
  });

  it("counts seed words and formats deterministic .agvault.json backup filenames", () => {
    expect(parseSeedWordCount("")).toBe(0);
    expect(parseSeedWordCount("   \n  ")).toBe(0);
    expect(parseSeedWordCount("word1   word2\nword3")).toBe(3);

    const ts = new Date("2026-11-21T09:00:00Z");
    expect(formatSeedBackupFilename("testnet", ts)).toBe(
      "astrowallet-testnet-vault-2026-11-21.agvault.json",
    );
  });
});
