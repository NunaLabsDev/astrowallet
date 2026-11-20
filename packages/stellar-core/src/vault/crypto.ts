import { argon2idAsync as nobleArgon2idAsync } from "@noble/hashes/argon2.js";
import { argon2id as wasmArgon2id } from "hash-wasm";
import { z } from "zod";
import { zeroizeBytes } from "../sep0005.js";

export interface Argon2idParams {
  algorithm: "argon2id";
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  hashLength: number;
}

export const DEFAULT_ARGON2ID_PARAMS: Argon2idParams = Object.freeze({
  algorithm: "argon2id",
  memoryKiB: 65_536,
  iterations: 3,
  parallelism: 1,
  hashLength: 32,
});

export interface SecretStrengthResult {
  score: 0 | 1 | 2 | 3 | 4;
  level: "weak" | "fair" | "good" | "strong";
  acceptable: boolean;
  reasons: string[];
}

const COMMON_WEAK_SECRETS = new Set([
  "000000",
  "111111",
  "222222",
  "333333",
  "444444",
  "555555",
  "666666",
  "777777",
  "888888",
  "999999",
  "123456",
  "654321",
  "123123",
  "121212",
  "012345",
  "987654",
  "112233",
  "000123",
  "1234567",
  "12345678",
  "87654321",
  "password",
  "passphrase",
  "qwerty",
  "astrowallet",
]);

function isStrictlySequentialDigits(secret: string): boolean {
  if (!/^\d{6,}$/.test(secret)) return false;
  let asc = true;
  let desc = true;
  for (let i = 1; i < secret.length; i += 1) {
    const prev = secret.charCodeAt(i - 1);
    const curr = secret.charCodeAt(i);
    if (curr - prev !== 1) asc = false;
    if (prev - curr !== 1) desc = false;
  }
  return asc || desc;
}

/**
 * Evaluates PIN / passphrase strength to block trivial lock secrets (`000000`, `123456`, etc.).
 */
export function evaluateSecretStrength(secret: string): SecretStrengthResult {
  const reasons: string[] = [];
  if (secret.length < 6) {
    reasons.push("Must be at least 6 characters");
    return { score: 0, level: "weak", acceptable: false, reasons };
  }

  const uniqueChars = new Set(secret).size;
  if (uniqueChars <= 1) {
    reasons.push("Avoid repeating the same character");
  }
  if (COMMON_WEAK_SECRETS.has(secret.toLowerCase())) {
    reasons.push("Avoid common easily-guessed PINs or passwords");
  }
  if (isStrictlySequentialDigits(secret)) {
    reasons.push("Avoid sequential digits");
  }
  if (uniqueChars === 2 && secret.length <= 6) {
    reasons.push("Use at least 3 distinct digits or characters");
  }

  if (reasons.length > 0) {
    return { score: 1, level: "weak", acceptable: false, reasons };
  }

  let score: 0 | 1 | 2 | 3 | 4 = 2;
  const hasMixedClasses =
    (/[a-z]/i.test(secret) && /\d/.test(secret)) ||
    /[^a-zA-Z0-9]/.test(secret);

  if (secret.length >= 10 || (secret.length >= 8 && uniqueChars >= 6)) {
    score = 3;
  }
  if (hasMixedClasses && secret.length >= 8 && uniqueChars >= 6) {
    score = 4;
  } else if (secret.length >= 12 && uniqueChars >= 7) {
    score = 4;
  }

  const level = score === 4 ? "strong" : score === 3 ? "good" : "fair";
  return { score, level, acceptable: true, reasons: [] };
}

export interface VaultAccountMetadata {
  index: number;
  label: string;
  address: string;
}

export interface VaultPayload {
  mnemonic: string;
  accounts: VaultAccountMetadata[];
  createdAt: number;
}

export interface EncryptedVaultEnvelope {
  version: 1;
  format: "AGVAULT";
  kdf: Argon2idParams;
  saltB64: string;
  ivB64: string;
  ciphertextB64: string;
  createdAt: number;
  updatedAt: number;
}

export interface KdfRunOptions {
  preferWasm?: boolean;
  kdfParams?: Argon2idParams;
  deriveKeyFn?: typeof deriveKeyArgon2id | undefined;
}

const VaultPayloadSchema = z.object({
  mnemonic: z.string().min(1),
  accounts: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      label: z.string().min(1).max(32),
      address: z.string().regex(/^G[A-Z2-7]{55}$/),
    }),
  ),
  createdAt: z.number().int().positive(),
});

const EncryptedVaultEnvelopeSchema = z.object({
  version: z.literal(1),
  format: z.literal("AGVAULT"),
  kdf: z.object({
    algorithm: z.literal("argon2id"),
    memoryKiB: z.number().int().positive(),
    iterations: z.number().int().positive(),
    parallelism: z.number().int().positive(),
    hashLength: z.literal(32),
  }),
  saltB64: z.string().min(16),
  ivB64: z.string().min(12),
  ciphertextB64: z.string().min(16),
  createdAt: z.number().int().positive(),
  updatedAt: z.number().int().positive(),
});

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) {
    out[i] = binary.charCodeAt(i);
  }
  return out;
}

function toArrayBufferBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  copy.set(bytes);
  return copy;
}

/**
 * Derives a 256-bit key via Argon2id using hash-wasm primary and @noble/hashes fallback.
 */
export async function deriveKeyArgon2id(
  pinOrPassphrase: string,
  salt: Uint8Array,
  params: Argon2idParams = DEFAULT_ARGON2ID_PARAMS,
  options: KdfRunOptions = {},
): Promise<{ keyBytes: Uint8Array<ArrayBuffer>; engine: "wasm" | "noble-js" }> {
  if (!pinOrPassphrase || pinOrPassphrase.length < 6) {
    throw new Error("PIN or passphrase must be at least 6 characters");
  }

  const preferWasm = options.preferWasm ?? true;
  const saltCopy = toArrayBufferBytes(salt);

  if (preferWasm) {
    try {
      const derived = await wasmArgon2id({
        password: pinOrPassphrase,
        salt: saltCopy,
        iterations: params.iterations,
        parallelism: params.parallelism,
        memorySize: params.memoryKiB,
        hashLength: params.hashLength,
        outputType: "binary",
      });
      return { keyBytes: toArrayBufferBytes(derived), engine: "wasm" };
    } catch {
      // Automatic fallback when strict CSP / Lockdown Mode blocks WASM
    }
  }

  const passwordBytes = new TextEncoder().encode(pinOrPassphrase);
  try {
    const derived = await nobleArgon2idAsync(passwordBytes, saltCopy, {
      m: params.memoryKiB,
      t: params.iterations,
      p: params.parallelism,
      dkLen: params.hashLength,
    });
    return { keyBytes: toArrayBufferBytes(derived), engine: "noble-js" };
  } finally {
    zeroizeBytes(passwordBytes);
  }
}

/**
 * Encrypts a SEP-0005 vault payload with Argon2id + AES-GCM-256 (non-extractable CryptoKey).
 */
export async function encryptVaultPayload(
  payload: VaultPayload,
  pinOrPassphrase: string,
  options: KdfRunOptions = {},
): Promise<EncryptedVaultEnvelope> {
  const validated = VaultPayloadSchema.parse(payload);
  const kdf = options.kdfParams ?? DEFAULT_ARGON2ID_PARAMS;

  const salt = new Uint8Array(new ArrayBuffer(16));
  const iv = new Uint8Array(new ArrayBuffer(12));
  crypto.getRandomValues(salt);
  crypto.getRandomValues(iv);

  const deriveFn = options.deriveKeyFn ?? deriveKeyArgon2id;
  const { keyBytes } = await deriveFn(pinOrPassphrase, salt, kdf, options);
  const plaintext = new TextEncoder().encode(JSON.stringify(validated));

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["encrypt"],
    );
    const ciphertextBuf = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      toArrayBufferBytes(plaintext),
    );
    const now = Math.floor(Date.now() / 1000);

    return {
      version: 1,
      format: "AGVAULT",
      kdf,
      saltB64: bytesToBase64(salt),
      ivB64: bytesToBase64(iv),
      ciphertextB64: bytesToBase64(new Uint8Array(ciphertextBuf)),
      createdAt: validated.createdAt,
      updatedAt: now,
    };
  } finally {
    zeroizeBytes(keyBytes);
    zeroizeBytes(plaintext);
  }
}

/**
 * Decrypts an EncryptedVaultEnvelope using the user's PIN/passphrase. Fails closed on wrong PIN.
 */
export async function decryptVaultPayload(
  envelope: EncryptedVaultEnvelope,
  pinOrPassphrase: string,
  options: Omit<KdfRunOptions, "kdfParams"> = {},
): Promise<VaultPayload> {
  const parsed = EncryptedVaultEnvelopeSchema.parse(envelope);
  const salt = base64ToBytes(parsed.saltB64);
  const iv = base64ToBytes(parsed.ivB64);
  const ciphertext = base64ToBytes(parsed.ciphertextB64);

  const deriveFn = options.deriveKeyFn ?? deriveKeyArgon2id;
  const { keyBytes } = await deriveFn(pinOrPassphrase, salt, parsed.kdf, options);
  let decryptedBytes = new Uint8Array(0);

  try {
    const cryptoKey = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "AES-GCM" },
      false,
      ["decrypt"],
    );
    const plaintextBuf = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      ciphertext,
    );
    decryptedBytes = new Uint8Array(plaintextBuf);
    const jsonText = new TextDecoder().decode(decryptedBytes);
    return VaultPayloadSchema.parse(JSON.parse(jsonText));
  } catch {
    throw new Error("Invalid PIN/passphrase or corrupted vault envelope");
  } finally {
    zeroizeBytes(keyBytes);
    zeroizeBytes(decryptedBytes);
  }
}

export function serializeAgVaultBackup(envelope: EncryptedVaultEnvelope): string {
  const validated = EncryptedVaultEnvelopeSchema.parse(envelope);
  return JSON.stringify(validated, null, 2);
}

export function parseAgVaultBackup(rawJson: string): EncryptedVaultEnvelope {
  const parsed = JSON.parse(rawJson) as unknown;
  return EncryptedVaultEnvelopeSchema.parse(parsed);
}
