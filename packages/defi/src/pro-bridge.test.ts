import { Asset, Networks, StrKey, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import {
  buildCctpDepositForBurnXdr,
  buildCctpForwarderHookData,
  buildLayerZeroMessagingFeeScVal,
  buildLayerZeroSendParamScVal,
  buildSep40AssetScVal,
  contractStrkeyToBytes32Hex,
  evmAddressToBytes32,
  fetchSep40OraclePrices,
  formatSep40FixedPrice,
  parseSep40PriceDataScVal,
  quoteLayerZeroOftBridge,
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

  it("normalizes SEP-40 Asset::Other to uppercase, rejects future timestamps, and validates CCTP maxFee & LZ OFT errors", async () => {
    const lowerAsset = buildSep40AssetScVal({ kind: "other", symbol: "btc" });
    expect(scValToNative(lowerAsset)).toEqual(["Other", "BTC"]);

    const mixedCaseAsset = buildSep40AssetScVal({ kind: "other", symbol: "earnUSDC_PPS" });
    expect(scValToNative(mixedCaseAsset)).toEqual(["Other", "earnUSDC_PPS"]);

    const futurePrice = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("price"),
        val: nativeToScVal(100_000_000n, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("timestamp"),
        val: nativeToScVal(2_000_000_000n, { type: "u64" }),
      }),
    ]);
    expect(
      parseSep40PriceDataScVal(futurePrice, 8, { nowSec: 1_760_000_000, maxStalenessSec: 3600 }),
    ).toBeNull();

    const validPrice = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("price"),
        val: nativeToScVal(100_000_000n, { type: "i128" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("timestamp"),
        val: nativeToScVal(1_759_990_000n, { type: "u64" }),
      }),
    ]);
    const staleDecoded = parseSep40PriceDataScVal(validPrice, 8, {
      nowSec: 1_760_000_000,
      maxStalenessSec: 3600,
    });
    expect(staleDecoded?.ageSec).toBe(10_000);
    expect(staleDecoded?.stale).toBe(true);

    const caller = StrKey.encodeEd25519PublicKey(new Uint8Array(32).fill(1));
    const sac = StrKey.encodeContract(new Uint8Array(32).fill(2));
    const tmm = StrKey.encodeContract(new Uint8Array(32).fill(3));
    const to = new Uint8Array(32).fill(4);
    await expect(
      buildCctpDepositForBurnXdr({
        from: caller as `G${string}`,
        usdcSacContractId: sac as `C${string}`,
        tokenMessengerMinterContractId: tmm as `C${string}`,
        destinationDomain: 6,
        mintRecipientBytes32: to,
        amountStroops7: 100_000n,
        maxFeeStroops7: 100_000n,
        rpcUrls: ["https://rpc-test.example"],
        networkPassphrase: "Test SDF Network ; September 2015",
      }),
    ).rejects.toThrow(/exceed maxFee/i);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as { id?: number; method?: string };
      if (body.method === "getAccount") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { id: caller, sequence: "1" },
          }),
          { status: 200 },
        );
      }
      if (body.method === "simulateTransaction") {
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              error: "HostError: Error(Contract, #0): Function peer does not exist",
            },
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    try {
      await expect(
        quoteLayerZeroOftBridge({
          oftContractId: sac as `C${string}`,
          from: caller,
          dstEid: 30110,
          toBytes32: to,
          amountLdStroops7: 10_000_000n,
          rpcUrls: ["https://rpc-test.example"],
          networkPassphrase: "Test SDF Network ; September 2015",
        }),
      ).rejects.toThrow(/not a valid LayerZero V2 OFT deployment/i);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("auto-resolves canonical Mainnet Asset::Stellar SACs in fetchSep40OraclePrices and preserves mixed-case Asset::Other", async () => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const oracleId = StrKey.encodeContract(new Uint8Array(32).fill(11)) as `C${string}`;
    const expectedXlmSac = Asset.native().contractId(Networks.PUBLIC);
    const expectedUsdcSac = new Asset(
      "USDC",
      "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    ).contractId(Networks.PUBLIC);
    const seenArgs: Array<{ kind: string; id: string }> = [];
    const now = Math.floor(Date.now() / 1000);

    const rpcSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const rawBody = init?.body
        ? String(init.body)
        : input instanceof Request
          ? await input.clone().text()
          : "{}";
      const body = JSON.parse(rawBody) as {
        id?: number;
        method?: string;
        params?: { transaction?: string };
      };
      if (body.method === "simulateTransaction" && body.params?.transaction) {
        const tx = TransactionBuilder.fromXDR(body.params.transaction, Networks.PUBLIC);
        const op = tx.operations[0] as unknown as {
          func?: {
            invokeContract?: { functionName?: { toString(): string }; args?: xdr.ScVal[] };
          };
        };
        const invoke = op.func?.invokeContract;
        const fn = invoke?.functionName?.toString();
        if (fn === "decimals") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { latestLedger: 1000, results: [{ xdr: nativeToScVal(8, { type: "u32" }).toXDR("base64") }] },
            }),
            { status: 200 },
          );
        }
        if (fn === "lastprice") {
          const desc = scValToNative(invoke!.args![0]!) as [string, string];
          seenArgs.push({ kind: desc[0], id: desc[1] });
          const matched =
            (desc[0] === "Stellar" && (desc[1] === expectedXlmSac || desc[1] === expectedUsdcSac)) ||
            (desc[0] === "Other" && desc[1] === "earnUSDC_PPS");
          const retval = matched
            ? xdr.ScVal.scvMap([
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("price"),
                  val: nativeToScVal(desc[1] === "earnUSDC_PPS" ? 102_000_000n : 50_000_000n, {
                    type: "i128",
                  }),
                }),
                new xdr.ScMapEntry({
                  key: xdr.ScVal.scvSymbol("timestamp"),
                  val: nativeToScVal(BigInt(now - 20), { type: "u64" }),
                }),
              ])
            : xdr.ScVal.scvVoid();
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { latestLedger: 1001, results: [{ xdr: retval.toXDR("base64") }] },
            }),
            { status: 200 },
          );
        }
      }
      return new Response("{}", { status: 404 });
    });

    try {
      const snap = await fetchSep40OraclePrices({
        oracleContractId: oracleId,
        rpcUrls: ["https://rpc-test.example"],
        networkPassphrase: Networks.PUBLIC,
        assets: [
          { key: "XLM", symbol: "XLM" },
          { key: "USDC", symbol: "USDC" },
          { key: "earnUSDC_PPS", symbol: "earnUSDC_PPS" },
        ],
      });
      expect(snap.prices.XLM?.sourceKind).toBe("stellar");
      expect(snap.prices.USDC?.sourceKind).toBe("stellar");
      expect(snap.prices.earnUSDC_PPS?.sourceKind).toBe("other");
      expect(snap.prices.earnUSDC_PPS?.priceUsd).toBeCloseTo(1.02, 4);
      expect(seenArgs).toContainEqual({ kind: "Stellar", id: expectedXlmSac });
      expect(seenArgs).toContainEqual({ kind: "Stellar", id: expectedUsdcSac });
      expect(seenArgs).toContainEqual({ kind: "Other", id: "earnUSDC_PPS" });
    } finally {
      rpcSpy.mockRestore();
    }
  });
});
