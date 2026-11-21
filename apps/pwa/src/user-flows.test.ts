import { EncryptedVaultBackupEnvelopeSchema } from "@astrowallet/domain";
import {
  DEFAULT_ARGON2ID_PARAMS,
  decryptVaultPayload,
  deriveStellarAccount,
  encryptVaultPayload,
  evaluateCloudBackupSecretStrength,
  generateMnemonicPhrase,
  parseAgVaultBackup,
  serializeAgVaultBackup,
} from "@astrowallet/stellar-core";
import { deriveTonAccount } from "@astrowallet/ton-core";
import { describe, expect, it } from "vitest";
import {
  computeNextDerivationIndex,
  validateStellarMemoInput,
  validateTransferAmount,
} from "./components/flow-validators.js";

const FAST_TEST_KDF = {
  algorithm: "argon2id" as const,
  memoryKiB: 1024,
  iterations: 1,
  parallelism: 1,
  hashLength: 32,
};

describe("PWA Multi-User Client Flows & Form Validators", () => {
  it("runs 20 independent multichain user lifecycles (12/24 words, Stellar+TON, AGVAULT restore)", async () => {
    for (let i = 1; i <= 20; i += 1) {
      const strength: 128 | 256 = i % 2 === 0 ? 256 : 128;
      const mnemonic = generateMnemonicPhrase(strength);
      expect(mnemonic.split(" ")).toHaveLength(strength === 256 ? 24 : 12);

      // Reject 6-digit PINs for Telegram Encrypted Cloud Sync; accept >=10 char strong recovery pass
      expect(evaluateCloudBackupSecretStrength("839201").acceptable).toBe(false);
      const recoveryPass = `OrbitPilot#${i}_2026`;
      expect(evaluateCloudBackupSecretStrength(recoveryPass).acceptable).toBe(true);

      const s0 = deriveStellarAccount(mnemonic, 0);
      const s1 = deriveStellarAccount(mnemonic, 1);
      const ton0 = deriveTonAccount(mnemonic, 0, "testnet", "v4r2");

      try {
        expect(s0.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
        expect(s1.publicKey).toMatch(/^G[A-Z2-7]{55}$/);
        expect(s0.publicKey).not.toBe(s1.publicKey);
        expect(ton0.friendlyAddress).toMatch(/^[EUk0][A-Za-z0-9_-]{47}$/);

        const envelope = await encryptVaultPayload(
          {
            mnemonic,
            accounts: [
              { index: 0, label: `Primary ${i}`, address: s0.publicKey },
              { index: 1, label: `Vault ${i}`, address: s1.publicKey },
            ],
            createdAt: 1_760_000_000 + i,
          },
          recoveryPass,
          { kdfParams: FAST_TEST_KDF, preferWasm: false },
        );

        const serialized = serializeAgVaultBackup(envelope);
        const reparsed = parseAgVaultBackup(serialized);
        const restored = await decryptVaultPayload(reparsed, recoveryPass, { preferWasm: false });
        expect(restored.mnemonic).toBe(mnemonic);
        expect(restored.accounts).toHaveLength(2);
        expect(restored.accounts[1]?.label).toBe(`Vault ${i}`);

        await expect(
          decryptVaultPayload(reparsed, `WrongPass#${i}_2026`, { preferWasm: false }),
        ).rejects.toThrow(/Invalid PIN\/passphrase/i);
      } finally {
        s0.zeroize();
        s1.zeroize();
        ton0.zeroize();
      }
    }
  });

  it("produces production-default 64 MiB Argon2id envelopes passing EncryptedVaultBackupEnvelopeSchema", async () => {
    const mnemonic = generateMnemonicPhrase(128);
    const derived = deriveStellarAccount(mnemonic, 0);
    try {
      const envelope = await encryptVaultPayload(
        {
          mnemonic,
          accounts: [{ index: 0, label: "Production", address: derived.publicKey }],
          createdAt: 1_760_000_999,
        },
        "DeepSpacePass#2026",
        { kdfParams: DEFAULT_ARGON2ID_PARAMS, preferWasm: false },
      );
      expect(() => EncryptedVaultBackupEnvelopeSchema.parse(envelope)).not.toThrow();
    } finally {
      derived.zeroize();
    }
  });

  it("validates Stellar memos (UTF-8 28-byte cap, uint64 range, 64-hex digests) & amounts accurately", () => {
    // Text memo UTF-8 byte boundary
    expect(validateStellarMemoInput("text", "Invoice #42")).toBeNull();
    expect(validateStellarMemoInput("text", "a".repeat(28))).toBeNull();
    expect(validateStellarMemoInput("text", "🚀".repeat(8))).toMatch(/32 UTF-8 bytes/i);

    // ID memo uint64 bounds
    expect(validateStellarMemoInput("id", "18446744073709551615")).toBeNull();
    expect(validateStellarMemoInput("id", "18446744073709551616")).toMatch(/maximum/i);
    expect(validateStellarMemoInput("id", "12abc")).toMatch(/digits only/i);

    // Hash/return 64-hex
    expect(validateStellarMemoInput("hash", "a".repeat(64))).toBeNull();
    expect(validateStellarMemoInput("return", "xyz")).toMatch(/64-character hex/i);

    // Transfer amounts
    expect(validateTransferAmount("0", 100, { assetCode: "XLM", funded: true })).toMatch(/positive/i);
    expect(validateTransferAmount("1.12345678", 100, { assetCode: "XLM", funded: true })).toMatch(
      /7 decimals/i,
    );
    expect(validateTransferAmount("5", 100, { assetCode: "XLM", funded: false })).toMatch(
      /not activated/i,
    );
    expect(validateTransferAmount("10.5", 10, { assetCode: "XLM", funded: true })).toMatch(
      /Insufficient spendable XLM/i,
    );
    expect(validateTransferAmount("10", 10, { assetCode: "XLM", funded: true })).toBeNull();

    // Sparse derivation index computation
    expect(computeNextDerivationIndex([])).toBe(0);
    expect(computeNextDerivationIndex([{ derivationIndex: 0 }, { derivationIndex: 2 }])).toBe(3);
  });
});
