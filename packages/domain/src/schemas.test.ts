import { describe, expect, it } from "vitest";
import {
  ClassicAddressSchema,
  ContractAddressSchema,
  MuxedAddressSchema,
  calculateAccountReserveSummary,
  defaultCapabilitiesForKind,
} from "./accounts.js";
import { SignedIntentSchema, TelegramUserBindingSchema } from "./intents.js";

const SAMPLE_G = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
const SAMPLE_C = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
const SAMPLE_M = "MAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB";

describe("Stellar address & account schemas", () => {
  it("validates G..., C..., and M... addresses", () => {
    expect(ClassicAddressSchema.parse(SAMPLE_G)).toBe(SAMPLE_G);
    expect(ContractAddressSchema.parse(SAMPLE_C)).toBe(SAMPLE_C);
    expect(MuxedAddressSchema.parse(SAMPLE_M)).toBe(SAMPLE_M);
  });

  it("rejects malformed Stellar addresses", () => {
    expect(() => ClassicAddressSchema.parse("SAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")).toThrow();
    expect(() => ContractAddressSchema.parse(SAMPLE_G)).toThrow();
  });

  it("reports honest capabilities for classic vs smart accounts", () => {
    const classicCaps = defaultCapabilitiesForKind("classic");
    expect(classicCaps.canSignClassicSdex).toBe(true);
    expect(classicCaps.canReceiveRawMemo).toBe(true);
    expect(classicCaps.supportsGaslessSoroban).toBe(false);

    const smartCaps = defaultCapabilitiesForKind("smart");
    expect(smartCaps.canSignClassicSdex).toBe(false);
    expect(smartCaps.canClaimBalances).toBe(false);
    expect(smartCaps.requiresMuxedForCex).toBe(true);
    expect(smartCaps.supportsGaslessSoroban).toBe(true);
  });
});

describe("Telegram binding & signed intent schemas", () => {
  it("accepts immutable numeric telegramUserId with multi-account labels", () => {
    const binding = TelegramUserBindingSchema.parse({
      telegramUserId: "123456789",
      usernameLower: "astro_user",
      address: SAMPLE_G,
      kind: "classic",
      label: "Primary",
      isDefault: true,
    });
    expect(binding.telegramUserId).toBe("123456789");
  });

  it("validates SignedIntent payloads", () => {
    const intent = SignedIntentSchema.parse({
      intentId: "it_12345678",
      network: "testnet",
      creatorTelegramUserId: "987654321",
      actionType: "pay",
      payloadJson: '{"amount":"10","asset":"USDC"}',
      hmacSig: "a".repeat(64),
      status: "pending",
      expiresAt: 1_900_000_000,
      createdAt: 1_899_999_700,
    });
    expect(intent.actionType).toBe("pay");
  });

  it("supports reclaim_reserve intent action and calculates Stellar reserves accurately", () => {
    const intent = SignedIntentSchema.parse({
      intentId: "it_reserve_01",
      network: "testnet",
      creatorTelegramUserId: "987654321",
      actionType: "reclaim_reserve",
      payloadJson: '{"reclaimableXlm":"1.0"}',
      hmacSig: "b".repeat(64),
      status: "pending",
      expiresAt: 1_900_000_000,
      createdAt: 1_899_999_700,
    });
    expect(intent.actionType).toBe("reclaim_reserve");

    const summary = calculateAccountReserveSummary({
      nativeBalanceXlm: "25.5000000",
      subentryCount: 4,
      numSponsoring: 2,
      numSponsored: 1,
      sellingLiabilitiesXlm: "1.5000000",
      balances: [
        { assetCode: "XLM", balance: "25.5000000" },
        { assetCode: "USDC", assetIssuer: SAMPLE_G, balance: "12.0000000" },
        { assetCode: "ZERO1", assetIssuer: SAMPLE_G, balance: "0.0000000" },
        { assetCode: "ZERO2", assetIssuer: SAMPLE_G, balance: "0" },
      ],
    });

    // effectiveEntries = 2 + 4 + 2 - 1 = 7 -> 3.5 XLM reserve
    expect(summary.effectiveEntries).toBe(7);
    expect(summary.minReserveXlm).toBe("3.5");
    // spendable = 25.5 - 3.5 - 1.5 = 20.5000000
    expect(summary.spendableXlm).toBe("20.5000000");
    expect(summary.reclaimableTrustlines).toHaveLength(2);
    expect(summary.reclaimableXlm).toBe("1.0");

    const exactBigIntSummary = calculateAccountReserveSummary({
      nativeBalanceXlm: "100000000.0000001",
      subentryCount: 5,
      sellingLiabilitiesXlm: "0.0000001",
      balances: [
        { assetCode: "XLM", balance: "100000000.0000001" },
        { assetCode: "BAD", assetIssuer: SAMPLE_G, balance: "not-a-number" },
      ],
    });
    expect(exactBigIntSummary.minReserveXlm).toBe("3.5");
    expect(exactBigIntSummary.spendableXlm).toBe("99999996.5000000");
    expect(exactBigIntSummary.reclaimableTrustlines).toHaveLength(0);
  });
});
