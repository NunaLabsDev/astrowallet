import { describe, expect, it } from "vitest";
import { applyPwaNetworkProfile, parsePwaConfig, parseServerConfig } from "./config.js";

const VALID_TESTNET_PWA_ENV = {
  VITE_STELLAR_NETWORK: "testnet",
  VITE_STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  VITE_STELLAR_RPC_URLS: "https://soroban-testnet.stellar.org, https://rpc-testnet.example.org",
  VITE_HORIZON_URLS: "https://horizon-testnet.stellar.org",
  VITE_API_BASE_URL: "https://api-testnet.astrowallet.example",
  VITE_PWA_ORIGIN: "https://testnet.astrowallet.example",
  VITE_TG_BOT_USERNAME: "@AstroWalletTestBot",
  VITE_FRIENDBOT_URL: "https://friendbot.stellar.org",
  VITE_SEP42_ASSET_LIST_URLS: "https://assets.example.org/testnet.json",
};

const VALID_TESTNET_SERVER_ENV = {
  STELLAR_NETWORK: "testnet",
  STELLAR_NETWORK_PASSPHRASE: "Test SDF Network ; September 2015",
  STELLAR_RPC_URLS: "https://soroban-testnet.stellar.org",
  HORIZON_URLS: "https://horizon-testnet.stellar.org",
  PWA_ORIGIN: "https://testnet.astrowallet.example",
  ALLOWED_ORIGINS: "https://testnet.astrowallet.example,http://localhost:5173",
  FRIENDBOT_URL: "https://friendbot.stellar.org",
  TG_BOT_TOKEN: "test-bot-token-value",
  TG_WEBHOOK_SECRET: "webhook-secret-min-16-chars",
  INTENT_HMAC_SECRET: "intent-hmac-secret-at-least-32-bytes-long",
};

describe("parsePwaConfig", () => {
  it("parses valid testnet configuration and strips @ from bot username", () => {
    const config = parsePwaConfig(VALID_TESTNET_PWA_ENV);
    expect(config.network).toBe("testnet");
    expect(config.tgBotUsername).toBe("AstroWalletTestBot");
    expect(config.rpcUrls).toEqual([
      "https://soroban-testnet.stellar.org",
      "https://rpc-testnet.example.org",
    ]);
    expect(config.friendbotUrl).toBe("https://friendbot.stellar.org");
  });

  it("parses valid mainnet configuration without friendbotUrl", () => {
    const config = parsePwaConfig({
      ...VALID_TESTNET_PWA_ENV,
      VITE_STELLAR_NETWORK: "mainnet",
      VITE_STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      VITE_FRIENDBOT_URL: undefined,
    });
    expect(config.network).toBe("mainnet");
    expect(config.friendbotUrl).toBeUndefined();
  });

  it("rejects mainnet configuration if VITE_FRIENDBOT_URL is configured", () => {
    expect(() =>
      parsePwaConfig({
        ...VALID_TESTNET_PWA_ENV,
        VITE_STELLAR_NETWORK: "mainnet",
        VITE_STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      }),
    ).toThrow(/VITE_FRIENDBOT_URL/);
  });

  it("fails fast when required RPC URLs are missing", () => {
    expect(() =>
      parsePwaConfig({
        ...VALID_TESTNET_PWA_ENV,
        VITE_STELLAR_RPC_URLS: "",
      }),
    ).toThrow(/VITE_STELLAR_RPC_URLS/);
  });
});

describe("parseServerConfig", () => {
  it("parses valid testnet server configuration with rate-limit defaults and optional hardening vars", () => {
    const config = parseServerConfig(VALID_TESTNET_SERVER_ENV);
    expect(config.network).toBe("testnet");
    expect(config.allowedOrigins).toEqual([
      "https://testnet.astrowallet.example",
      "http://localhost:5173",
    ]);
    expect(config.sep42AssetListUrls).toEqual([]);
    expect(config.relayAllowedContracts).toEqual([]);
    expect(config.relayRateLimitPerMin).toBe(10);
    expect(config.proxyRateLimitPerMin).toBe(60);

    const custom = parseServerConfig({
      ...VALID_TESTNET_SERVER_ENV,
      SEP42_ASSET_LIST_URLS: "https://assets.example.org/list.json",
      CLAIM_ESCROW_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      RELAY_ALLOWED_CONTRACTS: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      RELAY_RATE_LIMIT_PER_MIN: "25",
      PROXY_RATE_LIMIT_PER_MIN: "120",
    });
    expect(custom.sep42AssetListUrls).toEqual(["https://assets.example.org/list.json"]);
    expect(custom.claimEscrowContractId).toBe(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    );
    expect(custom.relayAllowedContracts).toHaveLength(1);
    expect(custom.relayRateLimitPerMin).toBe(25);
    expect(custom.proxyRateLimitPerMin).toBe(120);
  });

  it("parses optional PWA ramp config fields cleanly", () => {
    const pwa = parsePwaConfig({
      ...VALID_TESTNET_PWA_ENV,
      VITE_CCTP_BRIDGE_URL: "https://bridge.example.org",
      VITE_CCTP_FORWARDER_CONTRACT_ID: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
      VITE_MOONPAY_WIDGET_URL: "https://buy.moonpay.example",
      VITE_TRANSAK_WIDGET_URL: "https://global.transak.example",
    });
    expect(pwa.cctpBridgeUrl).toBe("https://bridge.example.org");
    expect(pwa.cctpForwarderContractId).toBe(
      "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    );
    expect(pwa.moonPayWidgetUrl).toBe("https://buy.moonpay.example");
    expect(pwa.transakWidgetUrl).toBe("https://global.transak.example");
  });

  it("hard-blocks FRIENDBOT_URL when STELLAR_NETWORK=mainnet", () => {
    expect(() =>
      parseServerConfig({
        ...VALID_TESTNET_SERVER_ENV,
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      }),
    ).toThrow(/FRIENDBOT_URL/);
  });

  it("fails fast on short INTENT_HMAC_SECRET", () => {
    expect(() =>
      parseServerConfig({
        ...VALID_TESTNET_SERVER_ENV,
        INTENT_HMAC_SECRET: "too-short",
      }),
    ).toThrow(/32 characters/);
  });

  it("blocks plaintext http:// URLs and testnet passphrase when network=mainnet", () => {
    expect(() =>
      parsePwaConfig({
        ...VALID_TESTNET_PWA_ENV,
        VITE_STELLAR_NETWORK: "mainnet",
        VITE_STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
        VITE_FRIENDBOT_URL: undefined,
        VITE_API_BASE_URL: "http://localhost:8787",
      }),
    ).toThrow(/Plaintext http:\/\//i);

    expect(() =>
      parsePwaConfig({
        ...VALID_TESTNET_PWA_ENV,
        VITE_STELLAR_NETWORK: "mainnet",
        VITE_FRIENDBOT_URL: undefined,
      }),
    ).toThrow(/test network/i);

    expect(() =>
      parseServerConfig({
        ...VALID_TESTNET_SERVER_ENV,
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
        FRIENDBOT_URL: undefined,
      }),
    ).toThrow(/Plaintext http:\/\//i);

    expect(() =>
      parseServerConfig({
        ...VALID_TESTNET_SERVER_ENV,
        STELLAR_NETWORK: "testnet",
        STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      }),
    ).toThrow(/public mainnet/i);
  });

  it("parses dynamic relayer limits and Soroban max resource fee with safe defaults", () => {
    const serverCfg = parseServerConfig({
      ...VALID_TESTNET_SERVER_ENV,
      RELAY_MAX_OPERATIONS: "8",
      RELAY_MAX_FEE_STROOPS: "3500000",
      RELAY_DAILY_BUDGET_STROOPS: "900000000",
    });
    expect(serverCfg.relayMaxOperations).toBe(8);
    expect(serverCfg.relayMaxFeeStroops).toBe("3500000");
    expect(serverCfg.relayDailyBudgetStroops).toBe("900000000");

    const pwaCfg = parsePwaConfig({
      ...VALID_TESTNET_PWA_ENV,
      VITE_SOROBITS_EXPLORER_URL: "https://explorer.example.org/sorobits",
      VITE_SOROBAN_MAX_RESOURCE_FEE_STROOPS: "2500000",
    });
    expect(pwaCfg.sorobitsExplorerUrl).toBe("https://explorer.example.org/sorobits");
    expect(pwaCfg.sorobanMaxResourceFeeStroops).toBe("2500000");
    expect(pwaCfg.tonNetwork).toBe("testnet");
    expect(pwaCfg.allowDevOutsideTelegram).toBe(false);
  });

  it("parses TON & Mini App config and rejects dev bypass or http TON URLs on mainnet", () => {
    const pwaCfg = parsePwaConfig({
      ...VALID_TESTNET_PWA_ENV,
      VITE_TG_MINI_APP_SHORT_NAME: "astro",
      VITE_TON_RPC_URLS: "https://ton-rpc.example.org/jsonRPC",
      VITE_TON_BRIDGE_URL: "https://bridge.example.org/bridge",
      VITE_TON_EXPLORER_BASE_URL: "https://tonscan.example.org",
      VITE_ALLOW_DEV_OUTSIDE_TELEGRAM: "true",
    });
    expect(pwaCfg.tgMiniAppShortName).toBe("astro");
    expect(pwaCfg.tonRpcUrls).toEqual(["https://ton-rpc.example.org/jsonRPC"]);
    expect(pwaCfg.tonBridgeUrl).toBe("https://bridge.example.org/bridge");
    expect(pwaCfg.tonExplorerBaseUrl).toBe("https://tonscan.example.org");
    expect(pwaCfg.allowDevOutsideTelegram).toBe(true);

    expect(() =>
      parsePwaConfig({
        ...VALID_TESTNET_PWA_ENV,
        VITE_STELLAR_NETWORK: "mainnet",
        VITE_STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
        VITE_FRIENDBOT_URL: undefined,
        VITE_ALLOW_DEV_OUTSIDE_TELEGRAM: "true",
      }),
    ).toThrow(/VITE_ALLOW_DEV_OUTSIDE_TELEGRAM/);

    expect(() =>
      parsePwaConfig({
        ...VALID_TESTNET_PWA_ENV,
        VITE_STELLAR_NETWORK: "mainnet",
        VITE_STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
        VITE_FRIENDBOT_URL: undefined,
        VITE_TON_RPC_URLS: "http://localhost:8080",
      }),
    ).toThrow(/Plaintext http:\/\//i);

    const serverCfg = parseServerConfig({
      ...VALID_TESTNET_SERVER_ENV,
      TG_BOT_USERNAME: "@AstroWalletTestBot",
      TG_MINI_APP_SHORT_NAME: "wallet",
      REDSTONE_ORACLE_CONTRACT_ID: "CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF",
    });
    expect(serverCfg.tgBotUsername).toBe("AstroWalletTestBot");
    expect(serverCfg.tgMiniAppShortName).toBe("wallet");
    expect(serverCfg.redstoneOracleContractId).toBe(
      "CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF",
    );
  });

  it("rotates bridge contracts, anchor domain, and astrodex URL across altNetworkProfile", () => {
    const primaryCctp = "CDNG7HXAPBWICI2E3AUBP3YZWZELJLYSB6F5CC7WLDTLTHVM74SLRTHP";
    const primaryFwd = "CA66Q2WFBND6V4UEB7RD4SAXSVIWMD6RA4X3U32ELVFGXV5PJK4T4VSZ";
    const altCctp = "CAE2G5Z77UP7GYPYGFOWFGW7C7J6I4YP2AFGSADRKQY62SYUFLPNFTXL";
    const altFwd = "CBZL2IH7F6BIDAA3WBNXYKIXSATJGMSW7K5P5MJ6STX5RXN47TZJDF5T";
    const altOft = "CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6";

    const cfg = parsePwaConfig({
      ...VALID_TESTNET_PWA_ENV,
      VITE_ASTRODEX_API_BASE_URL: "https://astrodex-testnet.pages.dev",
      VITE_CCTP_TOKEN_MESSENGER_CONTRACT_ID: primaryCctp,
      VITE_CCTP_FORWARDER_CONTRACT_ID: primaryFwd,
      VITE_MONEYGRAM_ANCHOR_DOMAIN: "extstellar.moneygram.com",
      VITE_ALT_STELLAR_NETWORK: "mainnet",
      VITE_ALT_STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
      VITE_ALT_STELLAR_RPC_URLS: "https://mainnet.sorobanrpc.com",
      VITE_ALT_HORIZON_URLS: "https://horizon.stellar.org",
      VITE_ALT_ASTRODEX_API_BASE_URL: "https://astrodex.pages.dev",
      VITE_ALT_CCTP_TOKEN_MESSENGER_CONTRACT_ID: altCctp,
      VITE_ALT_CCTP_FORWARDER_CONTRACT_ID: altFwd,
      VITE_ALT_LZ_OFT_CONTRACT_ID: altOft,
      VITE_ALT_MONEYGRAM_ANCHOR_DOMAIN: "stellar.moneygram.com",
    });

    const mainnetCfg = applyPwaNetworkProfile(cfg, "mainnet");
    expect(mainnetCfg.network).toBe("mainnet");
    expect(mainnetCfg.astrodexApiBaseUrl).toBe("https://astrodex.pages.dev");
    expect(mainnetCfg.cctpTokenMessengerContractId).toBe(altCctp);
    expect(mainnetCfg.cctpForwarderContractId).toBe(altFwd);
    expect(mainnetCfg.lzOftContractId).toBe(altOft);
    expect(mainnetCfg.moneygramAnchorDomain).toBe("stellar.moneygram.com");

    const backToTestnet = applyPwaNetworkProfile(mainnetCfg, "testnet");
    expect(backToTestnet.network).toBe("testnet");
    expect(backToTestnet.astrodexApiBaseUrl).toBe("https://astrodex-testnet.pages.dev");
    expect(backToTestnet.cctpTokenMessengerContractId).toBe(primaryCctp);
    expect(backToTestnet.cctpForwarderContractId).toBe(primaryFwd);
    expect(backToTestnet.lzOftContractId).toBeUndefined();
    expect(backToTestnet.moneygramAnchorDomain).toBe("extstellar.moneygram.com");
  });

  it("defaults relayAllowDirectBootstrap to false and hard-blocks it on mainnet", () => {
    const testnetCfg = parseServerConfig(VALID_TESTNET_SERVER_ENV);
    expect(testnetCfg.relayAllowDirectBootstrap).toBe(false);

    expect(() =>
      parseServerConfig({
        ...VALID_TESTNET_SERVER_ENV,
        STELLAR_NETWORK: "mainnet",
        STELLAR_NETWORK_PASSPHRASE: "Public Global Stellar Network ; September 2015",
        FRIENDBOT_URL: undefined,
        ALLOWED_ORIGINS: "https://app.astrowallet.example",
        RELAY_ALLOW_DIRECT_BOOTSTRAP: "true",
      }),
    ).toThrow(/RELAY_ALLOW_DIRECT_BOOTSTRAP/);

    const stdCfg = parseServerConfig({
      ...VALID_TESTNET_SERVER_ENV,
      SEP10_ALLOWED_ANCHOR_DOMAINS: "https://ExtStellar.MoneyGram.com/, stellar.moneygram.com",
      ASTRODEX_BOT_USERNAME: "@AstroDexBot",
      ASTRODEX_MINI_APP_SHORT_NAME: "dex",
    });
    expect(stdCfg.sep10AllowedAnchorDomains).toEqual([
      "extstellar.moneygram.com",
      "stellar.moneygram.com",
    ]);
    expect(stdCfg.astrodexBotUsername).toBe("AstroDexBot");
    expect(stdCfg.astrodexMiniAppShortName).toBe("dex");
  });
});
