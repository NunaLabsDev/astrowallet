import { describe, expect, it } from "vitest";
import { parsePwaConfig, parseServerConfig } from "./config.js";

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
  it("parses valid testnet server configuration", () => {
    const config = parseServerConfig(VALID_TESTNET_SERVER_ENV);
    expect(config.network).toBe("testnet");
    expect(config.allowedOrigins).toEqual([
      "https://testnet.astrowallet.example",
      "http://localhost:5173",
    ]);
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
});
