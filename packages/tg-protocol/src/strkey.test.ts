import { describe, expect, it } from "vitest";
import { decodeClassicPublicKey } from "./strkey.js";

const OFFICIAL_SEP0005_G0 =
  "GDRXE2BQUC3AZNPVFSCEZ76NJ3WWL25FYFK6RGZGIEKWE4SOOHSUJUJ6" as const;

describe("Pure StrKey decoder", () => {
  it("extracts 32-byte public key from valid G... address", () => {
    const pub = decodeClassicPublicKey(OFFICIAL_SEP0005_G0);
    expect(pub).toBeInstanceOf(Uint8Array);
    expect(pub.length).toBe(32);
  });

  it("rejects corrupted CRC16 checksum", () => {
    const corrupted = (OFFICIAL_SEP0005_G0.slice(0, -1) +
      (OFFICIAL_SEP0005_G0.endsWith("6") ? "7" : "6")) as typeof OFFICIAL_SEP0005_G0;
    expect(() => decodeClassicPublicKey(corrupted)).toThrow(/checksum mismatch/);
  });

  it("rejects non-G... address strings", () => {
    expect(() =>
      decodeClassicPublicKey("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM" as never),
    ).toThrow(/Invalid Classic Stellar public address/);
  });
});
