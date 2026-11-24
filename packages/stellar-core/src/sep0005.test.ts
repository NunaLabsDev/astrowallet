import { sha256 } from "@noble/hashes/sha2.js";
import { Address, Keypair, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  deriveMultipleAccounts,
  deriveStellarAccount,
  generateMnemonicPhrase,
  signChallengeMessage,
  signSorobanAuthEntry,
  validateMnemonicPhrase,
} from "./sep0005.js";

// Official SEP-0005 test vector from stellar/stellar-protocol/ecosystem/sep-0005.md
const SEP0005_MNEMONIC =
  "illness spike retreat truth genius clock brain pass fit cave bargain toe";

describe("SEP-0005 BIP-39 / SLIP-0010 Ed25519 derivation", () => {
  it("matches official SEP-0005 vectors for indices 0', 1', and 2'", () => {
    const a0 = deriveStellarAccount(SEP0005_MNEMONIC, 0);
    const a1 = deriveStellarAccount(SEP0005_MNEMONIC, 1);
    const a2 = deriveStellarAccount(SEP0005_MNEMONIC, 2);

    expect(a0.derivationPath).toBe("m/44'/148'/0'");
    expect(a0.publicKey).toBe("GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6");
    expect(a0.toKeypair().secret()).toBe(
      "SBGWSG6BTNCKCOB3DIFBGCVMUPQFYPA2G4O34RMTB343OYPXU5DJDVMN",
    );

    expect(a1.derivationPath).toBe("m/44'/148'/1'");
    expect(a1.publicKey).toBe("GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX");
    expect(a1.toKeypair().secret()).toBe(
      "SCEPFFWGAG5P2VX5DHIYK3XEMZYLTYWIPWYEKXFHSK25RVMIUNJ7CTIS",
    );

    expect(a2.derivationPath).toBe("m/44'/148'/2'");
    expect(a2.toKeypair().secret()).toBe(
      "SDAILLEZCSA67DUEP3XUPZJ7NYG7KGVRM46XA7K5QWWUIGADUZCZWTJP",
    );

    a0.zeroize();
    a1.zeroize();
    a2.zeroize();
    expect(a0.rawSecretBytes.every((b) => b === 0)).toBe(true);
  });

  it("derives multiple linked accounts deterministically", () => {
    const batch = deriveMultipleAccounts(SEP0005_MNEMONIC, 3);
    expect(batch).toHaveLength(3);
    expect(batch[0]?.publicKey).toBe(
      "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6",
    );
    expect(batch[1]?.publicKey).toBe(
      "GBAW5XGWORWVFE2XTJYDTLDHXTY2Q2MO73HYCGB3XMFMQ562Q2W2GJQX",
    );
  });

  it("generates and validates fresh 12-word and 24-word mnemonics", () => {
    const m12 = generateMnemonicPhrase(128);
    const m24 = generateMnemonicPhrase(256);
    expect(m12.split(" ")).toHaveLength(12);
    expect(m24.split(" ")).toHaveLength(24);
    expect(validateMnemonicPhrase(m12)).toBe(true);
    expect(validateMnemonicPhrase("not a valid mnemonic phrase")).toBe(false);
  });

  it("signs SEP-53 challenge messages verifiable against the public key", () => {
    const account = deriveStellarAccount(SEP0005_MNEMONIC, 0);
    const kp = account.toKeypair();
    const message = "astrowallet:connect:ch_123";
    const sigB64 = signChallengeMessage(kp, message);

    const sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
    const digest = sha256(new TextEncoder().encode(`Stellar Signed Message:\n${message}`));
    const verifier = Keypair.fromPublicKey(account.publicKey);
    expect(verifier.verify(digest, sigBytes)).toBe(true);
    account.zeroize();
  });

  it("signs Soroban HashIdPreimage auth entries for SEP-60", async () => {
    const account = deriveStellarAccount(SEP0005_MNEMONIC, 0);
    const kp = account.toKeypair();
    const contractId = "CA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJUWDA";
    const preimage = xdr.HashIdPreimage.envelopeTypeSorobanAuthorization(
      new xdr.HashIdPreimageSorobanAuthorization({
        networkId: Buffer.from(sha256(new TextEncoder().encode("Test SDF Network ; September 2015"))),
        nonce: xdr.Int64.fromString("42"),
        signatureExpirationLedger: 12345,
        invocation: new xdr.SorobanAuthorizedInvocation({
          function: xdr.SorobanAuthorizedFunction.sorobanAuthorizedFunctionTypeContractFn(
            new xdr.InvokeContractArgs({
              contractAddress: new Address(contractId).toScAddress(),
              functionName: "transfer",
              args: [],
            }),
          ),
          subInvocations: [],
        }),
      }),
    );
    const signed = await signSorobanAuthEntry(kp, preimage.toXDR("base64"));
    expect(signed.kind).toBe("hash_id_preimage");
    expect(signed.signerAddress).toBe(account.publicKey);
    const sigBytes = Uint8Array.from(atob(signed.signedAuthEntry), (c) => c.charCodeAt(0));
    expect(kp.verify(Buffer.from(sha256(preimage.toXDR())), Buffer.from(sigBytes))).toBe(true);
    account.zeroize();
  });
});
