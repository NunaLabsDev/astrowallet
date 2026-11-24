import { describe, expect, it } from "vitest";
import { parseSep50TokenUri } from "./sep50/index.js";

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
});
