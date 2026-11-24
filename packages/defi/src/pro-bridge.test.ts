import { StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  buildCctpForwarderHookData,
  buildLayerZeroMessagingFeeScVal,
  buildLayerZeroSendParamScVal,
  buildSep40AssetScVal,
  contractStrkeyToBytes32Hex,
  evmAddressToBytes32,
  formatSep40FixedPrice,
  parseSep40PriceDataScVal,
} from "./index.js";

describe("SEP-40 Oracle ScVal helpers & Pro Bridge builders (CCTP V2 + LayerZero V2 OFT)", () => {
  it("encodes SEP-40 Asset::Stellar and Asset::Other and decodes PriceData safely", () => {
    const contractId = StrKey.encodeContract(new Uint8Array(32).fill(7));
    const stellarAsset = buildSep40AssetScVal({ kind: "stellar", contractId });
    expect((stellarAsset as { type: string }).type).toBe("scvVec");
    expect(scValToNative(stellarAsset)).toEqual(["Stellar", contractId]);

    const otherAsset = buildSep40AssetScVal({ kind: "other", symbol: "XLM" });
    expect((otherAsset as { type: string }).type).toBe("scvVec");
    expect(scValToNative(otherAsset)).toEqual(["Other", "XLM"]);

    const formatted = formatSep40FixedPrice(1234567890123n, 14);
    expect(formatted).toBe("0.01234567890123");

    const priceDataScVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("price"),
        val: nativeToScVal(150000000000000n, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("timestamp"),
        val: nativeToScVal(1760000000n, { type: "u64" }),
      }),
    ]);
    const decoded = parseSep40PriceDataScVal(priceDataScVal, 14);
    expect(decoded).not.toBeNull();
    expect(decoded?.priceUsd).toBeCloseTo(1.5, 6);
    expect(decoded?.timestamp).toBe(1760000000);

    expect(parseSep40PriceDataScVal(xdr.ScVal.scvVoid(), 14)).toBeNull();
  });

  it("builds exact Circle CCTP V2 CctpForwarder hook data with BE u32 offsets", () => {
    const recipient = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(9));
    const { hex, bytes } = buildCctpForwarderHookData(recipient);
    expect(hex.startsWith("0x")).toBe(true);
    expect(bytes.length).toBe(32 + 56);
    // Bytes 0..23 zero magic
    for (let i = 0; i < 24; i += 1) {
      expect(bytes[i]).toBe(0);
    }
    const view = new DataView(bytes.buffer);
    expect(view.getUint32(24, false)).toBe(0); // version = 0 BE
    expect(view.getUint32(28, false)).toBe(56); // strkey length = 56 BE
    expect(new TextDecoder().decode(bytes.slice(32))).toBe(recipient);

    const fwd = StrKey.encodeContract(new Uint8Array(32).fill(5));
    const fwdHex = contractStrkeyToBytes32Hex(fwd);
    expect(fwdHex).toBe(`0x${"05".repeat(32)}`);

    const evm = evmAddressToBytes32("0xAbCd12340000000000000000000000000000fFeE");
    expect(evm.length).toBe(32);
    expect(evm.slice(0, 12)).toEqual(new Uint8Array(12));
    expect(evm[12]).toBe(0xab);
    expect(evm[31]).toBe(0xee);
  });

  it("encodes LayerZero V2 SendParam and MessagingFee in alphabetical Soroban ScMap order", () => {
    const to = evmAddressToBytes32("0x1111111111111111111111111111111111111111");
    const paramScVal = buildLayerZeroSendParamScVal({
      dstEid: 30101,
      toBytes32: to,
      amountLdStroops7: 10_000_000n,
      minAmountLdStroops7: 9_950_000n,
    });
    const paramNative = scValToNative(paramScVal) as Record<string, unknown>;
    expect(Object.keys(paramNative)).toEqual([
      "amount_ld",
      "compose_msg",
      "dst_eid",
      "extra_options",
      "min_amount_ld",
      "oft_cmd",
      "to",
    ]);

    const feeScVal = buildLayerZeroMessagingFeeScVal({
      nativeFeeStroops: 2_500_000n,
      zroFee: 0n,
    });
    const nativeFee = scValToNative(feeScVal) as { native_fee: bigint; zro_fee: bigint };
    expect(nativeFee.native_fee).toBe(2_500_000n);
    expect(nativeFee.zro_fee).toBe(0n);
  });
});
