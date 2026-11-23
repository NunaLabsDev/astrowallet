import { describe, expect, it } from "vitest";
import {
  isClassicStellarNftBalance,
  isZeroBalanceTrustline,
  partitionWalletBalances,
} from "./asset-classification.js";

describe("asset-classification", () => {
  it("classifies 1-stroop issued assets as Classic Stellar NFTs", () => {
    expect(
      isClassicStellarNftBalance({
        assetCode: "EGG0043",
        assetIssuer: "GCOYKORYDA...",
        balance: "0.0000001",
      }),
    ).toBe(true);
    expect(
      isClassicStellarNftBalance({
        assetCode: "XLM",
        balance: "0.0000001",
      }),
    ).toBe(false);
    expect(
      isClassicStellarNftBalance({
        assetCode: "USDC",
        assetIssuer: "GA5ZSEJY...",
        balance: "12.5000000",
      }),
    ).toBe(false);
  });

  it("partitions balances cleanly with XLM first, NFTs separated, and zero trustlines grouped", () => {
    const res = partitionWalletBalances([
      { assetCode: "USDC", assetIssuer: "GA5Z...", balance: "10.0000000" },
      { assetCode: "EGG0043", assetIssuer: "GCOY...", balance: "0.0000001" },
      { assetCode: "AQUA", assetIssuer: "GBNZ...", balance: "0.0000000" },
      { assetCode: "XLM", balance: "64.7875026" },
    ]);

    expect(res.fungible.map((b) => b.assetCode)).toEqual(["XLM", "USDC"]);
    expect(res.classicNfts.map((b) => b.assetCode)).toEqual(["EGG0043"]);
    expect(res.emptyTrustlines.map((b) => b.assetCode)).toEqual(["AQUA"]);
    expect(isZeroBalanceTrustline(res.emptyTrustlines[0]!)).toBe(true);
  });
});
