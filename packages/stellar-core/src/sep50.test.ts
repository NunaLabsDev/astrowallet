import { Keypair, TransactionBuilder, nativeToScVal, xdr } from "@stellar/stellar-sdk";
import { describe, expect, it, vi } from "vitest";
import { buildSep50TransferXdr, fetchSep50Holdings, parseSep50TokenUri } from "./sep50/index.js";

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
      '<svg xmlns="http://www.w3.org/2000/svg"><script/xlink:href="https://evil.com/x.js"/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><style>@import url("https://evil.com/a.css");</style><rect/></svg>',
      '<svg xmlns="http://www.w3.org/2000/svg"><use href="https://evil.com/defs.svg#icon"/></svg>',
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

    // Reject UTF-16 BOM base64 SVG smuggling
    const utf16BomSvg = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("<svg><script>alert(1)</script></svg>", "utf16le"),
    ]).toString("base64");
    const bomParsed = parseSep50TokenUri(
      SAMPLE_CONTRACT,
      11,
      JSON.stringify({ name: "BOM Evil", image: `data:image/svg+xml;base64,${utf16BomSvg}` }),
    );
    expect(bomParsed.image).toBeUndefined();

    // Reject private/local https image URLs
    const localImgParsed = parseSep50TokenUri(
      SAMPLE_CONTRACT,
      11,
      JSON.stringify({ name: "Local SSRF", image: "https://127.0.0.1/evil.png" }),
    );
    expect(localImgParsed.image).toBeUndefined();

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

  it("enriches Sorobits soulbound flag via get_sorobit(token_id) and maps #302 transfer errors", async () => {
    const owner = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
    const dest = "GDQJTJJ2ZABBNEAJ2CF6EQB6ATR2P2J3336TWQG57SE3QMKB3DRKAP2J";
    const passphrase = "Test SDF Network ; September 2015";
    const safeSvg = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg'></svg>";

    const rpcSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const rawBody = init?.body
        ? String(init.body)
        : input instanceof Request
          ? await input.clone().text()
          : "{}";
      const body = JSON.parse(rawBody) as {
        id?: number;
        method?: string;
        params?: { transaction?: string; keys?: string[] };
      };
      if (body.method === "getLedgerEntries") {
        const accountXdr = xdr.LedgerEntryData.account(
          new xdr.AccountEntry({
            accountId: Keypair.fromPublicKey(owner).xdrAccountId(),
            balance: 100_000_000n,
            seqNum: 10n,
            numSubEntries: 0,
            inflationDest: null,
            flags: 0,
            homeDomain: "",
            thresholds: Buffer.from([1, 0, 0, 0]),
            signers: [],
            ext: xdr.AccountEntryExt.v0(),
          }),
        ).toXDR("base64");
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: {
              latestLedger: 123,
              entries: [{ key: body.params?.keys?.[0], xdr: accountXdr, lastModifiedLedgerSeq: 123 }],
            },
          }),
          { status: 200 },
        );
      }
      if (body.method === "simulateTransaction" && body.params?.transaction) {
        const tx = TransactionBuilder.fromXDR(body.params.transaction, passphrase);
        const op = tx.operations[0] as unknown as { func?: xdr.HostFunction };
        const fnName = (
          op?.func as unknown as { invokeContract?: { functionName?: { toString(): string } } }
        )?.invokeContract?.functionName?.toString();
        if (fnName === "transfer") {
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: body.id,
              result: { latestLedger: 123, error: "HostError: Error(Contract, #302)" },
            }),
            { status: 200 },
          );
        }
        let retval: xdr.ScVal = nativeToScVal(null, { type: "void" });
        if (fnName === "balance") retval = nativeToScVal(1, { type: "u32" });
        else if (fnName === "name") retval = nativeToScVal("Sorobits", { type: "string" });
        else if (fnName === "symbol") retval = nativeToScVal("SBIT", { type: "string" });
        else if (fnName === "get_owner_token_id") retval = nativeToScVal(0, { type: "u32" });
        else if (fnName === "token_uri") {
          retval = nativeToScVal(
            `data:application/json;utf8,${JSON.stringify({ name: "Sorobit #0", image: safeSvg, attributes: [] })}`,
            { type: "string" },
          );
        } else if (fnName === "get_sorobit") {
          retval = xdr.ScVal.scvMap([
            new xdr.ScMapEntry({
              key: xdr.ScVal.scvSymbol("soulbound"),
              val: nativeToScVal(true, { type: "bool" }),
            }),
          ]);
        }
        return new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: body.id,
            result: { latestLedger: 123, results: [{ xdr: retval.toXDR("base64") }] },
          }),
          { status: 200 },
        );
      }
      return new Response("Not Found", { status: 404 });
    });

    try {
      const snap = await fetchSep50Holdings({
        contractId: SAMPLE_CONTRACT,
        ownerAddress: owner,
        rpcUrls: ["https://rpc.example.org"],
        networkPassphrase: passphrase,
      });
      expect(snap.items[0]?.soulbound).toBe(true);

      await expect(
        buildSep50TransferXdr({
          contractId: SAMPLE_CONTRACT,
          from: owner,
          to: dest,
          tokenId: 0,
          rpcUrls: ["https://rpc.example.org"],
          networkPassphrase: passphrase,
        }),
      ).rejects.toThrow(/soulbound on-chain/i);
    } finally {
      rpcSpy.mockRestore();
    }
  });
});
