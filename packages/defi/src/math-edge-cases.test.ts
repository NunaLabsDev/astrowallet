import { describe, expect, it } from "vitest";
import {
  computeLayerZeroOftSharedAmount,
} from "./ramps.js";
import {
  createHorizonPathSwapAdapter,
  parseSoroswapQuoteOutput,
  stroops7ToDecimal,
} from "./index.js";

const SAMPLE_ISSUER = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";

describe("Financial Math & Edge Cases Regression Suite (Front 3)", () => {
  it("formats negative stroops7ToDecimal without malformed minus signs", () => {
    expect(stroops7ToDecimal(-5n)).toBe("-0.0000005");
    expect(stroops7ToDecimal(-10_000_005n)).toBe("-1.0000005");
  });

  it("rejects zero and >7-decimal outputs in parseSoroswapQuoteOutput and handles huge integers", () => {
    expect(parseSoroswapQuoteOutput({ expectedOutputAmount: "0" })).toBeNull();
    expect(parseSoroswapQuoteOutput({ expectedOutputAmount: "0.0000000" })).toBeNull();
    expect(parseSoroswapQuoteOutput({ expectedOutputAmount: "1.12345678" })).toBe("1.1234567");
    expect(parseSoroswapQuoteOutput({ amountOut: "0" })).toBeNull();
  });

  it("rejects sub-microdust (< 0.000001) in computeLayerZeroOftSharedAmount", () => {
    expect(() => computeLayerZeroOftSharedAmount("0.0000001")).toThrow(/0\.000001|dust|shared/i);
  });

  it("computes SDEX orderbook strict-send output with exact BigInt math on >900M and decimal inputs", async () => {
    const adapter = createHorizonPathSwapAdapter({
      horizonUrls: ["https://horizon-test.example"],
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/paths/strict-send")) {
          return new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 });
        }
        return new Response(
          JSON.stringify({
            bids: [
              // Exact price 1:1 on >900M where Number(1000000000.0000001) loses stroop precision
              { price: "1.0000000", price_r: { n: 1, d: 1 }, amount: "2000000000.0000000" },
            ],
            asks: [],
          }),
          { status: 200 },
        );
      },
    });

    const hugeQuote = await adapter.getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_ISSUER}`,
      amount: "1000000000.0000001",
      slippageBps: 50,
    });
    expect(hugeQuote.expectedOutputAmount).toBe("1000000000.0000001");

    const dustQuote = await adapter.getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_ISSUER}`,
      amount: "0.41",
      slippageBps: 50,
    });
    expect(dustQuote.expectedOutputAmount).toBe("0.41");
  });
});
