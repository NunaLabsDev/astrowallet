import { describe, expect, it } from "vitest";
import {
  computeLayerZeroOftSharedAmount,
  createNearIntentsQuoteAdapter,
  createSep24AnchorRampAdapter,
  encodeLayerZeroRecipientBytes32,
} from "./ramps.js";

describe("Ramps (MoneyGram SEP-24, NEAR Intents MEMO Guard, LayerZero OFT)", () => {
  it("builds a valid SEP-24 interactive withdraw URL for MoneyGram", async () => {
    const adapter = createSep24AnchorRampAdapter({
      anchorDomain: "extstellar.moneygram.com",
      assetCode: "USDC",
    });
    const { url } = await adapter.createSessionUrl({
      direction: "offramp",
      fiatCurrency: "USD",
      assetCode: "USDC",
      amount: "50.00",
      destinationAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
    });
    expect(url).toContain("https://extstellar.moneygram.com/sep24/transactions/withdraw/webapp");
    expect(url).toContain("asset_code=USDC");
    expect(url).toContain("amount=50.00");
  });

  it("enforces depositMode=MEMO on Stellar-origin NEAR Intents quotes and rejects missing memo", async () => {
    let capturedBody: Record<string, unknown> | null = null;
    const adapter = createNearIntentsQuoteAdapter({
      fetchFn: async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
        return new Response(
          JSON.stringify({
            quote: {
              depositAddress: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
              // depositMemo intentionally omitted
            },
          }),
          { status: 200 },
        );
      },
    });

    await expect(
      adapter.requestQuote({
        originAsset: "stellar:usdc",
        destinationAsset: "nep141:btc.omft.near",
        amountAtomic: "10000000",
        recipient: "bc1qexample",
        refundTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      }),
    ).rejects.toThrow(/depositMemo/i);
    expect(capturedBody?.depositMode).toBe("MEMO");
  });

  it("encodes G... and C... strkeys to 32-byte LayerZero bytes32 and computes 6d shared amount", () => {
    const b32 = encodeLayerZeroRecipientBytes32(
      "CCNOV6XVI2O5BSTA3232GIRUQULDEBV7IWGKM6QKI6II5OIIQTU24JJN",
    );
    expect(b32).toMatch(/^0x[0-9a-f]{64}$/);
    expect(() => encodeLayerZeroRecipientBytes32("MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF")).toThrow();

    const oft = computeLayerZeroOftSharedAmount("1.0000005");
    expect(oft.sharedUnits6).toBe(1_000_000n);
    expect(oft.dustStroops).toBe(5n);
    expect(oft.sendableFormatted).toBe("1.0000000");
  });
});
