import { sha256 } from "@noble/hashes/sha2.js";
import type { ClassicAddress, StellarNetwork } from "@astrowallet/domain";
import {
  authorizeEntry,
  Horizon,
  TransactionBuilder,
  xdr,
  type Keypair,
} from "@stellar/stellar-sdk";
import { createFailoverEndpoints } from "../network.js";
import { signChallengeMessage } from "../sep0005.js";

export type WalletConnectStellarMethod =
  | "stellar_signXDR"
  | "stellar_signAndSubmitXDR"
  | "stellar_signAuthEntry"
  | "stellar_signMessage";

export interface WalletConnectStellarRequest {
  id?: string | number | undefined;
  method: WalletConnectStellarMethod;
  chainId?: string | undefined;
  origin?: string | undefined;
  params: {
    xdr?: string | undefined;
    entryXdr?: string | undefined;
    authEntry?: string | undefined;
    message?: string | undefined;
    validUntilLedgerSeq?: number | undefined;
    networkPassphrase?: string | undefined;
  };
}

export type WalletConnectStellarResponse =
  | { signedXDR: string }
  | { status: "submitted"; hash: string; ledger: number; signedXDR: string }
  | { signedAuthEntry: string; signerAddress: ClassicAddress }
  | { signedMessage: string; signerAddress: ClassicAddress };

export interface DappResponderConfig {
  network: StellarNetwork;
  networkPassphrase: string;
  horizonUrls?: readonly string[] | undefined;
  getKeypair: () => Promise<Keypair> | Keypair;
  authorizeRequest?:
    | ((ctx: {
        method: WalletConnectStellarMethod;
        params: Record<string, unknown>;
        origin?: string | undefined;
      }) => Promise<boolean>)
    | undefined;
  submitSignedXdr?:
    | ((signedXdrBase64: string) => Promise<{ hash: string; ledger: number }>)
    | undefined;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const byte of bytes) {
    bin += String.fromCharCode(byte);
  }
  return btoa(bin);
}

export function expectedCaip2ChainId(network: StellarNetwork): string {
  return network === "mainnet" ? "stellar:pubnet" : "stellar:testnet";
}

function assertMatchingNetwork(
  config: Pick<DappResponderConfig, "network" | "networkPassphrase">,
  chainId?: string,
  requestedPassphrase?: string,
): void {
  if (chainId) {
    const expected = expectedCaip2ChainId(config.network);
    if (chainId !== expected) {
      throw new Error(
        `Cross-network dApp chain "${chainId}" rejected (active wallet network is "${expected}")`,
      );
    }
  }
  if (requestedPassphrase && requestedPassphrase !== config.networkPassphrase) {
    throw new Error("Cross-network passphrase mismatch rejected");
  }
}

function bytesEqualConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

async function signAuthEntryPayload(
  rawEntryXdr: string,
  keypair: Keypair,
  networkPassphrase: string,
  validUntilLedgerSeq?: number,
): Promise<{ signedAuthEntry: string; signerAddress: ClassicAddress }> {
  const cleaned = rawEntryXdr.trim();
  if (!cleaned) {
    throw new Error("Authorization entry XDR is required");
  }

  // Case 1: HashIdPreimage (SEP-43 / WalletConnect standard preimage)
  let preimage: xdr.HashIdPreimage | null = null;
  try {
    preimage = xdr.HashIdPreimage.fromXDR(cleaned, "base64");
  } catch {
    preimage = null;
  }

  if (preimage !== null) {
    let networkIdBytes: Uint8Array;
    if (preimage.type === "envelopeTypeSorobanAuthorization") {
      networkIdBytes = preimage.sorobanAuthorization.networkId.toBytes();
    } else if (preimage.type === "envelopeTypeSorobanAuthorizationWithAddress") {
      networkIdBytes = preimage.sorobanAuthorizationWithAddress.networkId.toBytes();
    } else {
      throw new Error(`Unsupported HashIdPreimage type for Soroban auth: ${preimage.type}`);
    }

    const expectedNetworkId = sha256(new TextEncoder().encode(networkPassphrase));
    if (!bytesEqualConstantTime(networkIdBytes, expectedNetworkId)) {
      throw new Error("Cross-network Soroban auth entry networkId mismatch rejected");
    }

    const digest = sha256(base64ToBytes(cleaned));
    const signature = keypair.sign(digest);
    return {
      signedAuthEntry: bytesToBase64(signature),
      signerAddress: keypair.publicKey() as ClassicAddress,
    };
  }

  // Case 2: SorobanAuthorizationEntry XDR
  if (
    validUntilLedgerSeq === undefined ||
    !Number.isInteger(validUntilLedgerSeq) ||
    validUntilLedgerSeq < 1 ||
    validUntilLedgerSeq > 2_000_000_000
  ) {
    throw new Error(
      "validUntilLedgerSeq must be an integer between 1 and 2,000,000,000 for SorobanAuthorizationEntry",
    );
  }

  try {
    const entry = xdr.SorobanAuthorizationEntry.fromXDR(cleaned, "base64");
    const authorized = await authorizeEntry(
      entry,
      keypair,
      validUntilLedgerSeq,
      networkPassphrase,
    );
    return {
      signedAuthEntry: authorized.toXDR("base64"),
      signerAddress: keypair.publicKey() as ClassicAddress,
    };
  } catch (err) {
    throw new Error(
      `Invalid Soroban authorization entry XDR: ${err instanceof Error ? err.message : "decode failed"}`,
    );
  }
}

async function submitXdrViaHorizon(
  horizonUrls: readonly string[],
  networkPassphrase: string,
  signedXdr: string,
): Promise<{ hash: string; ledger: number }> {
  const endpoints = createFailoverEndpoints(horizonUrls);
  const urls = endpoints.list();
  const tx = TransactionBuilder.fromXDR(signedXdr, networkPassphrase);
  let lastError: unknown;

  for (let i = 0; i < urls.length; i += 1) {
    const url = endpoints.current();
    const server = new Horizon.Server(url, { allowHttp: url.startsWith("http://") });
    try {
      const result = await server.submitTransaction(tx);
      return { hash: result.hash, ledger: result.ledger };
    } catch (err) {
      lastError = err;
      endpoints.next();
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Failed to submit signed XDR");
}

/**
 * Reown AppKit / WalletConnect v2 Stellar JSON-RPC responder.
 */
export function createWalletConnectStellarResponder(config: DappResponderConfig) {
  return {
    getSupportedMethods(): readonly WalletConnectStellarMethod[] {
      return [
        "stellar_signXDR",
        "stellar_signAndSubmitXDR",
        "stellar_signAuthEntry",
        "stellar_signMessage",
      ];
    },

    getChainId(): string {
      return expectedCaip2ChainId(config.network);
    },

    async handleRequest(
      request: WalletConnectStellarRequest,
    ): Promise<WalletConnectStellarResponse> {
      assertMatchingNetwork(config, request.chainId, request.params.networkPassphrase);

      if (config.authorizeRequest) {
        const approved = await config.authorizeRequest({
          method: request.method,
          params: request.params as Record<string, unknown>,
          origin: request.origin,
        });
        if (!approved) {
          throw new Error("User rejected dApp signing request");
        }
      }

      const keypair = await config.getKeypair();

      switch (request.method) {
        case "stellar_signXDR": {
          const rawXdr = request.params.xdr?.trim();
          if (!rawXdr) throw new Error("Missing XDR payload");
          const tx = TransactionBuilder.fromXDR(rawXdr, config.networkPassphrase);
          tx.sign(keypair);
          return { signedXDR: tx.toXDR() };
        }

        case "stellar_signAndSubmitXDR": {
          const rawXdr = request.params.xdr?.trim();
          if (!rawXdr) throw new Error("Missing XDR payload");
          const tx = TransactionBuilder.fromXDR(rawXdr, config.networkPassphrase);
          tx.sign(keypair);
          const signedXDR = tx.toXDR();

          const submitted = config.submitSignedXdr
            ? await config.submitSignedXdr(signedXDR)
            : config.horizonUrls && config.horizonUrls.length > 0
              ? await submitXdrViaHorizon(
                  config.horizonUrls,
                  config.networkPassphrase,
                  signedXDR,
                )
              : (() => {
                  throw new Error("No Horizon submission adapter configured");
                })();

          return {
            status: "submitted",
            hash: submitted.hash,
            ledger: submitted.ledger,
            signedXDR,
          };
        }

        case "stellar_signAuthEntry": {
          const entryXdr = request.params.entryXdr ?? request.params.authEntry ?? "";
          return signAuthEntryPayload(
            entryXdr,
            keypair,
            config.networkPassphrase,
            request.params.validUntilLedgerSeq,
          );
        }

        case "stellar_signMessage": {
          const msg = request.params.message;
          if (typeof msg !== "string" || msg.length === 0) {
            throw new Error("Message string is required");
          }
          return {
            signedMessage: signChallengeMessage(keypair, msg),
            signerAddress: keypair.publicKey() as ClassicAddress,
          };
        }
      }
    },
  };
}

export interface StellarWalletsKitModule {
  readonly id: "astrowallet";
  readonly name: "AstroWallet";
  readonly type: "HOT_WALLET";
  isAvailable(): Promise<boolean>;
  getAddress(): Promise<{ address: ClassicAddress }>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  signTransaction(
    xdrBase64: string,
    opts?: { networkPassphrase?: string | undefined },
  ): Promise<{ signedTxXdr: string; signerAddress: ClassicAddress }>;
  signAuthEntry(
    authEntryXdr: string,
    opts?: { validUntilLedgerSeq?: number | undefined; networkPassphrase?: string | undefined },
  ): Promise<{ signedAuthEntry: string; signerAddress: ClassicAddress }>;
  signMessage(
    message: string,
    opts?: { networkPassphrase?: string | undefined },
  ): Promise<{ signedMessage: string; signerAddress: ClassicAddress }>;
}

/**
 * Stellar Wallets Kit v2 compatible module adapter.
 */
export function createStellarWalletsKitModule(
  config: DappResponderConfig,
): StellarWalletsKitModule {
  const responder = createWalletConnectStellarResponder(config);

  return {
    id: "astrowallet",
    name: "AstroWallet",
    type: "HOT_WALLET",

    async isAvailable(): Promise<boolean> {
      try {
        const kp = await config.getKeypair();
        return Boolean(kp.publicKey());
      } catch {
        return false;
      }
    },

    async getAddress(): Promise<{ address: ClassicAddress }> {
      const kp = await config.getKeypair();
      return { address: kp.publicKey() as ClassicAddress };
    },

    async getNetwork(): Promise<{ network: string; networkPassphrase: string }> {
      return {
        network: config.network === "mainnet" ? "PUBLIC" : "TESTNET",
        networkPassphrase: config.networkPassphrase,
      };
    },

    async signTransaction(xdrBase64, opts) {
      const kp = await config.getKeypair();
      const res = (await responder.handleRequest({
        method: "stellar_signXDR",
        params: {
          xdr: xdrBase64,
          networkPassphrase: opts?.networkPassphrase,
        },
      })) as { signedXDR: string };
      return {
        signedTxXdr: res.signedXDR,
        signerAddress: kp.publicKey() as ClassicAddress,
      };
    },

    async signAuthEntry(authEntryXdr, opts) {
      const res = (await responder.handleRequest({
        method: "stellar_signAuthEntry",
        params: {
          entryXdr: authEntryXdr,
          validUntilLedgerSeq: opts?.validUntilLedgerSeq,
          networkPassphrase: opts?.networkPassphrase,
        },
      })) as { signedAuthEntry: string; signerAddress: ClassicAddress };
      return res;
    },

    async signMessage(message, opts) {
      const res = (await responder.handleRequest({
        method: "stellar_signMessage",
        params: {
          message,
          networkPassphrase: opts?.networkPassphrase,
        },
      })) as { signedMessage: string; signerAddress: ClassicAddress };
      return res;
    },
  };
}

export interface Sep43WebProvider {
  readonly providerName: "AstroWallet";
  isConnected(): Promise<boolean>;
  getAddress(): Promise<{ address: ClassicAddress }>;
  getNetwork(): Promise<{ network: string; networkPassphrase: string }>;
  signTransaction(
    xdrBase64: string,
    opts?: { networkPassphrase?: string | undefined },
  ): Promise<{ signedTxXdr: string; signerAddress: ClassicAddress }>;
  signAuthEntry(
    authEntryXdr: string,
    opts?: { validUntilLedgerSeq?: number | undefined; networkPassphrase?: string | undefined },
  ): Promise<{ signedAuthEntry: string; signerAddress: ClassicAddress }>;
  signMessage(
    message: string,
    opts?: { networkPassphrase?: string | undefined },
  ): Promise<{ signedMessage: string; signerAddress: ClassicAddress }>;
}

/**
 * Creates a SEP-43 / SEP-60 compatible browser provider interface.
 */
export function createSep43Provider(config: DappResponderConfig): Sep43WebProvider {
  const kit = createStellarWalletsKitModule(config);
  return {
    providerName: "AstroWallet",
    isConnected: () => kit.isAvailable(),
    getAddress: () => kit.getAddress(),
    getNetwork: () => kit.getNetwork(),
    signTransaction: (xdrBase64, opts) => kit.signTransaction(xdrBase64, opts),
    signAuthEntry: (authEntryXdr, opts) => kit.signAuthEntry(authEntryXdr, opts),
    signMessage: (message, opts) => kit.signMessage(message, opts),
  };
}

/**
 * Attaches the SEP-43 provider to `window.stellar` in browser environments and returns a cleanup callback.
 */
export function attachSep43WindowProvider(provider: Sep43WebProvider): () => void {
  const target = globalThis as unknown as {
    window?: { stellar?: Sep43WebProvider };
  };
  if (!target.window) {
    return () => {};
  }
  const previous = target.window.stellar;
  target.window.stellar = provider;
  return () => {
    if (!target.window) return;
    if (previous === undefined) {
      delete target.window.stellar;
    } else {
      target.window.stellar = previous;
    }
  };
}
