import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import { Keypair, Networks, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it } from "vitest";
import {
  fetchOwnerSorobits,
  fetchSorobitShowcase,
  parseSorobitTokenUriJson,
  sanitizeOnChainSvg,
} from "./index.js";

const SAMPLE_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM" as ContractAddress;

function scValB64(val: xdr.ScVal): string {
  return val.toXDR("base64");
}

describe("Sorobits SEP-50 on-chain collectible reader", () => {
  it("parses token_uri JSON and sanitizes on-chain SVG markup", () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#172C69'/></svg>";
    const uri = `data:application/json;utf8,${JSON.stringify({
      name: "Sorobit #0 · AGQ01 First Star",
      attributes: [
        { trait_type: "Faction", value: "Roscoe Violet" },
        { trait_type: "XP", value: 450 },
      ],
      image: `data:image/svg+xml;utf8,${svg}`,
    })}`;

    const parsed = parseSorobitTokenUriJson(uri);
    expect(parsed.name).toBe("Sorobit #0 · AGQ01 First Star");
    expect(parsed.attributes).toHaveLength(2);
    expect(parsed.svgMarkup).toContain("<svg");

    expect(() =>
      sanitizeOnChainSvg("<svg><script>alert(1)</script></svg>"),
    ).toThrow(/Disallowed SVG tag/i);
    expect(() =>
      sanitizeOnChainSvg("<svg onload='alert(1)'></svg>"),
    ).toThrow(/Unsafe/i);
    expect(() =>
      sanitizeOnChainSvg("<svg><foreignObject><body>xss</body></foreignObject></svg>"),
    ).toThrow(/Disallowed SVG tag/i);
    expect(() =>
      sanitizeOnChainSvg("<svg><use href='#x'/></svg>"),
    ).toThrow(/Disallowed SVG tag/i);
    expect(() =>
      sanitizeOnChainSvg("<svg><animate attributeName='d'/></svg>"),
    ).toThrow(/Disallowed SVG tag/i);
    expect(() =>
      sanitizeOnChainSvg("<svg fill='&#x6a;avascript:alert(1)'></svg>"),
    ).toThrow(/numeric character entities/i);
  });

  it("queries owned Sorobits via Soroban RPC with primary->secondary failover", async () => {
    const owner = Keypair.random().publicKey() as ClassicAddress;
    const svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#8050C8'/></svg>";
    const uri = `data:application/json;utf8,${JSON.stringify({
      name: "Sorobit #7",
      attributes: [{ trait_type: "Faction", value: "Golden Soroban" }],
      image: `data:image/svg+xml;utf8,${svg}`,
    })}`;

    const recordVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("edition"),
        val: nativeToScVal(1, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("generation"),
        val: nativeToScVal(0, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("rank_tier"),
        val: nativeToScVal(2, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("xp_score"),
        val: nativeToScVal(620, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("born_ledger"),
        val: nativeToScVal(90123, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("soulbound"),
        val: nativeToScVal(true, { type: "bool" }),
      }),
    ]);

    const calls: string[] = [];
    const result = await fetchOwnerSorobits({
      rpcUrls: ["https://rpc-1.example.org", "https://rpc-2.example.org"],
      networkPassphrase: Networks.TESTNET,
      contractId: SAMPLE_CONTRACT,
      ownerAddress: owner,
      fetchFn: async (url, init) => {
        const u = String(url);
        calls.push(u);
        if (u.includes("rpc-1")) {
          return new Response("Unavailable", { status: 503 });
        }
        const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
          params?: { transaction?: string };
        };
        const envelope = xdr.TransactionEnvelope.fromXDR(
          reqBody.params?.transaction ?? "",
          "base64",
        );
        const invokeOp = envelope.value.tx.operations[0]?.body;
        const fnName =
          invokeOp?.type === "invokeHostFunction" &&
          invokeOp.value.hostFunction.type === "hostFunctionTypeInvokeContract"
            ? invokeOp.value.hostFunction.value.functionName.toString()
            : "";

        let returnVal: xdr.ScVal;
        if (fnName === "tokens_of") {
          returnVal = xdr.ScVal.scvVec([nativeToScVal(7, { type: "u32" })]);
        } else if (fnName === "get_sorobit") {
          returnVal = recordVal;
        } else if (fnName === "token_uri") {
          returnVal = nativeToScVal(uri, { type: "string" });
        } else {
          returnVal = nativeToScVal(svg, { type: "string" });
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { results: [{ xdr: scValB64(returnVal) }] },
          }),
          { status: 200 },
        );
      },
    });

    expect(calls.some((u) => u.includes("rpc-1"))).toBe(true);
    expect(result.owned).toHaveLength(1);
    expect(result.owned[0]?.tokenId).toBe(7);
    expect(result.owned[0]?.realmName).toBe("Golden Soroban");
    expect(result.owned[0]?.xpScore).toBe(620);
    expect(result.owned[0]?.animatedDataUrl.startsWith("data:image/svg+xml;utf8,")).toBe(true);
  });

  it("fetches public Sorobits showcase collection via total_supply and token metadata", async () => {
    const svg =
      "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' fill='#172C69'/></svg>";

    const recordVal = xdr.ScVal.scvMap([
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("edition"),
        val: nativeToScVal(1, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("generation"),
        val: nativeToScVal(0, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("rank_tier"),
        val: nativeToScVal(1, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("xp_score"),
        val: nativeToScVal(120, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("born_ledger"),
        val: nativeToScVal(5787216, { type: "u32" }),
      }),
      new xdr.ScMapEntry({
        key: xdr.ScVal.scvSymbol("soulbound"),
        val: nativeToScVal(true, { type: "bool" }),
      }),
    ]);

    const showcase = await fetchSorobitShowcase({
      rpcUrls: ["https://rpc-showcase.example.org"],
      networkPassphrase: Networks.TESTNET,
      contractId: SAMPLE_CONTRACT,
      maxTokens: 2,
      fetchFn: async (_url, init) => {
        const reqBody = JSON.parse(String(init?.body ?? "{}")) as {
          params?: { transaction?: string };
        };
        const envelope = xdr.TransactionEnvelope.fromXDR(
          reqBody.params?.transaction ?? "",
          "base64",
        );
        const invokeOp = envelope.value.tx.operations[0]?.body;
        const fnName =
          invokeOp?.type === "invokeHostFunction" &&
          invokeOp.value.hostFunction.type === "hostFunctionTypeInvokeContract"
            ? invokeOp.value.hostFunction.value.functionName.toString()
            : "";

        let returnVal: xdr.ScVal;
        if (fnName === "total_supply") {
          returnVal = nativeToScVal(3, { type: "u32" });
        } else if (fnName === "get_sorobit") {
          returnVal = recordVal;
        } else if (fnName === "token_uri") {
          const uri = `data:application/json;utf8,${JSON.stringify({
            name: "Sorobit #0 · AGQ01 Pioneer",
            attributes: [{ trait_type: "Faction", value: "Horizon Signal" }],
            image: `data:image/svg+xml;utf8,${svg}`,
          })}`;
          returnVal = nativeToScVal(uri, { type: "string" });
        } else {
          returnVal = nativeToScVal(svg, { type: "string" });
        }

        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            result: { results: [{ xdr: scValB64(returnVal) }] },
          }),
          { status: 200 },
        );
      },
    });

    expect(showcase.totalSupply).toBe(3);
    expect(showcase.tokens).toHaveLength(2);
    expect(showcase.tokens[0]?.name).toBe("Sorobit #0 · AGQ01 Pioneer");
    expect(showcase.tokens[0]?.realmName).toBe("Horizon Signal");
    expect(showcase.tokens[0]?.bornLedger).toBe(5787216);
    expect(showcase.tokens[0]?.animatedDataUrl.startsWith("data:image/svg+xml;utf8,")).toBe(true);
  });

  it("propagates Soroban RPC failure in fetchSorobitShowcase instead of returning fake supply", async () => {
    await expect(
      fetchSorobitShowcase({
        rpcUrls: ["https://rpc-down.example.org"],
        networkPassphrase: Networks.TESTNET,
        contractId: SAMPLE_CONTRACT,
        fetchFn: async () => new Response("Down", { status: 503 }),
      }),
    ).rejects.toThrow();
  });
});
