import { describe, expect, it } from "vitest";
import { buildHumanClearSignSummary } from "./human-summary.js";
import type { DecodedTransactionSummary } from "./decoder.js";

function baseTx(operations: DecodedTransactionSummary["operations"]): DecodedTransactionSummary {
  return {
    isFeeBump: false,
    sourceAccount: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    feeStroops: "100",
    memo: { type: "none" },
    operations,
  };
}

describe("buildHumanClearSignSummary", () => {
  it("summarizes Classic payments, swaps, trustlines, and sponsored fees", () => {
    const pay = buildHumanClearSignSummary({
      decoded: baseTx([
        {
          type: "payment",
          destination: "GBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
          amount: "25.00",
          asset: { code: "USDE" },
        },
      ]),
      balanceDiffs: [
        {
          address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          assetCode: "USDE",
          delta: "-25.00",
        },
      ],
      findings: [],
      verdict: "benign",
      isSponsored: true,
    });
    expect(pay.actionCategory).toBe("payment");
    expect(pay.headline).toContain("Send 25.00 USDE");
    expect(pay.feeLabel).toContain("sponsored (0 XLM)");
    expect(pay.netChanges[0]).toEqual({ asset: "USDE", delta: "-25.00", direction: "out" });

    const swap = buildHumanClearSignSummary({
      decoded: baseTx([
        { type: "changeTrust", asset: { code: "USDE" }, amount: "922337203685.4775807" },
        {
          type: "pathPaymentStrictSend",
          sendAsset: { code: "USDC" },
          destAsset: { code: "USDE" },
          amount: "10",
        },
      ]),
      findings: [],
      verdict: "benign",
    });
    expect(swap.actionCategory).toBe("swap");
    expect(swap.headline).toContain("Swap 10 USDC → USDE (+ Trustline)");
  });

  it("summarizes Soroban escrow calls and blocks malicious transactions", () => {
    const escrow = buildHumanClearSignSummary({
      decoded: baseTx([
        {
          type: "invokeHostFunction",
          soroban: {
            contractId: "CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ",
            functionName: "create_claim",
            args: [],
            subInvocations: [],
          },
        },
      ]),
      findings: [],
      verdict: "benign",
    });
    expect(escrow.actionCategory).toBe("escrow");
    expect(escrow.headline).toContain("Claim Escrow (create_claim)");

    const blocked = buildHumanClearSignSummary({
      decoded: baseTx([{ type: "setOptions", masterWeight: 0 }]),
      findings: [
        {
          code: "MALICIOUS_SET_OPTIONS_MASTER_LOCKOUT",
          severity: "malicious",
          title: "Master Key Lockout Blocked",
          description: "Locks out master key",
          blocksSigning: true,
        },
      ],
      verdict: "malicious",
    });
    expect(blocked.actionCategory).toBe("danger");
    expect(blocked.headline).toContain("Blocked: Master Key Lockout Blocked");

    const extraOps = buildHumanClearSignSummary({
      decoded: baseTx([
        { type: "claimClaimableBalance" },
        { type: "manageData" },
        { type: "restoreFootprint" },
        { type: "setTrustLineFlags" },
      ]),
      findings: [],
      verdict: "benign",
    });
    expect(extraOps.headline).toBe("Claim Pending Balance (+ Trustline)");
    expect(extraOps.plainSteps).toHaveLength(3);
  });
});
