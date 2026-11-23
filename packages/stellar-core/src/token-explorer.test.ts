import type { ClassicAddress } from "@astrowallet/domain";
import { Keypair } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  discoverLiquidHorizonAssets,
  fetchHeldAssetsTomlMetadata,
  fetchTokenOnChainDetails,
  fetchTokenOrderbookAgainstXlm,
  fetchTokenPriceHistoryAgainstXlm,
  parseStellarTomlForAsset,
  searchHorizonAssets,
} from "./ledger/token-explorer.js";

const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
const ISSUER_USDC = Keypair.random().publicKey() as ClassicAddress;

describe("Stellar Token Explorer & Market Scanner", () => {
  it("searches Horizon /assets for codes and CODE:G... queries with failover", async () => {
    const calls: string[] = [];
    const results = await searchHorizonAssets({
      horizonUrls: ["https://horizon-1.example", "https://horizon-2.example"],
      query: "USDC",
      limit: 10,
      fetchFn: async (input) => {
        const url = String(input);
        calls.push(url);
        if (url.startsWith("https://horizon-1.example")) {
          return new Response("gateway error", { status: 502 });
        }
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  asset_code: "USDC",
                  asset_issuer: ISSUER_USDC,
                  amount: "1250000.0000000",
                  accounts: { authorized: 4210 },
                  _links: { toml: { href: "https://centre.io/.well-known/stellar.toml" } },
                },
              ],
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(calls).toHaveLength(2);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      domain: "centre.io",
      numAccounts: 4210,
      supplyAmount: "1250000.0000000",
      isVerified: false,
      hasTrustline: false,
    });
  });

  it("fetches native XLM details with deterministic SAC C... address and immutable flags", async () => {
    const details = await fetchTokenOnChainDetails({
      horizonUrls: ["https://horizon-test.example"],
      networkPassphrase: TESTNET_PASSPHRASE,
      assetCode: "XLM",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            _embedded: {
              records: [{ total_coins: "105443902087.3472865" }],
            },
          }),
          { status: 200 },
        ),
    });

    expect(details.isNative).toBe(true);
    expect(details.assetCode).toBe("XLM");
    expect(details.sacContractId).toMatch(/^C[A-Z2-7]{55}$/);
    expect(details.homeDomain).toBe("stellar.org");
    expect(details.supplyAmount).toBe("105443902087.3472865");
    expect(details.flags.authImmutable).toBe(true);
    expect(details.flags.authClawbackEnabled).toBe(false);
  });

  it("fetches issued token supply, trustlines, SAC C..., home_domain, and issuer flags", async () => {
    const details = await fetchTokenOnChainDetails({
      horizonUrls: ["https://horizon-test.example"],
      networkPassphrase: TESTNET_PASSPHRASE,
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/assets?")) {
          return new Response(
            JSON.stringify({
              _embedded: {
                records: [
                  {
                    asset_code: "USDC",
                    asset_issuer: ISSUER_USDC,
                    balances: { authorized: "98765432.1000000" },
                    accounts: { authorized: 18500 },
                    claimable_balances_amount: "420.5000000",
                    liquidity_pools_amount: "150000.0000000",
                    flags: {
                      auth_required: false,
                      auth_revocable: true,
                      auth_immutable: false,
                      auth_clawback_enabled: true,
                    },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            home_domain: "circle.com",
            flags: {
              auth_required: false,
              auth_revocable: true,
              auth_immutable: false,
              auth_clawback_enabled: true,
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(details.isNative).toBe(false);
    expect(details.assetIssuer).toBe(ISSUER_USDC);
    expect(details.sacContractId).toMatch(/^C[A-Z2-7]{55}$/);
    expect(details.homeDomain).toBe("circle.com");
    expect(details.supplyAmount).toBe("98765432.1000000");
    expect(details.numAccounts).toBe(18500);
    expect(details.claimableBalancesAmount).toBe("420.5000000");
    expect(details.liquidityPoolsAmount).toBe("150000.0000000");
    expect(details.flags).toEqual({
      authRequired: false,
      authRevocable: true,
      authImmutable: false,
      authClawbackEnabled: true,
    });
  });

  it("parses historical OHLC candles from /trade_aggregations and falls back cleanly to /order_book", async () => {
    const aggResult = await fetchTokenPriceHistoryAgainstXlm({
      horizonUrls: ["https://horizon-test.example"],
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      timeframe: "24h",
      nowMs: 1_760_000_000_000,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  timestamp: "1759996400000",
                  open: "10.00",
                  high: "11.50",
                  low: "9.80",
                  close: "11.00",
                  base_volume: "500.0",
                },
                {
                  timestamp: "1759992800000",
                  open: "9.50",
                  high: "10.20",
                  low: "9.40",
                  close: "10.00",
                  base_volume: "300.0",
                },
              ],
            },
          }),
          { status: 200 },
        ),
    });

    expect(aggResult.source).toBe("trade_aggregations");
    expect(aggResult.candles).toHaveLength(2);
    expect(aggResult.latestPriceXlm).toBe(11);
    expect(aggResult.high).toBe(11.5);
    expect(aggResult.low).toBe(9.4);
    expect(aggResult.volumeBase).toBe(800);
    expect(aggResult.changePct).toBeCloseTo(((11 - 9.5) / 9.5) * 100, 4);

    // Fallback when aggregations and trades are empty
    const fallbackResult = await fetchTokenPriceHistoryAgainstXlm({
      horizonUrls: ["https://horizon-test.example"],
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      timeframe: "7d",
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/order_book")) {
          return new Response(
            JSON.stringify({
              bids: [{ price: "9.90", amount: "100" }],
              asks: [{ price: "10.10", amount: "100" }],
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ _embedded: { records: [] } }), { status: 200 });
      },
    });

    expect(fallbackResult.source).toBe("order_book");
    expect(fallbackResult.candles).toHaveLength(0);
    expect(fallbackResult.latestPriceXlm).toBe(10);

    const ob = await fetchTokenOrderbookAgainstXlm({
      horizonUrls: ["https://horizon-test.example"],
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            bids: [{ price: "9.90", amount: "250.00" }],
            asks: [{ price: "10.10", amount: "180.00" }],
          }),
          { status: 200 },
        ),
    });
    expect(ob.midPriceXlm).toBe("10.0000");
    expect(ob.spreadPct).toBe("2.00");
  });

  it("discovers functional liquid assets from Horizon /liquidity_pools and /assets", async () => {
    const issuerLiquid = Keypair.random().publicKey() as ClassicAddress;
    const issuerAssetOnly = Keypair.random().publicKey() as ClassicAddress;

    const results = await discoverLiquidHorizonAssets({
      horizonUrls: ["https://horizon-test.example"],
      limit: 10,
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/liquidity_pools")) {
          return new Response(
            JSON.stringify({
              _embedded: {
                records: [
                  {
                    id: "pool-1",
                    total_shares: "1000.0000000",
                    reserves: [
                      { asset: "native", amount: "5000.0000000" },
                      { asset: `USDC:${issuerLiquid}`, amount: "1200.0000000" },
                    ],
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  asset_code: "SRT",
                  asset_issuer: issuerAssetOnly,
                  accounts: { authorized: 42 },
                  balances: { authorized: "9000.0000000" },
                  _links: { toml: { href: "https://srt.example/.well-known/stellar.toml" } },
                },
              ],
            },
          }),
          { status: 200 },
        );
      },
    });

    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({
      assetCode: "USDC",
      assetIssuer: issuerLiquid,
      hasLiquidityPool: true,
      poolReserveAmount: "1200.0000000",
    });
    expect(results[1]).toMatchObject({
      assetCode: "SRT",
      assetIssuer: issuerAssetOnly,
      domain: "srt.example",
      numAccounts: 42,
    });
  });

  it("parses official SEP-1 stellar.toml [[CURRENCIES]] logos/metadata and native XLM ledger protocol telemetry", async () => {
    const sampleToml = `
[DOCUMENTATION]
ORG_NAME = "Circle Internet Financial"
ORG_URL = "https://www.circle.com"

[[CURRENCIES]]
code = "USDC"
issuer = "${ISSUER_USDC}"
name = "USD Coin"
desc = "Fully reserved US dollar stablecoin on Stellar."
image = "https://www.circle.com/usdc-stellar.png"
is_asset_anchored = true
anchor_asset = "USD"
`;
    const parsed = parseStellarTomlForAsset(sampleToml, "USDC", ISSUER_USDC);
    expect(parsed).toEqual({
      code: "USDC",
      issuer: ISSUER_USDC,
      name: "USD Coin",
      desc: "Fully reserved US dollar stablecoin on Stellar.",
      image: "https://www.circle.com/usdc-stellar.png",
      isAssetAnchored: true,
      anchorAsset: "USD",
      orgName: "Circle Internet Financial",
      orgUrl: "https://www.circle.com/",
    });

    const nativeDetails = await fetchTokenOnChainDetails({
      horizonUrls: ["https://horizon-test.example"],
      networkPassphrase: TESTNET_PASSPHRASE,
      assetCode: "XLM",
      fetchFn: async () =>
        new Response(
          JSON.stringify({
            _embedded: {
              records: [
                {
                  sequence: 54321098,
                  total_coins: "105443902087.3472865",
                  base_fee_in_stroops: 100,
                  base_reserve_in_stroops: 5000000,
                  max_tx_set_size: 1000,
                  protocol_version: 22,
                },
              ],
            },
          }),
          { status: 200 },
        ),
    });
    expect(nativeDetails.latestLedgerSequence).toBe(54321098);
    expect(nativeDetails.baseFeeStroops).toBe(100);
    expect(nativeDetails.baseReserveStroops).toBe(5000000);
    expect(nativeDetails.maxTxSetSize).toBe(1000);
    expect(nativeDetails.protocolVersion).toBe(22);
    expect(nativeDetails.name).toBe("Stellar Lumens");

    const issuedWithToml = await fetchTokenOnChainDetails({
      horizonUrls: ["https://horizon-test.example"],
      networkPassphrase: TESTNET_PASSPHRASE,
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      apiBaseUrl: "https://api-test.example",
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes("/v1/proxy/stellar-toml")) {
          return new Response(sampleToml, { status: 200 });
        }
        if (url.includes("/assets?")) {
          return new Response(
            JSON.stringify({
              _embedded: {
                records: [
                  {
                    asset_code: "USDC",
                    asset_issuer: ISSUER_USDC,
                    balances: { authorized: "98765432.1000000" },
                    accounts: { authorized: 18500 },
                  },
                ],
              },
            }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ home_domain: "circle.com" }), { status: 200 });
      },
    });
    expect(issuedWithToml.name).toBe("USD Coin");
    expect(issuedWithToml.image).toBe("https://www.circle.com/usdc-stellar.png");
    expect(issuedWithToml.orgName).toBe("Circle Internet Financial");
    expect(issuedWithToml.isAssetAnchored).toBe(true);
    expect(issuedWithToml.anchorAsset).toBe("USD");
  });

  it("enforces strict [[CURRENCIES]] matching (no ORG_LOGO or unlisted fallback) and resolves held-asset stellar.toml metadata", async () => {
    const tomlWithOrgLogoOnly = `
[DOCUMENTATION]
ORG_NAME = "Example Org"
ORG_LOGO = "https://example.org/org-logo.png"

[[CURRENCIES]]
code = "EURC"
issuer = "${ISSUER_USDC}"
name = "Euro Coin"
`;
    expect(parseStellarTomlForAsset(tomlWithOrgLogoOnly, "USDC", ISSUER_USDC)).toBeNull();

    const matchedNoCurrencyImage = parseStellarTomlForAsset(
      tomlWithOrgLogoOnly,
      "EURC",
      ISSUER_USDC,
    );
    expect(matchedNoCurrencyImage).toMatchObject({
      code: "EURC",
      issuer: ISSUER_USDC,
      name: "Euro Coin",
      orgName: "Example Org",
    });
    expect(matchedNoCurrencyImage?.image).toBeUndefined();

    const issuerNoImage = Keypair.random().publicKey() as ClassicAddress;
    const heldMeta = await fetchHeldAssetsTomlMetadata({
      horizonUrls: ["https://horizon-test.example"],
      assets: [
        { assetCode: "XLM" },
        { assetCode: "USDC", assetIssuer: ISSUER_USDC },
        { assetCode: "EURC", assetIssuer: issuerNoImage },
      ],
      apiBaseUrl: "https://api-test.example",
      fetchFn: async (input) => {
        const url = String(input);
        if (url.includes(`/accounts/${ISSUER_USDC}`)) {
          return new Response(JSON.stringify({ home_domain: "circle.com" }), { status: 200 });
        }
        if (url.includes(`/accounts/${issuerNoImage}`)) {
          return new Response(JSON.stringify({}), { status: 200 });
        }
        if (url.includes("domain=circle.com")) {
          return new Response(
            `[[CURRENCIES]]\ncode = "USDC"\nissuer = "${ISSUER_USDC}"\nname = "USD Coin"\nimage = "https://circle.com/usdc.png"\n`,
            { status: 200 },
          );
        }
        return new Response("", { status: 404 });
      },
    });

    expect(heldMeta[`USDC:${ISSUER_USDC}`]).toMatchObject({
      assetCode: "USDC",
      assetIssuer: ISSUER_USDC,
      homeDomain: "circle.com",
      name: "USD Coin",
      image: "https://circle.com/usdc.png",
      tomlMatched: true,
    });
    expect(heldMeta[`EURC:${issuerNoImage}`]).toMatchObject({
      assetCode: "EURC",
      assetIssuer: issuerNoImage,
      tomlMatched: false,
    });
    expect(heldMeta[`EURC:${issuerNoImage}`]?.image).toBeUndefined();
  });
});
