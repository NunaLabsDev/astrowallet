import { describe, expect, it } from "vitest";
import { deriveStellarAccount } from "../sep0005.js";
import {
  AGENT_DERIVATION_INDEX,
  buildX402PaymentHeader,
  createDefaultAgentBudgetPolicy,
  evaluateAgentSpendRequest,
  getEffectiveSpentTodayStroops,
  parseX402PaymentRequiredHeader,
  recordAgentSpend,
  signX402ChallengeWithKeypair,
} from "./index.js";

describe("x402 Agent Allowance Policy Engine", () => {
  it("enforces kill-switch, domain allowlist, per-request cap, daily cap, and UTC rollover", () => {
    expect(AGENT_DERIVATION_INDEX).toBe(99);
    const now = Date.UTC(2026, 10, 23, 12, 0, 0);
    let policy = createDefaultAgentBudgetPolicy("testnet", now);

    // Paused by default
    const paused = evaluateAgentSpendRequest(
      policy,
      { domain: "astrodex-testnet.pages.dev", network: "stellar:testnet", amountStroops: "10000" },
      now,
    );
    expect(paused.allowed).toBe(false);

    policy = { ...policy, enabled: true, dailyCapStroops: "25000", maxPerRequestStroops: "15000" };

    // Domain blocked
    expect(
      evaluateAgentSpendRequest(
        policy,
        { domain: "evil.example", network: "stellar:testnet", amountStroops: "10000" },
        now,
      ).allowed,
    ).toBe(false);

    // Over per-request cap
    expect(
      evaluateAgentSpendRequest(
        policy,
        { domain: "astrodex-testnet.pages.dev", network: "stellar:testnet", amountStroops: "20000" },
        now,
      ).allowed,
    ).toBe(false);

    // Allowed spend #1 (15000)
    expect(
      evaluateAgentSpendRequest(
        policy,
        { domain: "astrodex-testnet.pages.dev", network: "stellar:testnet", amountStroops: "15000" },
        now,
      ).allowed,
    ).toBe(true);
    policy = recordAgentSpend(policy, "15000", now);

    // Spend #2 (15000) exceeds daily cap (15000 + 15000 > 25000)
    expect(
      evaluateAgentSpendRequest(
        policy,
        { domain: "astrodex-testnet.pages.dev", network: "stellar:testnet", amountStroops: "15000" },
        now,
      ).allowed,
    ).toBe(false);

    // Next UTC day resets spentTodayStroops
    const nextDay = Date.UTC(2026, 10, 24, 0, 5, 0);
    expect(
      evaluateAgentSpendRequest(
        policy,
        { domain: "astrodex-testnet.pages.dev", network: "stellar:testnet", amountStroops: "15000" },
        nextDay,
      ).allowed,
    ).toBe(true);
  });

  it("parses PAYMENT-REQUIRED and encodes X-PAYMENT headers", () => {
    const reqHdr = btoa(
      JSON.stringify({
        x402Version: 2,
        accepts: [
          {
            scheme: "exact",
            network: "stellar:testnet",
            asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
            amount: "10000",
            payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
          },
        ],
      }),
    );
    const parsed = parseX402PaymentRequiredHeader(reqHdr);
    expect(parsed.x402Version).toBe(2);
    expect(parsed.accepts[0]?.amount).toBe("10000");

    const payHdr = buildX402PaymentHeader({
      x402Version: 2,
      network: "stellar:testnet",
      payer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "10000",
      payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      nonce: "n1",
      signatureBase64: "sig",
    });
    expect(JSON.parse(atob(payHdr)).nonce).toBe("n1");
  });

  it("resets UTC daily spend cleanly and signs x402 challenges with isolated index 99", () => {
    const day1 = Date.UTC(2026, 10, 23, 23, 59, 0);
    const day2 = Date.UTC(2026, 10, 24, 0, 1, 0);
    const p1 = recordAgentSpend(createDefaultAgentBudgetPolicy("testnet", day1), "50000", day1);
    expect(getEffectiveSpentTodayStroops(p1, day1)).toBe("50000");
    expect(getEffectiveSpentTodayStroops(p1, day2)).toBe("0");

    const mnemonic =
      "illness spike retreat truth genius clock brain pass fit cave bargain toe";
    const agent = deriveStellarAccount(mnemonic, AGENT_DERIVATION_INDEX);
    const signed = signX402ChallengeWithKeypair(agent.toKeypair(), {
      x402Version: 2,
      network: "stellar:testnet",
      asset: "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA",
      amount: "10000",
      payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      nonce: "nonce99",
    });
    expect(signed.payer).toBe(agent.publicKey);
    expect(JSON.parse(atob(signed.paymentHeader)).payer).toBe(agent.publicKey);
    agent.zeroize();
  });
});
