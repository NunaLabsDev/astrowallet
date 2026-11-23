import { describe, expect, it } from "vitest";
import { createAstroWalletKitModule } from "./stellar-wallets-kit.js";

describe("AstroWallet StellarWalletsKit & SEP-60 Adapter", () => {
  it("exposes SEP-60 provider metadata and x402 capabilities", () => {
    const mod = createAstroWalletKitModule({
      apiBaseUrl: "https://astrowallet-soroban.pages.dev",
      app: { name: "TestApp", botUsername: "TestAppBot" },
    });
    const meta = mod.getProviderMetadata?.();
    expect(meta?.id).toBe("astrowallet");
    expect(meta?.standards).toContain("SEP-60-draft");
    expect(meta?.capabilities).toContain("x402_auth_entry");
  });
});
