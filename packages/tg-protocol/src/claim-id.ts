interface MinimalDigestCrypto {
  digest(algorithm: "SHA-256", data: Uint8Array): Promise<ArrayBuffer>;
}

/**
 * Deterministically derives the 32-byte (64 hex chars) Claim Escrow `claim_id` bound to a Telegram intent,
 * so the server can verify on-chain `create_claim` / `claim` calls belong to exactly one intent.
 */
export async function deriveClaimId(intentId: string): Promise<string> {
  const g = globalThis as unknown as {
    crypto?: { subtle?: MinimalDigestCrypto };
    TextEncoder?: new () => { encode(input: string): Uint8Array };
  };
  const subtle = g.crypto?.subtle;
  const Encoder = g.TextEncoder;
  if (!subtle || !Encoder) {
    throw new Error("Web Crypto SubtleCrypto and TextEncoder are required");
  }
  const digest = await subtle.digest(
    "SHA-256",
    new Encoder().encode(`astrowallet:claim:v1:${intentId}`),
  );
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}
