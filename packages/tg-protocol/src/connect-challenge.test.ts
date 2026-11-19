import { getPublicKeyAsync, signAsync } from "@noble/ed25519";
import { describe, expect, it } from "vitest";
import type { ClassicAddress, ContractAddress } from "@astrowallet/domain";
import {
  formatConnectChallengeMessage,
  formatSmartAccountLinkMessage,
  verifyConnectSignature,
  verifySmartAccountGuardianSignature,
  type ConnectChallengePayload,
} from "./connect-challenge.js";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function crc16Xmodem(bytes: Uint8Array): number {
  let crc = 0;
  for (const byte of bytes) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i += 1) {
      crc = (crc & 0x8000) !== 0 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function encodeClassicStrKey(pubKey: Uint8Array): ClassicAddress {
  const payload = new Uint8Array(35);
  payload[0] = 6 << 3;
  payload.set(pubKey, 1);
  const crc = crc16Xmodem(payload.subarray(0, 33));
  payload[33] = crc & 0xff;
  payload[34] = (crc >> 8) & 0xff;

  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of payload) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31] ?? "";
      bits -= 5;
    }
  }
  return out as ClassicAddress;
}

describe("SEP-53 connect challenge verification", () => {
  it("verifies a genuine Ed25519 signature and rejects tampering", async () => {
    const privKey = new Uint8Array(32);
    crypto.getRandomValues(privKey);
    const pubKey = await getPublicKeyAsync(privKey);
    const address = encodeClassicStrKey(pubKey);

    const payload: ConnectChallengePayload = {
      challengeId: "ch_test_001",
      network: "testnet",
      telegramUserId: "777000",
      usernameLower: "tester",
      issuedAt: 1_900_000_000,
      expiresAt: 1_900_000_300,
    };
    const message = formatConnectChallengeMessage(payload);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`Stellar Signed Message:\n${message}`),
    );
    const sig = await signAsync(new Uint8Array(digest), privKey);
    const sigB64 = btoa(String.fromCharCode(...sig));

    expect(
      await verifyConnectSignature({
        address,
        message,
        signatureBase64: sigB64,
      }),
    ).toBe(true);

    expect(
      await verifyConnectSignature({
        address,
        message: `${message}:tampered`,
        signatureBase64: sigB64,
      }),
    ).toBe(false);

    expect(
      await verifyConnectSignature({
        address,
        message,
        signatureBase64: btoa("invalid-sig"),
      }),
    ).toBe(false);

    // Smart account C... guardian link proof
    const smartC = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM" as ContractAddress;
    const boundMsg = formatSmartAccountLinkMessage(message, smartC);
    const smartDigest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`Stellar Signed Message:\n${boundMsg}`),
    );
    const smartSig = await signAsync(new Uint8Array(smartDigest), privKey);
    const smartSigB64 = btoa(String.fromCharCode(...smartSig));

    expect(
      await verifySmartAccountGuardianSignature({
        contractAddress: smartC,
        guardianAddress: address,
        challengeMessage: message,
        signatureBase64: smartSigB64,
      }),
    ).toBe(true);

    expect(
      await verifySmartAccountGuardianSignature({
        contractAddress: smartC,
        guardianAddress: address,
        challengeMessage: message,
        signatureBase64: sigB64, // wrong message binding
      }),
    ).toBe(false);
  });
});
