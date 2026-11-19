import type { ClassicAddress } from "@astrowallet/domain";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const CLASSIC_ACCOUNT_VERSION_BYTE = 6 << 3; // 48 (0x30) -> 'G'

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0x0000;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      if ((crc & 0x8000) !== 0) {
        crc = ((crc << 1) ^ 0x1021) & 0xffff;
      } else {
        crc = (crc << 1) & 0xffff;
      }
    }
  }
  return crc;
}

function decodeBase32(encoded: string): Uint8Array {
  let buffer = 0;
  let bitsLeft = 0;
  const bytes: number[] = [];

  for (let i = 0; i < encoded.length; i += 1) {
    const ch = encoded[i];
    if (!ch) throw new Error("Unexpected empty character in base32 string");
    const val = BASE32_ALPHABET.indexOf(ch);
    if (val === -1) {
      throw new Error(`Invalid base32 character "${ch}"`);
    }
    buffer = (buffer << 5) | val;
    bitsLeft += 5;
    if (bitsLeft >= 8) {
      bitsLeft -= 8;
      bytes.push((buffer >> bitsLeft) & 0xff);
    }
  }

  return new Uint8Array(bytes);
}

/**
 * Pure StrKey decoder extracting the 32-byte Ed25519 public key from a Stellar G... address.
 * Validates version byte and CRC16-XMODEM checksum without depending on stellar-sdk.
 */
export function decodeClassicPublicKey(address: ClassicAddress): Uint8Array {
  if (!/^G[A-Z2-7]{55}$/.test(address)) {
    throw new Error("Invalid Classic Stellar public address format");
  }

  const decoded = decodeBase32(address);
  if (decoded.length !== 35) {
    throw new Error(`Unexpected decoded StrKey byte length: ${decoded.length}`);
  }

  if (decoded[0] !== CLASSIC_ACCOUNT_VERSION_BYTE) {
    throw new Error("Unexpected StrKey version byte for Classic account");
  }

  const payloadWithoutCrc = decoded.subarray(0, 33);
  const expectedCrc = crc16Xmodem(payloadWithoutCrc);
  const actualCrc = (decoded[33] ?? 0) | ((decoded[34] ?? 0) << 8);

  if (expectedCrc !== actualCrc) {
    throw new Error("StrKey CRC16 checksum mismatch");
  }

  return new Uint8Array(decoded.subarray(1, 33));
}
