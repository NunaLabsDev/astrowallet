import { describe, expect, it } from "vitest";
import { assertFriendbotAllowed, createFailoverEndpoints } from "./network.js";

describe("assertFriendbotAllowed", () => {
  it("returns friendbot URL on testnet", () => {
    expect(
      assertFriendbotAllowed({
        network: "testnet",
        friendbotUrl: "https://friendbot.stellar.org",
      }),
    ).toBe("https://friendbot.stellar.org");
  });

  it("throws fatally on mainnet even if friendbotUrl is supplied", () => {
    expect(() =>
      assertFriendbotAllowed({
        network: "mainnet",
        friendbotUrl: "https://friendbot.stellar.org",
      }),
    ).toThrow(/strictly forbidden/);
  });

  it("throws on testnet when friendbotUrl is unset", () => {
    expect(() =>
      assertFriendbotAllowed({
        network: "testnet",
        friendbotUrl: undefined,
      }),
    ).toThrow(/not configured/);
  });
});

describe("createFailoverEndpoints", () => {
  it("rotates and resets cleanly across ordered endpoints", () => {
    const endpoints = createFailoverEndpoints([
      "https://rpc-1.example.org",
      "https://rpc-2.example.org",
    ]);
    expect(endpoints.current()).toBe("https://rpc-1.example.org");
    expect(endpoints.next()).toBe("https://rpc-2.example.org");
    expect(endpoints.next()).toBe("https://rpc-1.example.org");
    endpoints.next();
    endpoints.reset();
    expect(endpoints.current()).toBe("https://rpc-1.example.org");
  });
});
