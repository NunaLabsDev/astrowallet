import type { ClassicAddress } from "@astrowallet/domain";
import { Keypair, scValToNative } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  deriveStellarAccount,
  generateMnemonicPhrase,
  publicKeyToRawHex,
  signChallengeMessage,
  verifyChallengeMessage,
} from "../sep0005.js";
import { buildSep7PayUri, parseDevScValArgs, parseSep7Uri } from "./index.js";

describe("Developer Lab primitives & SEP utilities", () => {
  it("builds and parses SEP-0007 pay URIs accurately", () => {
    const dest = Keypair.random().publicKey() as ClassicAddress;
    const issuer = Keypair.random().publicKey() as ClassicAddress;
    const uri = buildSep7PayUri({
      destination: dest,
      amount: "42.5",
      assetCode: "USDC",
      assetIssuer: issuer,
      memo: "invoice-99",
      memoType: "MEMO_TEXT",
      msg: "AstroWallet Demo",
    });

    expect(uri.startsWith("web+stellar:pay?")).toBe(true);

    const parsed = parseSep7Uri(uri);
    expect(parsed.operation).toBe("pay");
    expect(parsed.destination).toBe(dest);
    expect(parsed.amount).toBe("42.5");
    expect(parsed.assetCode).toBe("USDC");
    expect(parsed.assetIssuer).toBe(issuer);
    expect(parsed.memo).toBe("invoice-99");
    expect(parsed.memoType).toBe("MEMO_TEXT");
    expect(parsed.msg).toBe("AstroWallet Demo");
  });

  it("verifies SEP-53 challenge signatures and extracts 32-byte raw public hex", () => {
    const mnemonic = generateMnemonicPhrase(128);
    const derived = deriveStellarAccount(mnemonic, 0);
    const kp = derived.toKeypair();
    const message = "astrowallet-sep53-proof-check";

    const sig = signChallengeMessage(kp, message);
    expect(verifyChallengeMessage(derived.publicKey, message, sig)).toBe(true);
    expect(verifyChallengeMessage(derived.publicKey, `${message}-tampered`, sig)).toBe(false);

    const rawHex = publicKeyToRawHex(derived.publicKey);
    expect(rawHex).toMatch(/^[0-9a-f]{64}$/);
    derived.zeroize();
  });

  it("encodes typed Soroban ScVal JSON args cleanly", () => {
    const addr = Keypair.random().publicKey();
    const vals = parseDevScValArgs(
      JSON.stringify([
        { type: "u32", value: 7 },
        { type: "symbol", value: "transfer" },
        { type: "address", value: addr },
        { type: "u128", value: "10000000" },
        { type: "bool", value: true },
      ]),
    );

    expect(vals).toHaveLength(5);
    expect(scValToNative(vals[0]!)).toBe(7);
    expect(scValToNative(vals[1]!)).toBe("transfer");
    expect(scValToNative(vals[2]!)).toBe(addr);
    expect(scValToNative(vals[3]!)).toBe(10000000n);
    expect(scValToNative(vals[4]!)).toBe(true);
  });
});
