import { describe, expect, it, vi } from "vitest";
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

  it("wires signAuthEntry via AstroConnect v1 sign_auth_entry flow", async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
      if (String(url).endsWith("/v1/connect/requests") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { action: string; payload: { authEntryXdr: string } };
        expect(body.action).toBe("sign_auth_entry");
        expect(body.payload.authEntryXdr).toBe("AAAAAQAAAAAAAAAAAAAAAA==");
        return new Response(
          JSON.stringify({
            requestId: "ac_auth1",
            network: "testnet",
            action: "sign_auth_entry",
            trustTier: "external",
            sig: "0".repeat(32),
            resultToken: "tok_123",
            expiresAt: 9_999_999_999,
            deepLink: "https://t.me/AstroWalletAppBot/wallet?startapp=c-ac_auth1",
          }),
          { status: 201 },
        );
      }
      return new Response(
        JSON.stringify({
          ok: true,
          requestId: "ac_auth1",
          network: "testnet",
          action: "sign_auth_entry",
          status: "approved",
          trustTier: "external",
          expiresAt: 9_999_999_999,
          result: {
            status: "approved",
            address: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            signedAuthEntry: "SIGNED_AUTH_BASE64",
            completedAt: 1_700_000_000,
          },
        }),
        { status: 200 },
      );
    });

    const mod = createAstroWalletKitModule({
      apiBaseUrl: "https://astrowallet-soroban.pages.dev",
      app: { name: "x402 Agent", botUsername: "AgentBot" },
      fetchFn: fetchMock,
      openLinkFn: vi.fn(),
    });
    const res = await mod.signAuthEntry?.("AAAAAQAAAAAAAAAAAAAAAA==", {
      humanSummary: "Authorize x402 USDC spend",
    });
    expect(res?.signedAuthEntry).toBe("SIGNED_AUTH_BASE64");
    expect(res?.signerAddress).toBe("GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF");
  });
});
