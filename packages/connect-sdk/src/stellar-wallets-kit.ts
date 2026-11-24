import { createAstroConnectClient } from "./client.js";
import type { AstroConnectConfig } from "./types.js";

export interface StellarWalletsKitCompatibleModule {
  productId: string;
  productName: string;
  productUrl: string;
  isAvailable(): Promise<boolean>;
  getAddress(): Promise<{ address: string }>;
  signTransaction(
    xdr: string,
    opts?: {
      networkPassphrase?: string | undefined;
      address?: string | undefined;
      submit?: boolean | undefined;
      humanSummary?: string | undefined;
    },
  ): Promise<{ signedTxXdr: string; signerAddress?: string | undefined; txHash?: string | undefined }>;
  signMessage(
    message: string,
    opts?: { address?: string | undefined; humanSummary?: string | undefined },
  ): Promise<{ signedMessage: string; signerAddress?: string | undefined }>;
  signAuthEntry?(
    entryXdr: string,
    opts?: { address?: string | undefined; humanSummary?: string | undefined },
  ): Promise<{ signedAuthEntry: string; signerAddress?: string | undefined }>;
  getProviderMetadata?(): {
    id: string;
    name: string;
    standards: readonly string[];
    chains: readonly string[];
    capabilities: readonly string[];
  };
  getNetwork(): Promise<{ network: string; networkPassphrase?: string | undefined }>;
}

export interface AstroWalletKitModuleOptions extends AstroConnectConfig {
  /** Optional known Telegram user ID / @username to speed up cached address lookup. */
  defaultIdentityQuery?: string | undefined;
  /** Network passphrase label returned by `getNetwork()`. */
  networkPassphrase?: string | undefined;
}

/**
 * Drop-in adapter compatible with `@creit.tech/stellar-wallets-kit` ModuleInterface,
 * allowing any Stellar dApp inside Telegram to add AstroWallet without browser extensions.
 */
export function createAstroWalletKitModule(
  options: AstroWalletKitModuleOptions,
): StellarWalletsKitCompatibleModule {
  const client = createAstroConnectClient(options);
  let cachedAddress: string | undefined;
  let cachedNetwork: string | undefined;

  return {
    productId: "astrowallet",
    productName: "AstroWallet (Telegram)",
    productUrl: options.apiBaseUrl,

    async isAvailable() {
      return true;
    },

    async getAddress() {
      if (cachedAddress) {
        return { address: cachedAddress };
      }
      if (options.defaultIdentityQuery) {
        const resolved = await client.resolveIdentity(options.defaultIdentityQuery);
        if (resolved.found && resolved.primaryAddress) {
          cachedAddress = resolved.primaryAddress;
          return { address: resolved.primaryAddress };
        }
      }
      const login = await client.login({
        statement: `Connect your Stellar account to ${options.app.name}`,
      });
      cachedAddress = login.address;
      cachedNetwork = login.network;
      return { address: login.address };
    },

    async signTransaction(xdr, opts) {
      const submit = opts?.submit ?? false;
      const result = await client.signTransaction(xdr, {
        submit,
        humanSummary:
          opts?.humanSummary ?? `Approve transaction from ${options.app.name}`,
      });
      if (result.address) {
        cachedAddress = result.address;
      }
      cachedNetwork = result.network;
      return {
        signedTxXdr: result.signedXdr ?? xdr,
        ...(result.address ? { signerAddress: result.address } : {}),
        ...(result.txHash ? { txHash: result.txHash } : {}),
      };
    },

    async signMessage(message, opts) {
      const result = await client.signMessage(message, {
        ...(opts?.humanSummary ? { humanSummary: opts.humanSummary } : {}),
      });
      cachedAddress = result.address;
      cachedNetwork = result.network;
      return {
        signedMessage: result.signatureBase64,
        signerAddress: result.address,
      };
    },

    async signAuthEntry(entryXdr, opts) {
      const result = await client.signAuthEntry(entryXdr, {
        ...(opts?.address ? { sourceAddress: opts.address } : {}),
        humanSummary:
          opts?.humanSummary ?? `Approve Soroban authorization for ${options.app.name}`,
      });
      cachedAddress = result.address;
      cachedNetwork = result.network;
      return {
        signedAuthEntry: result.signedAuthEntry,
        signerAddress: result.address,
      };
    },

    getProviderMetadata() {
      return {
        id: "astrowallet",
        name: "AstroWallet (Telegram)",
        standards: ["SEP-43", "SEP-53", "SEP-60-draft", "AstroConnect-v1"],
        chains: ["stellar:pubnet", "stellar:testnet"],
        capabilities: ["clear_sign", "fee_bump_relay", "x402_auth_entry"],
      };
    },

    async getNetwork() {
      return {
        network: (cachedNetwork ?? "testnet").toUpperCase(),
        ...(options.networkPassphrase
          ? { networkPassphrase: options.networkPassphrase }
          : {}),
      };
    },
  };
}
