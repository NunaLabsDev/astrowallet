import { describe, expect, it } from "vitest";
import {
  DeFiRegistry,
  calculateMinReceivedStroops7,
  convertEvmUsdc6ToStellarStroops7,
  convertStellarUsdcToEvmAtomic6,
  createCircleCctpRampAdapter,
  createCompositeSwapEngine,
  createHorizonPathSwapAdapter,
  createMoonPayRampAdapter,
  createSoroswapProxyAdapter,
  createTransakRampAdapter,
  parseSwapAssetIdentifier,
} from "./index.js";

const SAMPLE_ISSUER = "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6";
const SAMPLE_FORWARDER_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SAMPLE_MUXED_M = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";

describe("DeFi Swap Adapters & Registry", () => {
  it("parses native XLM and issued CODE:ISSUER identifiers", () => {
    expect(parseSwapAssetIdentifier("xlm")).toEqual({ code: "XLM" });
    expect(parseSwapAssetIdentifier(`USDC:${SAMPLE_ISSUER}`)).toEqual({
      code: "USDC",
      issuer: SAMPLE_ISSUER,
    });
  });

  it("queries Horizon Path Payments strict-send and selects best quote", async () => {
    const horizonAdapter = createHorizonPathSwapAdapter({
      horizonUrls: ["https://horizon-testnet.example.org"],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            _embedded: {
              records: [
                { destination_amount: "9.4500000" },
                { destination_amount: "9.8200000" },
              ],
            },
          }),
          { status: 200 },
        ),
    });

    const quote = await horizonAdapter.getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_ISSUER}`,
      amount: "100",
      slippageBps: 50,
    });
    expect(quote.provider).toBe("horizon-path");
    expect(quote.expectedOutputAmount).toBe("9.8200000");
  });

  it("falls back from Soroswap proxy to Horizon Path Payments when rate-limited", async () => {
    const soroswap = createSoroswapProxyAdapter({
      apiBaseUrl: "https://api-testnet.astrowallet.example",
      fetchFn: async () => new Response("Too Many Requests", { status: 429 }),
    });
    const horizon = createHorizonPathSwapAdapter({
      horizonUrls: ["https://horizon-testnet.example.org"],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            _embedded: { records: [{ destination_amount: "42.50" }] },
          }),
          { status: 200 },
        ),
    });

    const engine = createCompositeSwapEngine({
      soroswapAdapter: soroswap,
      horizonAdapter: horizon,
    });
    const quote = await engine.getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_ISSUER}`,
      amount: "400",
      slippageBps: 50,
    });
    expect(quote.provider).toBe("horizon-path");
    expect(quote.expectedOutputAmount).toBe("42.50");
  });

  it("registers and lists swap adapters cleanly in DeFiRegistry", () => {
    const registry = new DeFiRegistry();
    registry.registerSwapAdapter({
      providerName: "soroswap",
      async getQuote() {
        return {
          provider: "soroswap",
          inputAmount: "10",
          expectedOutputAmount: "1.2",
          priceImpactPct: "0.05",
        };
      },
    });
    expect(registry.listSwapProviders()).toEqual(["soroswap"]);
  });

  it("enforces Circle CCTP 6<->7 decimal guards and CctpForwarder strkey constraints", async () => {
    const inbound = convertEvmUsdc6ToStellarStroops7("1250000");
    expect(inbound.atomic6).toBe(1_250_000n);
    expect(inbound.stroops7).toBe(12_500_000n);
    expect(inbound.formattedStellarUsdc).toBe("1.2500000");

    const outbound = convertStellarUsdcToEvmAtomic6("25.123456");
    expect(outbound.atomic6).toBe(25_123_456n);
    expect(outbound.stroops7).toBe(251_234_560n);

    // Must block 7th decimal dust to prevent silent truncation
    expect(() => convertStellarUsdcToEvmAtomic6("1.0000001")).toThrow(/7th decimal digit/i);

    const cctp = createCircleCctpRampAdapter({
      bridgeBaseUrl: "https://cctp-bridge.example/forward",
      forwarderContractId: SAMPLE_FORWARDER_C,
    });

    const session = await cctp.createSessionUrl({
      direction: "onramp",
      fiatCurrency: "USD",
      assetCode: "USDC",
      amount: "10.50",
      destinationAddress: SAMPLE_ISSUER,
    });
    const parsedUrl = new URL(session.url);
    expect(parsedUrl.searchParams.get("forwarder")).toBe(SAMPLE_FORWARDER_C);
    expect(parsedUrl.searchParams.get("atomic6")).toBe("10500000");
    expect(parsedUrl.searchParams.get("stroops7")).toBe("105000000");

    // Reject M... muxed strkeys and non-USDC assets
    await expect(
      cctp.createSessionUrl({
        direction: "onramp",
        fiatCurrency: "USD",
        assetCode: "USDC",
        amount: "10",
        destinationAddress: SAMPLE_MUXED_M,
      }),
    ).rejects.toThrow(/unmuxed/i);

    await expect(
      cctp.createSessionUrl({
        direction: "onramp",
        fiatCurrency: "USD",
        assetCode: "XLM",
        amount: "10",
        destinationAddress: SAMPLE_ISSUER,
      }),
    ).rejects.toThrow(/USDC/i);
  });

  it("builds self-serve MoonPay and Transak RampPort session URLs", async () => {
    const moonpay = createMoonPayRampAdapter({
      widgetBaseUrl: "https://ramp-moonpay.example/widget",
      apiKey: "pk_test_demo",
    });
    const transak = createTransakRampAdapter({
      widgetBaseUrl: "https://ramp-transak.example/widget",
    });

    const registry = new DeFiRegistry();
    registry.registerRampAdapter(moonpay).registerRampAdapter(transak);
    expect(registry.listRampProviders()).toEqual(["moonpay", "transak"]);

    const mpSession = await moonpay.createSessionUrl({
      direction: "onramp",
      fiatCurrency: "USD",
      assetCode: "XLM",
      amount: "100",
      destinationAddress: SAMPLE_ISSUER,
    });
    expect(new URL(mpSession.url).searchParams.get("currencyCode")).toBe("xlm");

    const trSession = await transak.createSessionUrl({
      direction: "offramp",
      fiatCurrency: "EUR",
      assetCode: "USDC",
      amount: "50",
      destinationAddress: SAMPLE_ISSUER,
    });
    const trUrl = new URL(trSession.url);
    expect(trUrl.searchParams.get("productsAvailed")).toBe("SELL");
    expect(trUrl.searchParams.get("network")).toBe("stellar");
  });

  it("compares Horizon paths via exact BigInt stroops and reports honest N/A price impact", async () => {
    const horizon = createHorizonPathSwapAdapter({
      horizonUrls: ["https://horizon-test.example"],
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            _embedded: {
              records: [
                { destination_amount: "10000000000.0000001", path: [] },
                { destination_amount: "10000000000.0000002", path: [] },
              ],
            },
          }),
          { status: 200 },
        ),
    });

    const horizonQuote = await horizon.getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_ISSUER}`,
      amount: "100",
      slippageBps: 50,
    });
    expect(horizonQuote.expectedOutputAmount).toBe("10000000000.0000002");
    expect(horizonQuote.priceImpactPct).toBe("N/A");

    const soroswap = createSoroswapProxyAdapter({
      apiBaseUrl: "https://api-test.example",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            expectedOutputAmount: "42.1234567",
          }),
          { status: 200 },
        ),
    });
    const soroswapQuote = await soroswap.getQuote({
      fromAsset: "XLM",
      toAsset: `USDC:${SAMPLE_ISSUER}`,
      amount: "100",
      slippageBps: 50,
    });
    expect(soroswapQuote.priceImpactPct).toBe("N/A");
  });

  it("calculates exact BigInt minimum received stroops and guards invalid slippage", () => {
    expect(calculateMinReceivedStroops7("100.0000000", 50)).toBe(995_000_000n);
    expect(calculateMinReceivedStroops7("10000000000.0000001", 100)).toBe(99_000_000_000_000_000n);
    expect(() => calculateMinReceivedStroops7("10", -1)).toThrow(/integer/i);
    expect(() => calculateMinReceivedStroops7("10", 10_000)).toThrow(/integer/i);
    expect(() => calculateMinReceivedStroops7("10", 12.5)).toThrow(/integer/i);
    expect(() => calculateMinReceivedStroops7("0", 50)).toThrow(/greater than zero/i);
    expect(() => calculateMinReceivedStroops7("0.0000001", 50)).toThrow(/greater than zero/i);
  });
});
