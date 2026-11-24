export type AstroNetwork = "testnet" | "mainnet";
export type ConnectActionType = "auth" | "sign_xdr" | "sign_message" | "sign_auth_entry";
export type ConnectRequestStatus = "pending" | "approved" | "rejected" | "expired";
export type ConnectTrustTier = "official" | "verified" | "external";

export interface ConnectAppInfo {
  name: string;
  botUsername: string;
  miniAppShortName?: string | undefined;
  returnStartAppParam?: string | undefined;
  iconUrl?: string | undefined;
  origin?: string | undefined;
}

export interface AstroConnectConfig {
  /** Base URL of the AstroWallet server / Pages origin (or "" for same-origin Worker proxy). */
  apiBaseUrl: string;
  /** Calling dApp identity metadata displayed in AstroWallet Clear-Sign UI and Boomerang CTA. */
  app: ConnectAppInfo;
  /** Optional custom fetch implementation (defaults to globalThis.fetch). */
  fetchFn?: typeof fetch | undefined;
  /** Optional custom deep-link opener (defaults to Telegram.WebApp.openTelegramLink or window.open). */
  openLinkFn?: ((deepLink: string) => void) | undefined;
  /** Optional shared secret for official ASTRO ecosystem apps. */
  ecosystemSecret?: string | undefined;
  /** Optional path override for connect requests (default: "/v1/connect/requests"). */
  requestsPathPrefix?: string | undefined;
  /** Optional path override for AstroID resolution (default: "/v1/identity/resolve"). */
  identityPathPrefix?: string | undefined;
  /** Optional path override for Scan & Shield (default: "/v1/connect/scan"). */
  scanPath?: string | undefined;
}

export interface ConnectAccountSummary {
  address: string;
  kind: "classic" | "smart";
  label: string;
  isDefault: boolean;
}

export interface ConnectResult {
  status: "approved" | "rejected";
  reason?: string | undefined;
  address?: string | undefined;
  accounts?: ConnectAccountSummary[] | undefined;
  telegramUserId?: string | undefined;
  username?: string | undefined;
  signedMessage?: string | undefined;
  signatureBase64?: string | undefined;
  signedXdr?: string | undefined;
  signedAuthEntry?: string | undefined;
  txHash?: string | undefined;
  ledger?: number | undefined;
  completedAt: number;
}

export interface ConnectRequestHandle {
  requestId: string;
  network: AstroNetwork;
  action: ConnectActionType;
  trustTier: ConnectTrustTier;
  sig: string;
  resultToken: string;
  expiresAt: number;
  deepLink: string;
  challengeMessage?: string | undefined;
}

export interface ConnectStatusResponse {
  ok: true;
  requestId: string;
  network: AstroNetwork;
  action: ConnectActionType;
  status: ConnectRequestStatus;
  trustTier: ConnectTrustTier;
  expiresAt: number;
  result?: ConnectResult | undefined;
}

export interface WaitOptions {
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
  /** Defaults to true: automatically opens `deepLink` in Telegram before polling. */
  autoOpen?: boolean | undefined;
}

export interface LoginOptions extends WaitOptions {
  nonce?: string | undefined;
  statement?: string | undefined;
  domain?: string | undefined;
  includeAccounts?: boolean | undefined;
  ttlSeconds?: number | undefined;
}

export interface LoginResult {
  requestId: string;
  network: AstroNetwork;
  address: string;
  accounts: ConnectAccountSummary[];
  telegramUserId?: string | undefined;
  username?: string | undefined;
  challengeMessage: string;
  signatureBase64: string;
  completedAt: number;
}

export interface SignTransactionOptions extends WaitOptions {
  humanSummary: string;
  submit?: boolean | undefined;
  subAction?: string | undefined;
  sourceAddress?: string | undefined;
  ttlSeconds?: number | undefined;
}

export interface SignTransactionResult {
  requestId: string;
  network: AstroNetwork;
  address?: string | undefined;
  signedXdr?: string | undefined;
  txHash?: string | undefined;
  ledger?: number | undefined;
  completedAt: number;
}

export interface SignMessageOptions extends WaitOptions {
  humanSummary?: string | undefined;
  ttlSeconds?: number | undefined;
}

export interface SignMessageResult {
  requestId: string;
  network: AstroNetwork;
  address: string;
  message: string;
  signatureBase64: string;
  completedAt: number;
}

export interface SignAuthEntryOptions extends WaitOptions {
  humanSummary?: string | undefined;
  subAction?: string | undefined;
  sourceAddress?: string | undefined;
  ttlSeconds?: number | undefined;
}

export interface SignAuthEntryResult {
  requestId: string;
  network: AstroNetwork;
  address: string;
  signedAuthEntry: string;
  completedAt: number;
}

export interface AstroIdentity {
  found: boolean;
  telegramUserId?: string | undefined;
  username?: string | undefined;
  primaryAddress?: string | undefined;
  accounts: ConnectAccountSummary[];
}

export interface IntentTokenClaims {
  intentId: string;
  network: AstroNetwork;
  telegramUserId: string;
  expiresAt: number;
}

export type VerifyIntentResult =
  | { valid: true }
  | { valid: false; reason: "malformed" | "expired" | "invalid_signature" };

export interface CrossAppIntentEnvelopeV1 {
  originApp: string;
  subAction: string;
  humanSummary: string;
  unsignedXdr: string;
  xdrSha256: string;
  returnStartAppParam?: string | undefined;
  fromAsset?: string | undefined;
  toAsset?: string | undefined;
  amount?: string | undefined;
  expectedOutputAmount?: string | undefined;
  provider?: string | undefined;
  priceImpactPct?: string | undefined;
}

export interface UniversalScanFinding {
  code: string;
  severity: "info" | "warning" | "critical";
  title: string;
  description: string;
  blocksSigning?: boolean | undefined;
}

export interface UniversalScanReport {
  verdict: "safe" | "warning" | "malicious";
  requiresMemoCheck?: boolean | undefined;
  findings: UniversalScanFinding[];
}
