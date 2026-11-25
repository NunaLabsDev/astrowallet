import { TransactionBuilder, nativeToScVal, type xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { fetchSep50Holdings, parseSep50TokenUri } from "./sep50/index.js";

const SAMPLE_CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

describe("SEP-50 Soroban NFT token_uri parser", () => {
  it("parses Sorobits data:application/json;utf8 payloads with inline SVG artwork and traits", () => {
    const uri =
      'data:application/json;utf8,{"name":"Sorobit #42","description":"Genesis Navigator","image":"data:image/svg+xml;utf8,<svg xmlns=\\"http://www.w3.org/2000/svg\\"><rect/></svg>","attributes":[{"trait_type":"Tier","value":"Gold"},{"trait_type":"Soulbound","value":"false"}]}';

    const parsed = parseSep50TokenUri(SAMPLE_CONTRACT, 42, uri);
    expect(parsed.tokenId).toBe(42);
    expect(parsed.name).toBe("Sorobit #42");
    expect(parsed.description).toBe("Genesis Navigator");
    expect(parsed.image).toMatch(/^data:image\/svg\+xml;utf8,/);
    expect(parsed.traits).toEqual([
      { traitType: "Tier", value: "Gold" },
      { traitType: "Soulbound", value: "false" },
    ]);
    expect(parsed.soulbound).toBe(false);
  });

  it("parses base64 data URIs and rejects inline SVG payloads containing <script>", () => {
    const json = JSON.stringify({
      name: "Malicious Art",
      image: 'data:image/svg+xml;utf8,<svg><script>alert(1)</script></svg>',
      attributes: [{ trait_type: "Soulbound", value: true }],
    });
    const uri = `data:application/json;base64,${Buffer.from(json, "utf8").toString("base64")}`;
    const parsed = parseSep50TokenUri(SAMPLE_CONTRACT, 7, uri);
    expect(parsed.name).toBe("Malicious Art");
    expect(parsed.image).toBeUndefined();
    expect(parsed.soulbound).toBe(true);
  });

  it("normalizes ipfs:// off-chain metadata URIs cleanly", () => {
    const parsed = parseSep50TokenUri(SAMPLE_CONTRACT, 9, "ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/9.json");
    expect(parsed.name).toBe("Token #9");
    expect(parsed.metadataUrl).toBe(
      "https://ipfs.io/ipfs/bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi/9.json",
    );
  });

  it("rejects base64 SVG data URIs containing <script> or inline event handlers", () => {
    const evilSvg = Buffer.from('<svg onload="alert(1)"><circle/></svg>', "utf8").toString("base64");
    const json = JSON.stringify({
      name: "Event Handler Attack",
      image: `data:image/svg+xml;base64,${evilSvg}`,
    });
    const parsed = parseSep50TokenUri(SAMPLE_CONTRACT, 10, json);
    expect(parsed.name).toBe("Event Handler Attack");
    expect(parsed.image).toBeUndefined();
  });

  it("blocks SVG XSS vectors (<foreignObject>, numeric entities, external xlink:href, data:text/html) while allowing internal #id refs", () => {
    const vectors = [
      '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div>xss</div></foreignObject></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="&#x6a;avascript:alert(1)"><rect/></a></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><image xlink:href="https://evil.com/track.png"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><a href="data:text/html,<script>alert(1)</script>"><rect/></a></svg>',
    ];
    for (const svg of vectors) {
      const b64 = Buffer.from(svg, "utf8").toString("base64");
      const parsed = parseSep50TokenUri(
        SAMPLE_CONTRACT,
        11,
        JSON.stringify({ name: "Evil", image: `data:image/svg+xml;base64,${b64}` }),
      );
      expect(parsed.image).toBeUndefined();
    }

    const safeSvg =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="grad1"/></defs><rect fill="url(#grad1)"/></svg>';
    const safeB64 = Buffer.from(safeSvg, "utf8").toString("base64");
    const safeParsed = parseSep50TokenUri(
      SAMPLE_CONTRACT,
      12,
      JSON.stringify({ name: "Safe Gradient", image: `data:image/svg+xml;base64,${safeB64}` }),
    );
    expect(safeParsed.image).toMatch(/^data:image\/svg\+xml;base64,/);
  });

  it("routes off-chain SEP-50 metadata hydration through /v1/proxy/sep50-meta with X-Astro-Network when apiBaseUrl is provided", async () => {
    const requestedUrls: string[] = [];
    const seenNetworkHeaders: Array<string | null> = [];
    const owner = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const passphrase = "Public Global Stellar Network ; September 2015";

    const rpcSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url =
        typeof input === "string" ? input : input instanceof Request ? input.url : String(input);
      requestedUrls.push(url);
      if (url.startsWith("https://rpc.example.org")) {
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
          const tx = TransactionBuilder.fromXDR(body.params.transaction, passphrase);
          const op = tx.operations[0] as unknown as { func?: xdr.HostFunction };
          const fnName = op?.func?.invokeContract?.functionName?.toString();
          let retval: xdr.ScVal = nativeToScVal(null, { type: "void" });
          if (fnName === "balance") retval = nativeToScVal(1, { type: "u32" });
          else if (fnName === "name") retval = nativeToScVal("Sorobits", { type: "string" });
          else if (fnName === "symbol") retval = nativeToScVal("SBIT", { type: "string" });
          else if (fnName === "get_owner_token_id") retval = nativeToScVal(7, { type: "u32" });
          else if (fnName === "token_uri") {
            retval = nativeToScVal("https://pinata.example.com/ipfs/QmTest/7.json", {
              type: "string",
            });
          }
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { latestLedger: 99, results: [{ xdr: retval.toXDR("base64") }] },
            }),
            { status: 200 },
          );
        }
      }
      return new Response("Not Found", { status: 404 });
    });

    const customFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      requestedUrls.push(url);
      const hdrs = new Headers(init?.headers);
      seenNetworkHeaders.push(hdrs.get("X-Astro-Network"));
      if (
        url ===
        `https://api.astrowallet.example/v1/proxy/sep50-meta?url=${encodeURIComponent("https://pinata.example.com/ipfs/QmTest/7.json")}`
      ) {
        return new Response(
          JSON.stringify({
            name: "Sorobit #7",
            description: "Hydrated via Worker Proxy",
            image: "https://pinata.example.com/ipfs/QmTest/7.png",
            attributes: [{ trait_type: "Soulbound", value: "true" }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("Unexpected direct fetch", { status: 500 });
    };

    try {
      const snap = await fetchSep50Holdings({
        contractId: SAMPLE_CONTRACT,
        ownerAddress: owner,
        rpcUrls: ["https://rpc.example.org"],
        networkPassphrase: passphrase,
        apiBaseUrl: "https://api.astrowallet.example",
        network: "mainnet",
        fetchFn: customFetch,
      });

      expect(snap.totalOwned).toBe(1);
      expect(snap.items[0]?.name).toBe("Sorobit #7");
      expect(snap.items[0]?.description).toBe("Hydrated via Worker Proxy");
      expect(snap.items[0]?.image).toBe("https://pinata.example.com/ipfs/QmTest/7.png");
      expect(snap.items[0]?.soulbound).toBe(true);
      expect(seenNetworkHeaders).toEqual(["mainnet"]);
      expect(requestedUrls.some((u) => u.startsWith("https://pinata.example.com"))).toBe(false);
    } finally {
      rpcSpy.mockRestore();
    }
  });
});
