import { describe, expect, it } from "vitest";
import {
  DEFAULT_ARGON2ID_PARAMS,
  decryptVaultPayload,
  encryptVaultPayload,
  evaluateSecretStrength,
  parseAgVaultBackup,
  serializeAgVaultBackup,
  type Argon2idParams,
  type VaultPayload,
} from "./crypto.js";

const SAMPLE_PAYLOAD: VaultPayload = {
  mnemonic:
    "illness spike retreat truth genius clock brain pass fit cave bargain toe",
  accounts: [
    {
      index: 0,
      label: "Primary",
      address: "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
    },
    {
      index: 1,
      label: "Savings",
      address: "GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX",
    },
  ],
  createdAt: 1_800_000_000,
};

const FAST_TEST_PARAMS: Argon2idParams = {
  algorithm: "argon2id",
  memoryKiB: 1024,
  iterations: 1,
  parallelism: 1,
  hashLength: 32,
};

describe("Argon2id + AES-GCM-256 non-custodial vault", () => {
  it("encrypts and decrypts round-trip with WASM primary engine", async () => {
    const envelope = await encryptVaultPayload(SAMPLE_PAYLOAD, "482910", {
      preferWasm: true,
      kdfParams: FAST_TEST_PARAMS,
    });
    expect(envelope.format).toBe("AGVAULT");
    expect(envelope.ciphertextB64).not.toContain("illness");

    const decrypted = await decryptVaultPayload(envelope, "482910", {
      preferWasm: true,
    });
    expect(decrypted).toEqual(SAMPLE_PAYLOAD);
  });

  it("encrypts and decrypts round-trip with pure-JS @noble/hashes fallback", async () => {
    const envelope = await encryptVaultPayload(SAMPLE_PAYLOAD, "pin-pass-99", {
      preferWasm: false,
      kdfParams: FAST_TEST_PARAMS,
    });
    const decrypted = await decryptVaultPayload(envelope, "pin-pass-99", {
      preferWasm: false,
    });
    expect(decrypted.mnemonic).toBe(SAMPLE_PAYLOAD.mnemonic);
    expect(decrypted.accounts).toHaveLength(2);
  });

  it("supports default OWASP 64 MiB Argon2id parameters", async () => {
    expect(DEFAULT_ARGON2ID_PARAMS.memoryKiB).toBe(65_536);
    expect(DEFAULT_ARGON2ID_PARAMS.iterations).toBe(3);

    const envelope = await encryptVaultPayload(SAMPLE_PAYLOAD, "918273", {
      preferWasm: true,
      kdfParams: DEFAULT_ARGON2ID_PARAMS,
    });
    const decrypted = await decryptVaultPayload(envelope, "918273");
    expect(decrypted.accounts[0]?.address).toBe(SAMPLE_PAYLOAD.accounts[0]?.address);
  });

  it("evaluates PIN/passphrase strength and rejects trivial secrets", () => {
    expect(evaluateSecretStrength("12345").acceptable).toBe(false);
    expect(evaluateSecretStrength("000000").acceptable).toBe(false);
    expect(evaluateSecretStrength("123456").acceptable).toBe(false);
    expect(evaluateSecretStrength("654321").acceptable).toBe(false);
    expect(evaluateSecretStrength("112211").acceptable).toBe(false);

    const fairPin = evaluateSecretStrength("482910");
    expect(fairPin.acceptable).toBe(true);
    expect(fairPin.level).toBe("fair");

    const strongPass = evaluateSecretStrength("Solar!Orbital99");
    expect(strongPass.acceptable).toBe(true);
    expect(strongPass.level).toBe("strong");
    expect(strongPass.score).toBe(4);
  });

  it("rejects wrong PIN and tampered ciphertext", async () => {
    const envelope = await encryptVaultPayload(SAMPLE_PAYLOAD, "123456", {
      kdfParams: FAST_TEST_PARAMS,
    });

    await expect(decryptVaultPayload(envelope, "654321")).rejects.toThrow(
      /Invalid PIN/,
    );

    const tampered = {
      ...envelope,
      ciphertextB64:
        (envelope.ciphertextB64.startsWith("A") ? "B" : "A") +
        envelope.ciphertextB64.slice(1),
    };
    await expect(decryptVaultPayload(tampered, "123456")).rejects.toThrow(
      /Invalid PIN/,
    );

    await expect(
      encryptVaultPayload(SAMPLE_PAYLOAD, "1234", { kdfParams: FAST_TEST_PARAMS }),
    ).rejects.toThrow(/at least 6 characters/);
  });

  it("serializes and parses AGVAULT backup bundles", async () => {
    const envelope = await encryptVaultPayload(SAMPLE_PAYLOAD, "backup-pin", {
      kdfParams: FAST_TEST_PARAMS,
    });
    const json = serializeAgVaultBackup(envelope);
    const restored = parseAgVaultBackup(json);
    expect(restored).toEqual(envelope);
  });
});
