import {
  normalizeDecimalAmountInput,
  type TonAccountSummary,
  type TonAddress,
  type TonNetwork,
} from "@astrowallet/domain";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { Address, beginCell, storeStateInit } from "@ton/core";
import { WalletContractV4, WalletContractV5R1 } from "@ton/ton";
import nacl from "tweetnacl";

const SLIP10_ED25519_SEED_KEY = new TextEncoder().encode("ed25519 seed");
const HARDENED_OFFSET = 0x80000000;
const NANO_PER_TON = 1_000_000_000n;

export type TonWalletVersion = "v4r2" | "v5r1";

export interface DerivedTonAccount {
  readonly index: number;
  readonly derivationPath: string;
  readonly network: TonNetwork;
  readonly version: TonWalletVersion;
  readonly rawAddress: TonAddress;
  readonly friendlyAddress: TonAddress;
  readonly bounceableAddress: TonAddress;
  readonly publicKeyHex: string;
  readonly walletStateInitBase64: string;
  readonly secretKey: Uint8Array;
  readonly wallet: WalletContractV4 | WalletContractV5R1;
  sign(message: Uint8Array): Uint8Array;
  toSummary(): TonAccountSummary;
  zeroize(): void;
}

function zeroize(bytes: Uint8Array): void {
  bytes.fill(0);
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * Validates and converts a decimal TON amount string into exact bigint nanoton (9 decimals).
 */
export function parseTonToNano(amountTon: string): bigint {
  const normalized = normalizeDecimalAmountInput(amountTon, 9);
  if (!normalized) {
    throw new Error("TON amount must be a positive decimal with at most 9 decimal places");
  }
  const [whole = "0", frac = ""] = normalized.split(".");
  const nano = BigInt(whole) * NANO_PER_TON + BigInt(frac.padEnd(9, "0"));
  if (nano <= 0n) {
    throw new Error("TON amount must be greater than zero");
  }
  return nano;
}

/**
 * Formats nanoton integer/bigint into a human-readable decimal TON string (up to 9 decimals).
 */
export function formatNanoTon(nano: bigint | string): string {
  const val = typeof nano === "string" ? BigInt(nano) : nano;
  if (val < 0n) {
    throw new Error("NanoTON balance cannot be negative");
  }
  const whole = val / NANO_PER_TON;
  const frac = (val % NANO_PER_TON).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole.toString()}.${frac}` : `${whole.toString()}.0`;
}

/**
 * Checks whether a string is a valid TON raw or user-friendly address.
 */
export function isValidTonAddress(raw: string): boolean {
  try {
    Address.parse(raw.trim());
    return true;
  } catch {
    return false;
  }
}

/**
 * Derives a non-custodial TON Wallet (V4R2 or V5R1) from the user's BIP-39 mnemonic
 * via SLIP-0010 Ed25519 path m/44'/607'/accountIndex'.
 */
export function deriveTonAccount(
  mnemonic: string,
  accountIndex: number,
  network: TonNetwork,
  version: TonWalletVersion = "v4r2",
  passphrase = "",
): DerivedTonAccount {
  if (!Number.isInteger(accountIndex) || accountIndex < 0) {
    throw new Error("Account derivation index must be a non-negative integer");
  }
  const normalized = mnemonic.trim().toLowerCase().replace(/\s+/g, " ");
  if (!validateMnemonic(normalized, wordlist)) {
    throw new Error("Invalid BIP-39 mnemonic phrase");
  }

  const seed = mnemonicToSeedSync(normalized, passphrase);
  let master = hmac(sha512, SLIP10_ED25519_SEED_KEY, seed);
  let key = new Uint8Array(master.subarray(0, 32));
  let chainCode = new Uint8Array(master.subarray(32, 64));

  try {
    const pathIndices = [44, 607, accountIndex];
    for (const rawIndex of pathIndices) {
      const data = new Uint8Array(1 + 32 + 4);
      data[0] = 0x00;
      data.set(key, 1);
      new DataView(data.buffer).setUint32(33, (rawIndex | HARDENED_OFFSET) >>> 0, false);

      const next = hmac(sha512, chainCode, data);
      zeroize(data);
      zeroize(key);
      zeroize(chainCode);

      key = new Uint8Array(next.subarray(0, 32));
      chainCode = new Uint8Array(next.subarray(32, 64));
      zeroize(next);
    }

    const kp = nacl.sign.keyPair.fromSeed(key);
    const pubKeyBuf = Buffer.from(kp.publicKey);
    const secretKey = new Uint8Array(kp.secretKey);
    zeroize(kp.secretKey);

    const wallet =
      version === "v5r1"
        ? WalletContractV5R1.create({
            publicKey: pubKeyBuf,
            walletId: {
              networkGlobalId: network === "mainnet" ? -239 : -3,
              context: {
                walletVersion: "v5r1",
                workchain: 0,
                subwalletNumber: accountIndex,
              },
            },
          })
        : WalletContractV4.create({
            workchain: 0,
            publicKey: pubKeyBuf,
          });

    const testOnly = network === "testnet";
    const rawAddress = wallet.address.toRawString() as TonAddress;
    const friendlyAddress = wallet.address.toString({
      bounceable: false,
      testOnly,
    }) as TonAddress;
    const bounceableAddress = wallet.address.toString({
      bounceable: true,
      testOnly,
    }) as TonAddress;
    const publicKeyHex = toHex(kp.publicKey);
    const walletStateInitBase64 = beginCell()
      .store(storeStateInit(wallet.init))
      .endCell()
      .toBoc()
      .toString("base64");
    const derivationPath = `m/44'/607'/${accountIndex}'`;

    return {
      index: accountIndex,
      derivationPath,
      network,
      version,
      rawAddress,
      friendlyAddress,
      bounceableAddress,
      publicKeyHex,
      walletStateInitBase64,
      secretKey,
      wallet,
      sign(message: Uint8Array): Uint8Array {
        return nacl.sign.detached(message, secretKey);
      },
      toSummary(): TonAccountSummary {
        return {
          derivationPath,
          friendlyAddress,
          bounceableAddress,
          rawAddress,
          publicKeyHex,
          walletStateInitBase64,
          network,
          version,
        };
      },
      zeroize() {
        zeroize(secretKey);
      },
    };
  } finally {
    zeroize(seed);
    zeroize(master);
    zeroize(key);
    zeroize(chainCode);
    master = new Uint8Array(0);
  }
}
