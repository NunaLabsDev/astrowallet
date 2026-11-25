import { hmac } from "@noble/hashes/hmac.js";
import { sha256, sha512 } from "@noble/hashes/sha2.js";
import {
  generateMnemonic,
  mnemonicToSeedSync,
  validateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { authorizeEntry, Keypair, xdr } from "@stellar/stellar-sdk";
import type { ClassicAddress } from "@astrowallet/domain";

const SLIP10_ED25519_SEED_KEY = new TextEncoder().encode("ed25519 seed");
const HARDENED_OFFSET = 0x80000000;
const SEP53_PREFIX = "Stellar Signed Message:\n";

export interface DerivedStellarAccount {
  readonly index: number;
  readonly derivationPath: string;
  readonly publicKey: ClassicAddress;
  readonly rawSecretBytes: Uint8Array;
  toKeypair(): Keypair;
  zeroize(): void;
}

/**
 * Overwrites sensitive byte slices in RAM before releasing references.
 */
export function zeroizeBytes(bytes: Uint8Array): void {
  bytes.fill(0);
}

/**
 * Generates a 12-word (128-bit) or 24-word (256-bit) BIP-39 mnemonic phrase.
 */
export function generateMnemonicPhrase(strength: 128 | 256 = 128): string {
  return generateMnemonic(wordlist, strength);
}

/**
 * Validates a BIP-39 English mnemonic phrase (normalizing whitespace).
 */
export function validateMnemonicPhrase(mnemonic: string): boolean {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  return validateMnemonic(normalized, wordlist);
}

function normalizeMnemonic(mnemonic: string): string {
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid BIP-39 mnemonic phrase");
  }
  return normalized;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64.trim());
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

/**
 * Derives a Stellar Classic Ed25519 account following SEP-0005 (m/44'/148'/index').
 */
export function deriveStellarAccount(
  mnemonic: string,
  accountIndex: number,
  passphrase = "",
): DerivedStellarAccount {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error("Account derivation index must be a non-negative integer");
  }

  const normalized = normalizeMnemonic(mnemonic);
  const seed = mnemonicToSeedSync(normalized, passphrase);
  let master = hmac(sha512, SLIP10_ED25519_SEED_KEY, seed);
  let key = new Uint8Array(master.subarray(0, 32));
  let chainCode = new Uint8Array(master.subarray(32, 64));

  try {
    const pathIndices = [44, 148, accountIndex];
    for (const rawIndex of pathIndices) {
      const data = new Uint8Array(1 + 32 + 4);
      data[0] = 0x00;
      data.set(key, 1);
      new DataView(data.buffer).setUint32(33, (rawIndex | HARDENED_OFFSET) >>> 0, false);

      const next = hmac(sha512, chainCode, data);
      zeroizeBytes(data);
      zeroizeBytes(key);
      zeroizeBytes(chainCode);

      key = new Uint8Array(next.subarray(0, 32));
      chainCode = new Uint8Array(next.subarray(32, 64));
      zeroizeBytes(next);
    }

    const rawSecretBytes = new Uint8Array(key);
    const kp = Keypair.fromRawEd25519Seed(rawSecretBytes);
    const publicKey = kp.publicKey() as ClassicAddress;

    return {
      index: accountIndex,
      derivationPath: `m/44'/148'/${accountIndex}'`,
      publicKey,
      rawSecretBytes,
      toKeypair() {
        return Keypair.fromRawEd25519Seed(new Uint8Array(rawSecretBytes));
      },
      zeroize() {
        zeroizeBytes(rawSecretBytes);
      },
    };
  } finally {
    zeroizeBytes(seed);
    zeroizeBytes(master);
    zeroizeBytes(key);
    zeroizeBytes(chainCode);
    master = new Uint8Array(0);
  }
}

/**
 * Derives `count` sequential SEP-0005 accounts starting at index 0.
 */
export function deriveMultipleAccounts(
  mnemonic: string,
  count: number,
  passphrase = "",
): DerivedStellarAccount[] {
  if (!Number.isInteger(count) || count < 1 || count > 20) {
    throw new Error("Account count must be an integer between 1 and 20");
  }
  const accounts: DerivedStellarAccount[] = [];
  for (let i = 0; i < count; i += 1) {
    accounts.push(deriveStellarAccount(mnemonic, i, passphrase));
  }
  return accounts;
}

/**
 * Validates an external Stellar Ed25519 secret seed (`S...`) and wraps it in a zeroizable handle.
 */
export function parseExternalSecretAccount(secretSeed: string): {
  publicKey: ClassicAddress;
  secretKey: string;
  toKeypair: () => Keypair;
  zeroize: () => void;
} {
  const normalized = secretSeed.trim().toUpperCase();
  if (!/^S[A-Z2-7]{55}$/.test(normalized)) {
    throw new Error("Invalid Stellar secret key (expected 56-char S... seed)");
  }
  const kp = Keypair.fromSecret(normalized);
  const raw = new Uint8Array(kp.rawSecretKey());
  return {
    publicKey: kp.publicKey() as ClassicAddress,
    secretKey: normalized,
    toKeypair() {
      return Keypair.fromRawEd25519Seed(new Uint8Array(raw));
    },
    zeroize() {
      zeroizeBytes(raw);
    },
  };
}

/**
 * Signs a canonical SEP-53 challenge message using SHA-256("Stellar Signed Message:\n" + message).
 */
export function signChallengeMessage(keypair: Keypair, message: string): string {
  const payload = new TextEncoder().encode(`${SEP53_PREFIX}${message}`);
  const digest = sha256(payload);
  const sig = keypair.sign(digest);
  return toBase64(sig);
}

/**
 * Verifies a SEP-53 signed message signature against an Ed25519 Classic public key.
 */
export function verifyChallengeMessage(
  publicKey: ClassicAddress,
  message: string,
  signatureBase64: string,
): boolean {
  try {
    const kp = Keypair.fromPublicKey(publicKey);
    const payload = new TextEncoder().encode(`${SEP53_PREFIX}${message}`);
    const digest = sha256(payload);
    return kp.verify(digest, fromBase64(signatureBase64));
  } catch {
    return false;
  }
}

/**
 * Returns the lowercase 32-byte raw Ed25519 public key hex representation for a G... address.
 */
export function publicKeyToRawHex(publicKey: ClassicAddress): string {
  const raw = Keypair.fromPublicKey(publicKey).rawPublicKey();
  return Array.from(raw, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Signs a Soroban `HashIdPreimage` or `SorobanAuthorizationEntry` Base64 XDR
 * using the supplied Ed25519 Classic keypair (SEP-43 / SEP-60).
 */
export async function signSorobanAuthEntry(
  keypair: Keypair,
  entryXdr: string,
  options?: {
    networkPassphrase?: string | undefined;
    validUntilLedgerSeq?: number | undefined;
  },
): Promise<{
  kind: "hash_id_preimage" | "soroban_authorization_entry";
  signedAuthEntry: string;
  signatureBase64: string;
  signerAddress: ClassicAddress;
}> {
  const cleaned = entryXdr.trim();
  if (!cleaned) {
    throw new Error("Authorization entry XDR is required");
  }

  let preimage: xdr.HashIdPreimage | null = null;
  try {
    preimage = xdr.HashIdPreimage.fromXDR(cleaned, "base64");
  } catch {
    preimage = null;
  }

  const signerAddress = keypair.publicKey() as ClassicAddress;

  if (preimage !== null) {
    if (
      preimage.type !== "envelopeTypeSorobanAuthorization" &&
      preimage.type !== "envelopeTypeSorobanAuthorizationWithAddress"
    ) {
      throw new Error(`Refusing to sign non-Soroban HashIdPreimage (${preimage.type})`);
    }
    const rawNetId =
      preimage.type === "envelopeTypeSorobanAuthorization"
        ? preimage.sorobanAuthorization.networkId
        : preimage.sorobanAuthorizationWithAddress.networkId;
    const preimageNetworkId =
      rawNetId instanceof Uint8Array
        ? rawNetId
        : (rawNetId as { toBytes(): Uint8Array }).toBytes();
    if (options?.networkPassphrase) {
      const expectedNetId = sha256(new TextEncoder().encode(options.networkPassphrase));
      let matches = preimageNetworkId.length === expectedNetId.length;
      if (matches) {
        for (let i = 0; i < expectedNetId.length; i += 1) {
          if (preimageNetworkId[i] !== expectedNetId[i]) {
            matches = false;
            break;
          }
        }
      }
      if (!matches) {
        throw new Error("Cross-network Soroban auth preimage networkId mismatch");
      }
    }
    const digest = sha256(preimage.toXDR());
    const signatureBase64 = toBase64(keypair.sign(digest));
    return {
      kind: "hash_id_preimage",
      signedAuthEntry: signatureBase64,
      signatureBase64,
      signerAddress,
    };
  }

  let entry: xdr.SorobanAuthorizationEntry;
  try {
    entry = xdr.SorobanAuthorizationEntry.fromXDR(cleaned, "base64");
  } catch (err) {
    throw new Error(
      `Invalid Soroban auth entry XDR: ${err instanceof Error ? err.message : "decode failed"}`,
    );
  }

  if (!options?.networkPassphrase) {
    throw new Error(
      "networkPassphrase is required to authorize a raw SorobanAuthorizationEntry XDR",
    );
  }

  const cred = entry.credentials as unknown as {
    address?: { signatureExpirationLedger?: number | bigint };
  };
  const fallbackLedger = Number(cred.address?.signatureExpirationLedger ?? 0);
  const validUntil = options.validUntilLedgerSeq ?? (fallbackLedger > 0 ? fallbackLedger : 1);

  let lastSigBase64 = "";
  const authorized = await authorizeEntry(
    entry,
    async (pre) => {
      const sigBytes = keypair.sign(sha256(pre.toXDR()));
      lastSigBase64 = toBase64(sigBytes);
      return sigBytes;
    },
    validUntil,
    options.networkPassphrase,
  );

  return {
    kind: "soroban_authorization_entry",
    signedAuthEntry: authorized.toXDR("base64"),
    signatureBase64: lastSigBase64 || toBase64(sha256(authorized.toXDR())),
    signerAddress,
  };
}
