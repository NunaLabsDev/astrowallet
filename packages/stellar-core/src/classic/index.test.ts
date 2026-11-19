import type { ClassicAddress, MuxedAddress } from "@astrowallet/domain";
import { Keypair, MemoHash, MemoID, MemoNone, MemoReturn, MemoText } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildChangeTrustOperation,
  buildClaimClaimableBalanceOperation,
  buildLumenWipeReclaimOperations,
  buildManageSellOfferOperation,
  buildStellarMemo,
  decodeMuxedAddress,
  encodeMuxedAddress,
} from "./index.js";

describe("Classic Stellar completeness (@astrowallet/stellar-core)", () => {
  it("encodes and decodes CAP-27 M... muxed addresses deterministically", () => {
    const baseAddress = Keypair.random().publicKey() as ClassicAddress;
    const muxed = encodeMuxedAddress(baseAddress, "123456789012345");
    expect(muxed.startsWith("M")).toBe(true);
    expect(muxed.length).toBe(69);

    const decoded = decodeMuxedAddress(muxed);
    expect(decoded.baseAddress).toBe(baseAddress);
    expect(decoded.muxedId).toBe("123456789012345");

    expect(() => encodeMuxedAddress(baseAddress, "-5")).toThrow();
    expect(() => encodeMuxedAddress(baseAddress, "18446744073709551616")).toThrow();
    expect(() => decodeMuxedAddress(baseAddress as unknown as MuxedAddress)).toThrow();
  });

  it("builds and validates typed memos (none, text, id, hash, return)", () => {
    expect(buildStellarMemo({ kind: "none" }).type).toBe(MemoNone);

    const textMemo = buildStellarMemo({ kind: "text", value: "AstroWallet Test" });
    expect(textMemo.type).toBe(MemoText);
    expect(textMemo.value).toBe("AstroWallet Test");
    expect(() => buildStellarMemo({ kind: "text", value: "a".repeat(29) })).toThrow();

    const idMemo = buildStellarMemo({ kind: "id", value: "99887766" });
    expect(idMemo.type).toBe(MemoID);
    expect(idMemo.value).toBe("99887766");
    expect(() => buildStellarMemo({ kind: "id", value: "not-a-number" })).toThrow();

    const hex32 = "ab".repeat(32);
    const hashMemo = buildStellarMemo({ kind: "hash", valueHex: hex32 });
    expect(hashMemo.type).toBe(MemoHash);

    const returnMemo = buildStellarMemo({ kind: "return", valueHex: hex32 });
    expect(returnMemo.type).toBe(MemoReturn);
    expect(() => buildStellarMemo({ kind: "hash", valueHex: "abcd" })).toThrow();
  });

  it("builds changeTrust, LumenWipe reclaim ops, claimClaimableBalance, and manageSellOffer", () => {
    const issuer = Keypair.random().publicKey() as ClassicAddress;

    const addTrust = buildChangeTrustOperation({
      assetCode: "USDC",
      assetIssuer: issuer,
    });
    expect(addTrust.body.type).toBe("changeTrust");

    const reclaimOps = buildLumenWipeReclaimOperations([
      { assetCode: "USDC", assetIssuer: issuer },
      { assetCode: "EURC", assetIssuer: issuer },
    ]);
    expect(reclaimOps).toHaveLength(2);
    if (reclaimOps[0]?.body.type === "changeTrust") {
      expect(reclaimOps[0].body.value.limit.toString()).toBe("0");
    } else {
      throw new Error("Expected changeTrust operation body");
    }

    const balanceId = `00000000${"12".repeat(32)}`;
    const claimOp = buildClaimClaimableBalanceOperation(balanceId);
    expect(claimOp.body.type).toBe("claimClaimableBalance");
    expect(() => buildClaimClaimableBalanceOperation("short")).toThrow();

    const sellOp = buildManageSellOfferOperation({
      selling: { assetCode: "XLM" },
      buying: { assetCode: "USDC", assetIssuer: issuer },
      amount: "100.0000000",
      price: "0.25",
    });
    expect(sellOp.body.type).toBe("manageSellOffer");
  });
});
