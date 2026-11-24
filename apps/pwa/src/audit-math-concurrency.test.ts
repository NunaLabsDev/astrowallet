import { calculateAccountReserveSummary } from "@astrowallet/domain";
import { formatCompactDecimal } from "@astrowallet/tg-protocol";
import { describe, expect, it } from "vitest";
import {
  requiresHighValueReauth,
  validateTransferAmount,
} from "./components/flow-validators.js";

const ISSUER = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

describe("PWA Financial Math, Mobile Keyboards & Reserve Edge Cases", () => {
  it("normalizes European/Latin comma decimals and leading zeros, and preserves >900M BigInt precision", () => {
    expect(validateTransferAmount("10,50", 100, { assetCode: "XLM", funded: true })).toBeNull();
    expect(validateTransferAmount("000.5", 100, { assetCode: "XLM", funded: true })).toBeNull();

    // Rejects scientific notation, NaN, Infinity, negative, >7 decimals
    expect(validateTransferAmount("1e-7", 100)).not.toBeNull();
    expect(validateTransferAmount("1e21", 1e22)).not.toBeNull();
    expect(validateTransferAmount("NaN", 100)).not.toBeNull();
    expect(validateTransferAmount("Infinity", 100)).not.toBeNull();
    expect(validateTransferAmount("-1", 100)).not.toBeNull();
    expect(validateTransferAmount("1.12345678", 100)).not.toBeNull();

    // >900M stroop precision: Number("5000000000.0000005") === 5000000000.000001 > 5000000000.0000005
    expect(
      validateTransferAmount("5000000000.0000005", "5000000000.0000005" as unknown as number),
    ).toBeNull();
    expect(
      validateTransferAmount("5000000000.0000006", "5000000000.0000005" as unknown as number),
    ).not.toBeNull();
  });

  it("does not fail open on comma decimals in requiresHighValueReauth", () => {
    const check = requiresHighValueReauth({
      amount: "1000,50",
      assetCode: "XLM",
      thresholdXlm: 250,
      network: "mainnet",
    });
    expect(check.required).toBe(true);
  });

  it("preserves 7-decimal dust in Telegram formatCompactDecimal instead of collapsing to 0", () => {
    expect(formatCompactDecimal("0.0000001")).toBe("0.0000001");
  });

  it("excludes zero-balance trustlines with active buyingLiabilities from reclaimable reserves", () => {
    const summary = calculateAccountReserveSummary({
      nativeBalanceXlm: "10.0000000",
      subentryCount: 2,
      balances: [
        {
          assetCode: "USDC",
          assetIssuer: ISSUER,
          balance: "0.0000000",
          buyingLiabilities: "5.0000000",
        } as { assetCode: string; assetIssuer: string; balance: string },
      ],
    });
    expect(summary.reclaimableTrustlines).toHaveLength(0);
  });
});
