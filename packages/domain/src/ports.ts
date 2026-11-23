import type { AccountCapabilities, AuthMethod, LinkedAccount, StellarAddress } from "./accounts.js";
import type { StellarNetwork } from "./config.js";
import type { ScanReport } from "./security.js";

export interface SignerPort {
  getAddress(): StellarAddress;
  getCapabilities(): AccountCapabilities;
  getSupportedAuthMethods(): readonly AuthMethod[];
  signTransactionEnvelope(xdrBase64: string, networkPassphrase: string): Promise<string>;
  signAuthEntry?(authEntryXdrBase64: string, networkPassphrase: string): Promise<string>;
  signMessage?(message: string): Promise<string>;
}

export interface VaultPort {
  hasVault(): Promise<boolean>;
  unlockWithPin(pinOrPassphrase: string): Promise<readonly LinkedAccount[]>;
  lock(): void;
}

export interface AssetBalance {
  assetCode: string;
  assetIssuer?: string | undefined;
  balance: string;
  isVerifiedAsset: boolean;
  limit?: string | undefined;
  buyingLiabilities?: string | undefined;
  sellingLiabilities?: string | undefined;
  isAuthorized?: boolean | undefined;
  isAuthorizedToMaintainLiabilities?: boolean | undefined;
  isClawbackEnabled?: boolean | undefined;
  sponsor?: string | undefined;
  lastModifiedLedger?: number | undefined;
}

export interface ChainPort {
  readonly network: StellarNetwork;
  getBalances(address: StellarAddress): Promise<readonly AssetBalance[]>;
  submitTransaction(xdrBase64: string): Promise<{ hash: string; ledger: number }>;
}

export interface ScannerPort {
  scanTransactionXdr(xdrBase64: string, sourceAddress?: StellarAddress): Promise<ScanReport>;
  scanAddress(address: StellarAddress): Promise<ScanReport>;
}

export interface ThreatScannerPort {
  readonly providerName: string;
  evaluateXdr(xdrBase64: string, network: StellarNetwork): Promise<ScanReport>;
}

export interface SwapQuoteRequest {
  fromAsset: string;
  toAsset: string;
  amount: string;
  slippageBps: number;
  sourceAddress?: string | undefined;
}

export interface SwapQuote {
  provider: string;
  inputAmount: string;
  expectedOutputAmount: string;
  priceImpactPct: string;
  unsignedXdr?: string | undefined;
  pathAssets?: ReadonlyArray<{ assetCode: string; assetIssuer?: string | undefined }> | undefined;
}

export interface SwapPort {
  readonly providerName: string;
  getQuote(request: SwapQuoteRequest): Promise<SwapQuote>;
}

export interface RampQuoteRequest {
  direction: "onramp" | "offramp";
  fiatCurrency: string;
  assetCode: string;
  amount: string;
  destinationAddress: StellarAddress;
}

export interface RampPort {
  readonly providerName: string;
  createSessionUrl(request: RampQuoteRequest): Promise<{ url: string }>;
}

export interface YieldPort {
  readonly providerName: string;
  getAssetApy(assetCode: string): Promise<string>;
}
