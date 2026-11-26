import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  defaultCapabilitiesForKind,
  type ClassicAddress,
  type ContractAddress,
  type LinkedAccount,
  type PwaConfig,
  type ScanReport,
  type StellarAddress,
  type TonAccountSummary,
} from "@astrowallet/domain";
import {
  fetchSep42VerifiedAssets,
  scanTransactionEnvelopeXdr,
  type VerifiedAssetEntry,
} from "@astrowallet/security-shield";
import { formatSmartAccountLinkMessage } from "@astrowallet/tg-protocol";
import { reportTelemetryEvent } from "./telemetry.js";
import {
  AGENT_DERIVATION_INDEX,
  clearPinLockoutState,
  clearSessionLeaseKey,
  createSorobanDevClient,
  createStellarClient,
  decryptVaultPayload,
  deleteEncryptedVault,
  deriveCounterfactualSmartAccount,
  deriveKeyInWorker,
  deriveStellarAccount,
  disableFingerprintUnlock,
  encryptVaultPayload,
  enqueueAccountTx as enqueueSharedAccountTx,
  enrollFingerprintUnlock,
  evaluateCloudBackupSecretStrength,
  fetchHeldAssetsTomlMetadata,
  getExistingSessionLeaseKey,
  getOrCreateSessionLeaseKey,
  getPinLockoutState,
  isFingerprintSupported,
  loadBiometricRecord,
  loadContacts,
  loadEncryptedVault,
  loadVaultCloudMeta,
  parseAgVaultBackup,
  parseExternalSecretAccount,
  publicKeyToRawHex,
  recordFailedPinAttempt,
  saveContacts,
  saveEncryptedVault,
  saveVaultCloudMeta,
  serializeAgVaultBackup,
  signChallengeMessage,
  signSep10ChallengeTransaction,
  signSorobanAuthEntry,
  signTransactionXdrEnvelope,
  signX402ChallengeWithKeypair,
  unlockWithFingerprint,
  validateMnemonicPhrase,
  type AccountTradeRecord,
  type ClaimableBalanceRecord,
  type ContactEntry,
  type DevTemplateKind,
  type HeldTokenTomlMetadata,
  type RecentPaymentRecord,
  type RelayIntentAuth,
  type SdexOfferRecord,
  type SorobanInvokeResult,
  type SorobanSimulationSummary,
  type SorobanTelemetry,
  type StellarAccountState,
  type TypedMemoInput,
  type VaultAccountMetadata,
} from "@astrowallet/stellar-core";
import type {
  TonAccountChainState,
  TonConnectRequestItem,
  TonPayloadClassification,
  TonWalletVersion,
} from "@astrowallet/ton-core";

function loadTonCoreRaw() {
  return import("@astrowallet/ton-core");
}
let tonCorePromise: ReturnType<typeof loadTonCoreRaw> | null = null;
function loadTonCore() {
  tonCorePromise ??= loadTonCoreRaw();
  return tonCorePromise;
}
import {
  authenticateTelegramBiometric,
  getTelegramWebApp,
  isTelegramBiometricAvailable,
  tgSecureStorageGet,
  tgSecureStorageRemove,
  tgSecureStorageSet,
  triggerTelegramHaptic,
  updateTelegramBiometricToken,
} from "../telegram/webapp.js";
import {
  inspectDappAuthEntrySecurity,
  sessionVault,
  type DappAuthEntryInspection,
} from "./session-vault.js";
import {
  clearAllTonConnectSessions,
  loadTonConnectSessions,
  removeTonConnectSession,
  saveTonConnectSession,
  type StoredTonConnectSession,
} from "./ton-connect-store.js";
import { readCachedEntry, writeCachedEntry } from "./market-cache.js";
import { clearCachedClaimSecret } from "../components/deep-link-routes.js";

function stripImportedSecrets(
  accounts: readonly VaultAccountMetadata[],
): VaultAccountMetadata[] {
  return accounts.map(({ importedSecret: _omitted, ...rest }) => rest);
}

const EXPRESS_SESSION_TTL_KEY = "aw_express_session_ttl_min";
const DEFAULT_EXPRESS_SESSION_MINUTES = 15;
const TG_SESSION_LEASE_KEY = "aw_session_lease_v1";
const TG_SESSION_LEASE_KEY_V2 = "aw_session_lease_v2";
const TG_BIO_WRAP_KEY_V2 = "aw_bio_wrap_v2";
const TON_WALLET_VERSION_KEY = "aw_ton_wallet_version_v1";

function bytesToB64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) {
    bin += String.fromCharCode(b);
  }
  return btoa(bin);
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim().toLowerCase();
  if (!/^[a-f0-9]+$/.test(clean) || clean.length % 2 !== 0) {
    throw new Error("Invalid hex key");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function sha256HexText(raw: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw));
  return bytesToHex(new Uint8Array(digest));
}

async function importBioWrapAesKey(hexKey: string): Promise<CryptoKey> {
  const raw = hexToBytes(hexKey);
  if (raw.length !== 32) {
    throw new Error("Biometric token key must be 256-bit");
  }
  return crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

async function sealWithAesGcmKey(
  key: CryptoKey,
  plaintext: string,
): Promise<{ ivB64: string; ctB64: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encoded = new TextEncoder().encode(plaintext);
  const ctBuf = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    encoded as BufferSource,
  );
  encoded.fill(0);
  return {
    ivB64: bytesToB64(iv),
    ctB64: bytesToB64(new Uint8Array(ctBuf)),
  };
}

async function unsealWithAesGcmKey(
  key: CryptoKey,
  wrapped: { ivB64: string; ctB64: string },
): Promise<string> {
  const iv = b64ToBytes(wrapped.ivB64);
  const ct = b64ToBytes(wrapped.ctB64);
  const ptBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: iv as BufferSource },
    key,
    ct as BufferSource,
  );
  return new TextDecoder().decode(new Uint8Array(ptBuf));
}

function readPersistedTonWalletVersion(scopeId?: string): TonWalletVersion {
  if (typeof window === "undefined") return "v4r2";
  try {
    const key = scopeId ? `${TON_WALLET_VERSION_KEY}:${scopeId}` : TON_WALLET_VERSION_KEY;
    const raw = window.localStorage.getItem(key);
    return raw === "v5r1" ? "v5r1" : "v4r2";
  } catch {
    return "v4r2";
  }
}

function readExpressSessionMinutes(): number {
  if (typeof window === "undefined") return DEFAULT_EXPRESS_SESSION_MINUTES;
  try {
    const raw = window.localStorage.getItem(EXPRESS_SESSION_TTL_KEY);
    if (raw === null) return DEFAULT_EXPRESS_SESSION_MINUTES;
    const n = Number(raw);
    return n === 0 || n === 15 || n === 30 || n === 60 ? n : DEFAULT_EXPRESS_SESSION_MINUTES;
  } catch {
    return DEFAULT_EXPRESS_SESSION_MINUTES;
  }
}

export type VaultStatus = "loading" | "uninitialized" | "locked" | "unlocked";

export interface ToastMessage {
  id: number;
  kind: "success" | "info" | "error";
  message: string;
}

export interface TonConnectPairingPreview {
  uri: string;
  dappClientId: string;
  dappName: string;
  dappUrl: string;
  manifestUrl: string;
  domainForProof: string;
  hasTonProof: boolean;
  originVerified: boolean;
  tonProofPayload?: string | undefined;
  items: TonConnectRequestItem[];
}

export interface PendingTonConnectTxRequest {
  requestId: string;
  walletClientId: string;
  dappClientId: string;
  dappName: string;
  dappUrl: string;
  connectedAddress: string;
  validUntil: number;
  messages: Array<{
    address: string;
    amountNano: bigint;
    payload?: string | undefined;
    stateInit?: string | undefined;
    classification: TonPayloadClassification;
  }>;
}

const TG_SECURE_PIN_KEY = "aw_tg_bio_pin";

export interface SendPaymentParams {
  destination: StellarAddress;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  memoText?: string | undefined;
  typedMemo?: TypedMemoInput | undefined;
}

export type SignedConnectAccountProof =
  | {
      address: ClassicAddress;
      kind: "classic";
      label: string;
      isDefault: boolean;
      signatureBase64: string;
    }
  | {
      address: ContractAddress;
      kind: "smart";
      label: string;
      isDefault: boolean;
      guardianAddress: ClassicAddress;
      signatureBase64: string;
    };

export interface PlaceSdexOfferParams {
  sellingCode: string;
  sellingIssuer?: ClassicAddress | undefined;
  buyingCode: string;
  buyingIssuer?: ClassicAddress | undefined;
  amount: string;
  price: string;
  offerId?: string | undefined;
}

export interface ExecutePathSwapParams {
  sendAssetCode: string;
  sendAssetIssuer?: ClassicAddress | undefined;
  sendAmount: string;
  destAssetCode: string;
  destAssetIssuer?: ClassicAddress | undefined;
  destMin: string;
  path?: ReadonlyArray<{ assetCode: string; assetIssuer?: string | undefined }> | undefined;
}

export interface DerivedPublicKeyPreview {
  index: number;
  derivationPath: string;
  publicKey: ClassicAddress;
  rawHex: string;
  counterfactualSmartAddress?: string | undefined;
}

export interface WalletContextValue {
  config: PwaConfig;
  vaultStatus: VaultStatus;
  accounts: readonly LinkedAccount[];
  activeAccount: LinkedAccount | null;
  activeIndex: number;
  accountState: StellarAccountState | null;
  recentPayments: readonly RecentPaymentRecord[];
  recentTrades: readonly AccountTradeRecord[];
  claimableBalances: readonly ClaimableBalanceRecord[];
  openOffers: readonly SdexOfferRecord[];
  contacts: readonly ContactEntry[];
  toast: ToastMessage | null;
  loadingChain: boolean;
  chainError: string | null;
  fingerprintSupported: boolean;
  fingerprintEnrolled: boolean;
  telegramBioAvailable: boolean;
  verifiedAssets: readonly VerifiedAssetEntry[];
  tokenMetaMap: Readonly<Record<string, HeldTokenTomlMetadata>>;
  tonAccount: TonAccountSummary | null;
  tonWalletVersion: TonWalletVersion;
  tonState: TonAccountChainState | null;
  loadingTonChain: boolean;
  tonChainError: string | null;
  tonConnectSessions: readonly StoredTonConnectSession[];
  pendingTonConnectTx: PendingTonConnectTxRequest | null;
  localVaultUpdatedAt: number | null;
  cloudSyncEligible: boolean;
  storageScopeId: string | undefined;

  setActiveIndex(index: number): void;
  setTonWalletVersion(version: TonWalletVersion): void;
  ensureTonAccount(): Promise<TonAccountSummary | null>;
  showToast(message: string, kind?: "success" | "info" | "error"): void;
  dismissToast(): void;
  createOrImportVault(
    mnemonic: string,
    pinOrPassphrase: string,
    initialLabel?: string,
  ): Promise<{ envelopeJson: string }>;
  reEncryptLocalVault(
    currentPin: string,
    newPinOrPassphrase: string,
  ): Promise<{ envelopeJson: string }>;
  restoreAgVaultJson(rawJson: string, pinOrPassphrase: string): Promise<void>;
  syncFromNewerCloudBackup(rawJson: string): Promise<{
    status: "synced" | "push_merged" | "pin_required" | "up_to_date" | "wallet_mismatch";
    envelopeJson?: string | undefined;
    accountCount?: number | undefined;
  }>;
  exportAgVaultJson(): Promise<string>;
  exportCloudBackupJson(): Promise<string>;
  revealMnemonicWithPin(pinOrPassphrase: string): Promise<string>;
  verifyPinOrPassphrase(pinOrPassphrase: string): Promise<void>;
  verifyBiometricReauth(reason?: string): Promise<void>;
  unlockWithPin(pinOrPassphrase: string): Promise<void>;
  unlockWithBiometric(): Promise<void>;
  expressSessionMinutes: number;
  setExpressSessionMinutes(minutes: 0 | 15 | 30 | 60): void;
  enableFingerprint(pinOrPassphrase: string): Promise<{ enrolled: boolean; message: string }>;
  disableFingerprint(): Promise<void>;
  addDerivedAccount(label: string, pinOrPassphrase: string): Promise<LinkedAccount>;
  activateDerivedAccountAtIndex(
    index: number,
    label: string,
    pinOrPassphrase: string,
  ): Promise<LinkedAccount>;
  importExternalSecretAccount(
    secretSeed: string,
    label: string,
    pinOrPassphrase: string,
  ): Promise<LinkedAccount>;
  isImportedAccount(address: string): boolean;
  renameDerivedAccount(index: number, newLabel: string, pinOrPassphrase: string): Promise<void>;
  lockVault(): void;
  wipeLocalVault(): Promise<void>;
  saveContact(input: {
    label: string;
    address: string;
    defaultMemo?: string | undefined;
  }): Promise<ContactEntry>;
  deleteContact(id: string): Promise<void>;
  refreshChainState(): Promise<void>;
  refreshTonState(): Promise<void>;
  fundActiveTestnetAccount(): Promise<void>;
  fundAnyTestnetAddress(address: ClassicAddress): Promise<void>;
  sendPayment(params: SendPaymentParams): Promise<{ hash: string; ledger: number }>;
  sendTonPayment(params: {
    destination: string;
    amountTon: string;
    comment?: string | undefined;
  }): Promise<{ hash: string; bocBase64: string }>;
  previewTonConnectUri(uri: string): Promise<TonConnectPairingPreview>;
  approveTonConnectPairing(preview: TonConnectPairingPreview): Promise<StoredTonConnectSession>;
  pairTonConnectUri(uri: string): Promise<StoredTonConnectSession>;
  disconnectTonConnectSession(walletClientId: string): Promise<void>;
  resolvePendingTonConnectTx(approved: boolean): Promise<void>;
  executePathSwap(params: ExecutePathSwapParams): Promise<{ hash: string; ledger: number }>;
  submitAccountDataEntry(name: string, value: string | null): Promise<{ hash: string; ledger: number }>;
  addOrRemoveTrustline(
    assetCode: string,
    assetIssuer: ClassicAddress,
    limit?: string,
  ): Promise<{ hash: string; ledger: number }>;
  reclaimZeroBalanceReserves(): Promise<{ hash: string; ledger: number; reclaimedXlm: string }>;
  claimBalanceById(balanceId: string): Promise<{ hash: string; ledger: number }>;
  placeSdexOffer(params: PlaceSdexOfferParams): Promise<{ hash: string; ledger: number }>;
  signRawXdrWithShield(
    xdrBase64: string,
    allowWarning?: boolean,
  ): Promise<{ signedXdr: string; scanReport: ScanReport }>;
  signAndSubmitRawXdrWithShield(
    xdrBase64: string,
    allowWarning?: boolean,
    intentAuth?: RelayIntentAuth,
  ): Promise<{
    hash: string;
    ledger: number;
    signedXdr: string;
    channel: "soroban-rpc" | "horizon";
  }>;
  fetchDevTelemetry(): Promise<SorobanTelemetry>;
  simulateSorobanCall(params: {
    contractId: ContractAddress;
    fnName: string;
    argsJson: string;
  }): Promise<SorobanSimulationSummary>;
  invokeSorobanWrite(params: {
    contractId: ContractAddress;
    fnName: string;
    argsJson: string;
  }): Promise<SorobanInvokeResult>;
  simulateRawXdr(xdrBase64: string): Promise<SorobanSimulationSummary>;
  buildDevTemplateXdr(template: DevTemplateKind): Promise<string>;
  derivePublicKeyPreview(count: number): DerivedPublicKeyPreview[];
  deriveAgentAccountAddress(): ClassicAddress | null;
  signAgentX402Challenge(challenge: {
    x402Version: number;
    network: string;
    asset: string;
    amount: string;
    payTo: string;
    nonce: string;
  }): {
    payer: string;
    signingPayload: string;
    signatureBase64: string;
    paymentHeader: string;
  };
  signSep10ChallengeXdr(challengeXdr: string): Promise<string>;
  signActiveSep53Message(message: string): Promise<{ signature: string; signerAddress: ClassicAddress }>;
  signAuthEntryWithShield(
    entryXdr: string,
    allowWarning?: boolean,
  ): Promise<{
    signedAuthEntry: string;
    signerAddress: ClassicAddress;
    inspection: DappAuthEntryInspection;
  }>;
  bootstrapActiveAccount(
    sessionToken: string,
  ): Promise<{ hash?: string | undefined; address: ClassicAddress; status: string }>;
  signConnectChallenge(
    message: string,
    selectedIndices: readonly number[],
    includePairedSmartAccount?: boolean,
    preferredDefaultAddress?: string,
  ): Promise<SignedConnectAccountProof[]>;
  fundClaimEscrow(params: {
    escrowContractId: ContractAddress;
    claimIdHex: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string | undefined;
    expiresAtUnix: number;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{
    hash: string;
    ledger: number;
    claimSecretSeedHex: string;
    expiresAtUnix: number;
  }>;
  claimFromEscrow(params: {
    escrowContractId: ContractAddress;
    claimIdHex: string;
    claimSecretSeedHex: string;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  cancelClaimEscrow(params: {
    escrowContractId: ContractAddress;
    claimIdHex: string;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }>;
  refundExpiredClaimEscrow(params: {
    escrowContractId: ContractAddress;
    claimIdHex: string;
    recipientAddress?: StellarAddress | undefined;
    intentAuth?: RelayIntentAuth | undefined;
  }): Promise<{ hash: string; ledger: number }>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

function resolveWebAuthnRpId(pwaOrigin: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  const currentHost = window.location.hostname;
  try {
    const configuredHost = new URL(pwaOrigin).hostname;
    if (currentHost === configuredHost || currentHost.endsWith(`.${configuredHost}`)) {
      return configuredHost;
    }
  } catch {
    // Fallback to active browser hostname
  }
  return currentHost || undefined;
}

function toLinkedAccounts(metaList: readonly VaultAccountMetadata[]): LinkedAccount[] {
  return metaList.map((meta) => ({
    id: `classic-${meta.index}`,
    address: meta.address as ClassicAddress,
    kind: "classic",
    label: meta.label,
    derivationIndex: meta.index,
    capabilities: defaultCapabilitiesForKind("classic"),
  }));
}

function resolveTonDerivationIndex(
  activeAccount: { derivationIndex?: number | undefined } | null | undefined,
  activeIndex: number,
): number {
  const idx = activeAccount?.derivationIndex ?? activeIndex;
  return idx !== undefined && idx < 1000 ? idx : 0;
}

export function WalletProvider({
  config,
  storageScopeId,
  sessionToken,
  children,
}: {
  config: PwaConfig;
  storageScopeId?: string | undefined;
  sessionToken?: string | null | undefined;
  children: ReactNode;
}) {
  const sessionTokenRef = useRef<string | null>(sessionToken ?? null);
  sessionTokenRef.current = sessionToken ?? null;
  const cleanScopeId = storageScopeId?.trim() || undefined;
  const securePinKey = cleanScopeId ? `${TG_SECURE_PIN_KEY}:${cleanScopeId}` : TG_SECURE_PIN_KEY;
  const bioWrapKey = cleanScopeId ? `${TG_BIO_WRAP_KEY_V2}:${cleanScopeId}` : TG_BIO_WRAP_KEY_V2;
  const sessionLeaseKey = cleanScopeId
    ? `${TG_SESSION_LEASE_KEY}:${cleanScopeId}`
    : TG_SESSION_LEASE_KEY;
  const sessionLeaseKeyV2 = cleanScopeId
    ? `${TG_SESSION_LEASE_KEY_V2}:${cleanScopeId}`
    : TG_SESSION_LEASE_KEY_V2;

  const [expressSessionMinutes, setExpressSessionMinutesState] = useState<number>(
    readExpressSessionMinutes,
  );
  const [tonWalletVersion, setTonWalletVersionState] = useState<TonWalletVersion>(() =>
    readPersistedTonWalletVersion(cleanScopeId),
  );
  const tonWalletVersionRef = useRef<TonWalletVersion>(tonWalletVersion);
  tonWalletVersionRef.current = tonWalletVersion;

  const [cloudSyncEligible, setCloudSyncEligible] = useState<boolean>(false);
  const cloudSyncEligibleRef = useRef<boolean>(cloudSyncEligible);
  cloudSyncEligibleRef.current = cloudSyncEligible;

  // Kept strictly in process memory for same-session CRDT cloud backup merge; NEVER written to storage.
  const inMemorySessionPinRef = useRef<string | null>(null);
  const inMemoryLeaseExpiresAtRef = useRef<number | null>(null);
  const accountMetaListRef = useRef<VaultAccountMetadata[]>([]);
  const expressSessionMinutesRef = useRef(expressSessionMinutes);
  expressSessionMinutesRef.current = expressSessionMinutes;

  const markCloudGradeSecret = useCallback(
    async (acceptable: boolean, syncedSha256?: string) => {
      setCloudSyncEligible(acceptable);
      cloudSyncEligibleRef.current = acceptable;
      await saveVaultCloudMeta(
        {
          cloudGradeSecret: acceptable,
          ...(syncedSha256 ? { lastSyncedCloudSha256: syncedSha256 } : {}),
          updatedAt: Math.floor(Date.now() / 1000),
        },
        cleanScopeId,
      ).catch(() => undefined);
    },
    [cleanScopeId],
  );

  const clearSessionLease = useCallback(() => {
    inMemoryLeaseExpiresAtRef.current = null;
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(sessionLeaseKey);
        window.sessionStorage.removeItem(sessionLeaseKeyV2);
      }
    } catch {
      // Ignore
    }
    void tgSecureStorageRemove(sessionLeaseKey).catch(() => false);
    void tgSecureStorageRemove(sessionLeaseKeyV2).catch(() => false);
    void clearSessionLeaseKey(cleanScopeId).catch(() => undefined);
  }, [sessionLeaseKey, sessionLeaseKeyV2, cleanScopeId]);

  const setExpressSessionMinutes = useCallback(
    (minutes: 0 | 15 | 30 | 60) => {
      setExpressSessionMinutesState(minutes);
      expressSessionMinutesRef.current = minutes;
      try {
        if (typeof window !== "undefined") {
          window.localStorage.setItem(EXPRESS_SESSION_TTL_KEY, String(minutes));
        }
      } catch {
        // Ignore storage errors
      }
      if (minutes === 0) {
        clearSessionLease();
      }
    },
    [clearSessionLease],
  );

  const saveSessionLease = useCallback(
    async (
      pinForRamOnly?: string,
      accountsOverride?: readonly VaultAccountMetadata[],
      cloudGradeOverride?: boolean,
    ) => {
      if (pinForRamOnly !== undefined) {
        inMemorySessionPinRef.current = pinForRamOnly;
      }
      // Never persist plaintext PINs or Recovery Passwords in sessionStorage or SecureStorage
      try {
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(sessionLeaseKey);
          window.sessionStorage.removeItem(sessionLeaseKeyV2);
        }
      } catch {
        // Ignore
      }
      void tgSecureStorageRemove(sessionLeaseKey).catch(() => false);

      if (expressSessionMinutesRef.current <= 0 || !sessionVault.has()) {
        clearSessionLease();
        return;
      }

      const expiresAt = Date.now() + expressSessionMinutesRef.current * 60 * 1000;
      inMemoryLeaseExpiresAtRef.current = expiresAt;
      try {
        const leaseKey = await getOrCreateSessionLeaseKey(cleanScopeId);
        if (!leaseKey) return;
        const secretsMap = sessionVault.exportImportedSecrets();
        const metaSource = accountsOverride ?? accountMetaListRef.current;
        const accountsWithSecrets: VaultAccountMetadata[] = metaSource.map((acc) => {
          const importedSecret = acc.importedSecret ?? secretsMap[acc.address];
          return importedSecret ? { ...acc, importedSecret } : { ...acc };
        });
        const mnemonic = sessionVault.withMnemonic((m) => m);
        const sealed = await sealWithAesGcmKey(
          leaseKey,
          JSON.stringify({
            v: 2,
            mnemonic,
            accounts: accountsWithSecrets,
            cloudGradeSecret: cloudGradeOverride ?? cloudSyncEligibleRef.current,
            expiresAt,
          }),
        );
        await tgSecureStorageSet(
          sessionLeaseKeyV2,
          JSON.stringify({ v: 2, ...sealed, expiresAt }),
        ).catch(() => false);
      } catch {
        // Best-effort encrypted session lease
      }
    },
    [cleanScopeId, sessionLeaseKey, sessionLeaseKeyV2, clearSessionLease],
  );

  const loadValidSessionLease = useCallback(async (): Promise<{
    mnemonic: string;
    accounts: VaultAccountMetadata[];
    cloudGradeSecret: boolean;
    expiresAt: number;
  } | null> => {
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(sessionLeaseKey);
        window.sessionStorage.removeItem(sessionLeaseKeyV2);
      }
    } catch {
      // Ignore
    }
    void tgSecureStorageRemove(sessionLeaseKey).catch(() => false);

    try {
      const raw = await tgSecureStorageGet(sessionLeaseKeyV2).catch(() => null);
      if (!raw) {
        return null;
      }
      const parsed = JSON.parse(raw) as {
        v?: unknown;
        ivB64?: unknown;
        ctB64?: unknown;
        expiresAt?: unknown;
      };
      if (
        parsed.v !== 2 ||
        typeof parsed.ivB64 !== "string" ||
        typeof parsed.ctB64 !== "string" ||
        typeof parsed.expiresAt !== "number" ||
        Date.now() >= parsed.expiresAt
      ) {
        clearSessionLease();
        return null;
      }
      const leaseKey = await getExistingSessionLeaseKey(cleanScopeId);
      if (!leaseKey) {
        clearSessionLease();
        return null;
      }
      const plaintext = await unsealWithAesGcmKey(leaseKey, {
        ivB64: parsed.ivB64,
        ctB64: parsed.ctB64,
      });
      const payload = JSON.parse(plaintext) as {
        v?: unknown;
        mnemonic?: unknown;
        accounts?: unknown;
        cloudGradeSecret?: unknown;
        expiresAt?: unknown;
      };
      if (
        payload.v !== 2 ||
        typeof payload.mnemonic !== "string" ||
        !Array.isArray(payload.accounts) ||
        typeof payload.expiresAt !== "number" ||
        Date.now() >= payload.expiresAt
      ) {
        clearSessionLease();
        return null;
      }
      inMemoryLeaseExpiresAtRef.current = payload.expiresAt;
      return {
        mnemonic: payload.mnemonic,
        accounts: payload.accounts as VaultAccountMetadata[],
        cloudGradeSecret: Boolean(payload.cloudGradeSecret),
        expiresAt: payload.expiresAt,
      };
    } catch {
      clearSessionLease();
      return null;
    }
  }, [cleanScopeId, sessionLeaseKey, sessionLeaseKeyV2, clearSessionLease]);
  const relaySubmitter = useMemo(
    () =>
      config.apiBaseUrl
        ? async ({
            signedTxXdrBase64,
            sourceKeypair,
            intentAuth,
          }: {
            signedTxXdrBase64: string;
            sourceKeypair: ReturnType<ReturnType<typeof deriveStellarAccount>["toKeypair"]>;
            intentAuth?: RelayIntentAuth | undefined;
          }) => {
            const apiBase = config.apiBaseUrl.replace(/\/+$/, "");
            const rawPayload = signedTxXdrBase64;
            const digest = await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(rawPayload),
            );
            const payloadHash = Array.from(new Uint8Array(digest), (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
            const timestamp = Math.floor(Date.now() / 1000);
            const nonceBytes = new Uint8Array(12);
            crypto.getRandomValues(nonceBytes);
            const nonce = Array.from(nonceBytes, (b) =>
              b.toString(16).padStart(2, "0"),
            ).join("");
            const challenge = `astrowallet-relay:v1:${config.network}:feebump:${payloadHash}:${timestamp}:${nonce}`;
            const signatureBase64 = signChallengeMessage(sourceKeypair, challenge);
            const res = await fetch(`${apiBase}/v1/relay/submit`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Astro-Network": config.network,
              },
              body: JSON.stringify({
                mode: "feebump",
                signedTxXdrBase64: rawPayload,
                ...(intentAuth ? { intentAuth } : {}),
                walletAuth: {
                  address: sourceKeypair.publicKey() as ClassicAddress,
                  timestamp,
                  nonce,
                  payloadHash,
                  signatureBase64,
                },
              }),
            });
            if (!res.ok) {
              return null;
            }
            const body = (await res.json()) as {
              hash?: string;
              txHash?: string;
            };
            const txHash = (body.hash ?? body.txHash ?? "").trim();
            return txHash ? { hash: txHash } : null;
          }
        : undefined,
    [config.apiBaseUrl, config.network],
  );
  const stellarClient = useMemo(
    () =>
      createStellarClient({
        ...config,
        sorobanMaxResourceFeeStroops: config.sorobanMaxResourceFeeStroops,
        relaySubmitter,
      }),
    [config, relaySubmitter],
  );
  const sorobanDevClient = useMemo(
    () =>
      createSorobanDevClient({
        rpcUrls: config.rpcUrls,
        horizonUrls: config.horizonUrls,
        networkPassphrase: config.networkPassphrase,
        maxResourceFeeStroops: config.sorobanMaxResourceFeeStroops,
        relaySubmitter,
      }),
    [
      config.rpcUrls,
      config.horizonUrls,
      config.networkPassphrase,
      config.sorobanMaxResourceFeeStroops,
      relaySubmitter,
    ],
  );

  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("loading");
  const tonConnectResolvingRef = useRef(false);
  const processedTonEventIdsRef = useRef<Set<string>>(new Set());
  const [accountMetaList, setAccountMetaList] = useState<VaultAccountMetadata[]>([]);
  accountMetaListRef.current = accountMetaList;
  const [activeIndex, setActiveIndex] = useState<number>(0);

  const [rawAccountState, setRawAccountState] = useState<StellarAccountState | null>(null);
  const [recentPayments, setRecentPayments] = useState<RecentPaymentRecord[]>([]);
  const [recentTrades, setRecentTrades] = useState<AccountTradeRecord[]>([]);
  const [claimableBalances, setClaimableBalances] = useState<ClaimableBalanceRecord[]>([]);
  const [openOffers, setOpenOffers] = useState<SdexOfferRecord[]>([]);
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [loadingChain, setLoadingChain] = useState<boolean>(false);
  const [chainError, setChainError] = useState<string | null>(null);

  const [fingerprintSupported, setFingerprintSupported] = useState<boolean>(false);
  const [fingerprintEnrolled, setFingerprintEnrolled] = useState<boolean>(false);
  const [telegramBioAvailable, setTelegramBioAvailable] = useState<boolean>(false);
  const [verifiedAssets, setVerifiedAssets] = useState<readonly VerifiedAssetEntry[]>([]);
  const accountState = useMemo<StellarAccountState | null>(() => {
    if (!rawAccountState) return null;
    if (!rawAccountState.funded || verifiedAssets.length === 0) return rawAccountState;
    const verifiedSet = new Set(
      verifiedAssets.map((v) => `${v.code.toUpperCase()}:${v.issuer}`),
    );
    return {
      ...rawAccountState,
      balances: rawAccountState.balances.map((b) => ({
        ...b,
        isVerifiedAsset:
          b.isVerifiedAsset ||
          (b.assetCode === "XLM" && !b.assetIssuer) ||
          (Boolean(b.assetIssuer) &&
            verifiedSet.has(`${b.assetCode.toUpperCase()}:${b.assetIssuer}`)),
      })),
    };
  }, [rawAccountState, verifiedAssets]);
  const [tokenMetaMap, setTokenMetaMap] = useState<Readonly<Record<string, HeldTokenTomlMetadata>>>(
    {},
  );

  const [tonState, setTonState] = useState<TonAccountChainState | null>(null);
  const [loadingTonChain, setLoadingTonChain] = useState<boolean>(false);
  const [tonChainError, setTonChainError] = useState<string | null>(null);
  const [tonConnectSessions, setTonConnectSessions] = useState<StoredTonConnectSession[]>([]);
  const [pendingTonConnectTx, setPendingTonConnectTx] =
    useState<PendingTonConnectTxRequest | null>(null);
  const [localVaultUpdatedAt, setLocalVaultUpdatedAt] = useState<number | null>(null);
  const tonConnectSessionsRef = useRef<StoredTonConnectSession[]>([]);
  tonConnectSessionsRef.current = tonConnectSessions;
  const chainFetchSeqRef = useRef(0);
  const tonFetchSeqRef = useRef(0);
  const vaultGenerationRef = useRef(0);
  const vaultMutexRef = useRef<Promise<unknown>>(Promise.resolve());
  const withVaultMutex = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
    const prev = vaultMutexRef.current;
    const next = prev.catch(() => undefined).then(fn);
    vaultMutexRef.current = next;
    return next;
  }, []);

  const getTonClient = useCallback(async () => {
    const { createTonClient } = await loadTonCore();
    return createTonClient({
      network: config.tonNetwork,
      rpcUrls: config.tonRpcUrls,
    });
  }, [config.tonNetwork, config.tonRpcUrls]);

  const showToast = useCallback(
    (message: string, kind: "success" | "info" | "error" = "success") => {
      setToast({ id: Date.now(), kind, message });
    },
    [],
  );

  const dismissToast = useCallback(() => {
    setToast(null);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => {
      setToast(null);
    }, 4500);
    return () => clearTimeout(timer);
  }, [toast]);

  const accounts = useMemo(() => toLinkedAccounts(accountMetaList), [accountMetaList]);
  const activeAccount = useMemo(
    () => accounts.find((a) => a.derivationIndex === activeIndex) ?? accounts[0] ?? null,
    [accounts, activeIndex],
  );
  const activeAddressRef = useRef<string | null>(null);
  activeAddressRef.current = activeAccount?.address ?? null;
  const networkRef = useRef(config.network);
  networkRef.current = config.network;
  const stellarClientRef = useRef(stellarClient);
  stellarClientRef.current = stellarClient;

  const [tonAccount, setTonAccount] = useState<TonAccountSummary | null>(null);
  const tonEnabledRef = useRef(false);
  const tonDeriveInflightRef = useRef<Promise<TonAccountSummary | null> | null>(null);

  const ensureTonAccount = useCallback(
    async (versionOverride?: TonWalletVersion): Promise<TonAccountSummary | null> => {
      if (vaultStatus !== "unlocked" || !sessionVault.has()) {
        return null;
      }
      tonEnabledRef.current = true;
      const versionToUse = versionOverride ?? tonWalletVersionRef.current;
      if (tonDeriveInflightRef.current && versionOverride === undefined) {
        return tonDeriveInflightRef.current;
      }
      const gen = vaultGenerationRef.current;
      const tonNet = config.tonNetwork;
      const acc = activeAccount;
      const idx = activeIndex;
      const promise = loadTonCore()
        .then(({ deriveTonAccount }) => {
          if (gen !== vaultGenerationRef.current || !sessionVault.has()) {
            return null;
          }
          const summary = sessionVault.withMnemonic((mnemonic) => {
            const tonDerivationIndex = resolveTonDerivationIndex(acc, idx);
            const derived = deriveTonAccount(
              mnemonic,
              tonDerivationIndex,
              tonNet,
              versionToUse,
            );
            try {
              return derived.toSummary();
            } finally {
              derived.zeroize();
            }
          });
          if (gen === vaultGenerationRef.current) {
            setTonAccount(summary);
          }
          return summary;
        })
        .catch(() => null)
        .finally(() => {
          if (tonDeriveInflightRef.current === promise) {
            tonDeriveInflightRef.current = null;
          }
        });
      tonDeriveInflightRef.current = promise;
      return promise;
    },
    [vaultStatus, activeAccount, activeIndex, config.tonNetwork],
  );

  const setTonWalletVersion = useCallback(
    (version: TonWalletVersion) => {
      setTonWalletVersionState(version);
      tonWalletVersionRef.current = version;
      try {
        if (typeof window !== "undefined") {
          const key = cleanScopeId ? `${TON_WALLET_VERSION_KEY}:${cleanScopeId}` : TON_WALLET_VERSION_KEY;
          window.localStorage.setItem(key, version);
        }
      } catch {
        // Ignore storage errors
      }
      if (vaultStatus === "unlocked" && sessionVault.has()) {
        void ensureTonAccount(version);
      }
    },
    [cleanScopeId, vaultStatus, ensureTonAccount],
  );

  useEffect(() => {
    if (vaultStatus !== "unlocked" || !sessionVault.has()) {
      tonEnabledRef.current = false;
      setTonAccount(null);
      return undefined;
    }
    if (!tonEnabledRef.current && tonConnectSessions.length === 0) {
      return undefined;
    }
    void ensureTonAccount(tonWalletVersion);
    return undefined;
  }, [vaultStatus, tonWalletVersion, tonConnectSessions.length, ensureTonAccount]);

  useEffect(() => {
    let cancelled = false;
    const startGen = vaultGenerationRef.current;
    async function init() {
      let vaultReadError = false;
      const [
        vaultEnvelope,
        fpSupported,
        tgBio,
        bioRecord,
        bioWrap,
        cloudMeta,
        storedContacts,
        storedTcSessions,
      ] = await Promise.all([
        loadEncryptedVault(cleanScopeId).catch(() => {
          vaultReadError = true;
          return null;
        }),
        isFingerprintSupported().catch(() => false),
        isTelegramBiometricAvailable().catch(() => false),
        loadBiometricRecord(cleanScopeId).catch(() => null),
        tgSecureStorageGet(bioWrapKey).catch(() => null),
        loadVaultCloudMeta(cleanScopeId).catch(() => null),
        loadContacts(cleanScopeId).catch(() => []),
        loadTonConnectSessions(cleanScopeId).catch(() => []),
      ]);
      if (cancelled || startGen !== vaultGenerationRef.current) return;
      const bmSaved = Boolean(getTelegramWebApp()?.BiometricManager?.isBiometricTokenSaved);
      setTelegramBioAvailable(tgBio);
      setFingerprintSupported(fpSupported || tgBio);
      setFingerprintEnrolled(bioRecord !== null || (bmSaved && Boolean(bioWrap || bmSaved)));
      setCloudSyncEligible(Boolean(cloudMeta?.cloudGradeSecret));
      cloudSyncEligibleRef.current = Boolean(cloudMeta?.cloudGradeSecret);
      setContacts(storedContacts);
      setTonConnectSessions(storedTcSessions);
      setLocalVaultUpdatedAt(vaultEnvelope?.updatedAt ?? null);
      if (vaultReadError) {
        setChainError("Unable to read encrypted vault from IndexedDB. Reload or restore from backup.");
        setVaultStatus("locked");
        return;
      }
      if (!vaultEnvelope) {
        setVaultStatus("uninitialized");
        return;
      }
      const lease = await loadValidSessionLease();
      if (lease && !cancelled && startGen === vaultGenerationRef.current) {
        sessionVault.set(lease.mnemonic);
        for (const acc of lease.accounts) {
          if (acc.importedSecret) {
            sessionVault.setImportedSecret(acc.address, acc.importedSecret);
          }
        }
        setAccountMetaList(stripImportedSecrets(lease.accounts));
        setActiveIndex(lease.accounts[0]?.index ?? 0);
        setCloudSyncEligible(lease.cloudGradeSecret);
        cloudSyncEligibleRef.current = lease.cloudGradeSecret;
        setVaultStatus("unlocked");
        return;
      }
      if (!cancelled && startGen === vaultGenerationRef.current) {
        setVaultStatus("locked");
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [cleanScopeId, bioWrapKey, loadValidSessionLease]);

  useEffect(() => {
    let cancelled = false;
    if (config.sep42AssetListUrls.length === 0) {
      setVerifiedAssets([]);
      return undefined;
    }
    const cacheKey = `sep42:${config.network}`;
    void readCachedEntry<VerifiedAssetEntry[]>(cacheKey, 24 * 60 * 60 * 1000).then((hit) => {
      if (!cancelled && hit) {
        setVerifiedAssets(hit.data);
      }
    });
    void fetchSep42VerifiedAssets(config.sep42AssetListUrls)
      .then((assets) => {
        if (!cancelled) {
          setVerifiedAssets(assets);
          writeCachedEntry(cacheKey, assets, 15 * 60 * 1000);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config.sep42AssetListUrls, config.network]);

  useEffect(() => {
    const balances = accountState?.balances;
    if (!balances || balances.length === 0 || !activeAccount) {
      setTokenMetaMap({});
      return undefined;
    }
    const assetsToResolve = balances
      .filter(
        (b) =>
          Boolean(b.assetIssuer) &&
          !(b.assetCode === "XLM" && !b.assetIssuer) &&
          b.balance.trim() !== "0.0000001" &&
          Number(b.balance) > 0,
      )
      .slice(0, 30)
      .map((b) => {
        const matched = verifiedAssets.find(
          (v) =>
            v.code.toUpperCase() === b.assetCode.toUpperCase() && v.issuer === b.assetIssuer,
        );
        return {
          assetCode: b.assetCode,
          assetIssuer: b.assetIssuer,
          knownDomain: matched?.domain,
        };
      });
    if (assetsToResolve.length === 0) {
      setTokenMetaMap({});
      return undefined;
    }
    let cancelled = false;
    const cacheKey = `tomlmap:${config.network}:${activeAccount.address}`;
    void readCachedEntry<Readonly<Record<string, HeldTokenTomlMetadata>>>(
      cacheKey,
      24 * 60 * 60 * 1000,
    ).then((hit) => {
      if (!cancelled && hit) {
        setTokenMetaMap(hit.data);
      }
    });
    void fetchHeldAssetsTomlMetadata({
      horizonUrls: config.horizonUrls,
      assets: assetsToResolve,
      apiBaseUrl: config.apiBaseUrl,
      network: config.network,
    })
      .then((resolved) => {
        if (!cancelled) {
          setTokenMetaMap(resolved);
          writeCachedEntry(cacheKey, resolved, 15 * 60 * 1000);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [
    accountState?.balances,
    verifiedAssets,
    config.horizonUrls,
    config.apiBaseUrl,
    config.network,
    activeAccount,
  ]);

  const refreshChainState = useCallback(async () => {
    const targetAddress = activeAddressRef.current;
    const targetNetwork = networkRef.current;
    const client = stellarClientRef.current;
    if (!targetAddress) return;
    const seq = ++chainFetchSeqRef.current;
    setLoadingChain(true);
    setChainError(null);
    try {
      const state = await client.fetchAccountState(targetAddress);
      if (
        seq !== chainFetchSeqRef.current ||
        activeAddressRef.current !== targetAddress ||
        networkRef.current !== targetNetwork
      ) {
        return;
      }
      if (!state.funded) {
        setRawAccountState(state);
        setRecentPayments([]);
        setRecentTrades([]);
        setClaimableBalances([]);
        setOpenOffers([]);
        return;
      }
      const [payments, trades, claimables, offers] = await Promise.all([
        client.fetchRecentPayments(targetAddress, 25),
        client.fetchRecentTrades(targetAddress, 20),
        client.fetchClaimableBalances(targetAddress, 20),
        client.fetchOpenOffers(targetAddress, 20),
      ]);
      if (
        seq !== chainFetchSeqRef.current ||
        activeAddressRef.current !== targetAddress ||
        networkRef.current !== targetNetwork
      ) {
        return;
      }
      setRawAccountState(state);
      setRecentPayments(payments);
      setRecentTrades(trades);
      setClaimableBalances(claimables);
      setOpenOffers(offers);
    } catch (err) {
      if (
        seq !== chainFetchSeqRef.current ||
        activeAddressRef.current !== targetAddress ||
        networkRef.current !== targetNetwork
      ) {
        return;
      }
      setChainError(err instanceof Error ? err.message : "Failed to load Stellar Horizon state");
    } finally {
      if (seq === chainFetchSeqRef.current) {
        setLoadingChain(false);
      }
    }
  }, []);

  useEffect(() => {
    chainFetchSeqRef.current += 1;
    setRawAccountState(null);
    setRecentPayments([]);
    setRecentTrades([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setTokenMetaMap({});
    setChainError(null);
    if (vaultStatus === "unlocked" && activeAccount) {
      void refreshChainState();
    } else {
      setLoadingChain(false);
    }
  }, [vaultStatus, activeAccount, config.network, refreshChainState]);

  const withActiveKeypair = useCallback(
    async <T,>(
      fn: (keypair: ReturnType<ReturnType<typeof deriveStellarAccount>["toKeypair"]>) => Promise<T>,
    ): Promise<T> => {
      if (!sessionVault.has() || !activeAccount) {
        throw new Error("Vault is locked");
      }
      if (sessionVault.hasImportedSecret(activeAccount.address)) {
        const parsed = sessionVault.withImportedSecret(activeAccount.address, (secret) =>
          parseExternalSecretAccount(secret),
        );
        try {
          return await fn(parsed.toKeypair());
        } finally {
          parsed.zeroize();
        }
      }
      const derived = sessionVault.withMnemonic((mnemonic) =>
        deriveStellarAccount(mnemonic, activeAccount.derivationIndex ?? 0),
      );
      try {
        return await fn(derived.toKeypair());
      } finally {
        derived.zeroize();
      }
    },
    [activeAccount],
  );

  // Zeroize session mnemonic buffers deterministically on tab unload/hide
  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const handleUnload = () => {
      vaultGenerationRef.current += 1;
      inMemorySessionPinRef.current = null;
      sessionVault.clear();
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
      handleUnload();
    };
  }, []);

  const tonAccountRef = useRef<TonAccountSummary | null>(null);
  tonAccountRef.current = tonAccount;
  const tonNetworkRef = useRef(config.tonNetwork);
  tonNetworkRef.current = config.tonNetwork;

  const refreshTonState = useCallback(async () => {
    const targetTon = tonAccountRef.current;
    const targetTonNet = tonNetworkRef.current;
    if (!targetTon || config.tonRpcUrls.length === 0) {
      tonFetchSeqRef.current += 1;
      setTonState(null);
      setLoadingTonChain(false);
      return;
    }
    const seq = ++tonFetchSeqRef.current;
    setLoadingTonChain(true);
    setTonChainError(null);
    try {
      const tonClient = await getTonClient();
      const state = await tonClient.getAccountState(targetTon.friendlyAddress);
      if (
        seq !== tonFetchSeqRef.current ||
        tonAccountRef.current?.friendlyAddress !== targetTon.friendlyAddress ||
        tonNetworkRef.current !== targetTonNet
      ) {
        return;
      }
      setTonState(state);
    } catch (err) {
      if (
        seq !== tonFetchSeqRef.current ||
        tonAccountRef.current?.friendlyAddress !== targetTon.friendlyAddress ||
        tonNetworkRef.current !== targetTonNet
      ) {
        return;
      }
      setTonChainError(err instanceof Error ? err.message : "Failed to fetch TON account state");
    } finally {
      if (seq === tonFetchSeqRef.current) {
        setLoadingTonChain(false);
      }
    }
  }, [getTonClient, config.tonRpcUrls.length]);

  useEffect(() => {
    tonFetchSeqRef.current += 1;
    setTonState(null);
    setTonChainError(null);
    setPendingTonConnectTx(null);
    if (vaultStatus === "unlocked" && tonAccount && config.tonRpcUrls.length > 0) {
      void refreshTonState();
    } else {
      setLoadingTonChain(false);
    }
  }, [vaultStatus, tonAccount, config.tonNetwork, config.tonRpcUrls.length, refreshTonState]);

  const sendTonPayment = useCallback(
    async (params: {
      destination: string;
      amountTon: string;
      comment?: string | undefined;
    }) => {
      if (!sessionVault.has() || !activeAccount) {
        throw new Error("Vault is locked");
      }
      if (config.tonRpcUrls.length === 0) {
        throw new Error("VITE_TON_RPC_URLS is not configured");
      }
      const [{ deriveTonAccount }, tonClient] = await Promise.all([
        loadTonCore(),
        getTonClient(),
      ]);
      const res = await sessionVault.withMnemonic(async (mnemonic) => {
        const derived = deriveTonAccount(
          mnemonic,
          activeAccount.address ? resolveTonDerivationIndex(activeAccount, activeIndex) : 0,
          config.tonNetwork,
          tonWalletVersionRef.current,
        );
        try {
          return await tonClient.sendTonTransfer({
            account: derived,
            destination: params.destination,
            amountTon: params.amountTon,
            comment: params.comment,
          });
        } finally {
          derived.zeroize();
        }
      });
      await refreshTonState();
      showToast(`Broadcasted ${params.amountTon} TON cleanly`);
      return res;
    },
    [activeAccount, activeIndex, config.tonNetwork, config.tonRpcUrls.length, getTonClient, refreshTonState, showToast],
  );

  const previewTonConnectUri = useCallback(
    async (uri: string): Promise<TonConnectPairingPreview> => {
      if (vaultStatus !== "unlocked" || !sessionVault.has()) {
        throw new Error("Unlock your vault before connecting TON apps");
      }
      if (!config.tonBridgeUrl) {
        throw new Error("VITE_TON_BRIDGE_URL is not configured");
      }
      const { isValidTonManifestOriginMatch, parseTonConnectUri } = await loadTonCore();
      const parsed = parseTonConnectUri(uri);
      const manifestOrigin = new URL(parsed.manifestUrl);
      if (
        manifestOrigin.protocol !== "https:" &&
        !(manifestOrigin.protocol === "http:" && manifestOrigin.hostname === "localhost")
      ) {
        throw new Error("TON Connect manifestUrl must use https://");
      }

      let dappName = manifestOrigin.hostname;
      let dappUrl = manifestOrigin.origin;
      let manifestFetchedOk = false;

      try {
        const proxyManifestUrl = `${config.apiBaseUrl.replace(/\/+$/, "")}/v1/proxy/ton-manifest?url=${encodeURIComponent(parsed.manifestUrl)}`;
        const manifestRes = await fetch(proxyManifestUrl, {
          headers: { "X-Astro-Network": config.network },
          signal: AbortSignal.timeout(4000),
        });
        if (!manifestRes.ok) {
          const errJson = (await manifestRes.json().catch(() => ({}))) as { error?: string };
          if (manifestRes.status >= 400 && manifestRes.status < 500) {
            throw new Error(
              errJson.error ?? "TON Connect manifest validation rejected (origin mismatch)",
            );
          }
        } else {
          manifestFetchedOk = true;
          const m = (await manifestRes.json()) as { name?: unknown; url?: unknown };
          if (typeof m.name === "string" && m.name.trim()) {
            dappName = m.name.trim().slice(0, 64);
          }
          if (typeof m.url === "string" && m.url.trim()) {
            if (!isValidTonManifestOriginMatch(parsed.manifestUrl, m.url.trim())) {
              throw new Error(
                "TON Connect manifest url origin does not match manifestUrl (possible domain spoof)",
              );
            }
            dappUrl = new URL(m.url.trim()).origin;
          }
        }
      } catch (err) {
        if (err instanceof Error && /origin|spoof|manifestUrl|rejected/i.test(err.message)) {
          throw err;
        }
        // Fallback only when proxy fetch fails due to transient network error
      }

      const proofItem = parsed.items.find((i) => i.name === "ton_proof" && i.payload);
      const originVerified =
        manifestFetchedOk && isValidTonManifestOriginMatch(parsed.manifestUrl, dappUrl);
      const domainForProof = new URL(dappUrl).hostname;

      return {
        uri,
        dappClientId: parsed.clientId,
        dappName,
        dappUrl,
        manifestUrl: parsed.manifestUrl,
        domainForProof,
        hasTonProof: Boolean(proofItem?.payload),
        originVerified,
        tonProofPayload: proofItem?.payload,
        items: parsed.items,
      };
    },
    [vaultStatus, config.apiBaseUrl, config.network, config.tonBridgeUrl],
  );

  const approveTonConnectPairing = useCallback(
    async (preview: TonConnectPairingPreview): Promise<StoredTonConnectSession> => {
      if (vaultStatus !== "unlocked" || !sessionVault.has()) {
        throw new Error("Unlock your vault before connecting TON apps");
      }
      if (!config.tonBridgeUrl) {
        throw new Error("VITE_TON_BRIDGE_URL is not configured");
      }
      if (preview.hasTonProof && !preview.originVerified) {
        throw new Error(
          "Refusing to sign ton_proof: manifest url could not be origin-verified via HTTPS.",
        );
      }

      const startGen = vaultGenerationRef.current;
      const versionToUse = tonWalletVersionRef.current;
      const derivationIdx = resolveTonDerivationIndex(activeAccount, activeIndex);
      const {
        TonConnectCryptoSession,
        buildTonConnectSuccessEvent,
        deriveTonAccount,
        sendTonConnectBridgeMessage,
        signTonProof,
      } = await loadTonCore();

      if (startGen !== vaultGenerationRef.current || !sessionVault.has()) {
        throw new Error("Vault locked before TON Connect pairing completed");
      }

      const cryptoSess = new TonConnectCryptoSession();
      const timestamp = Math.floor(Date.now() / 1000);
      let tonProof:
        | { timestamp: number; domain: string; payload: string; signatureBase64: string }
        | undefined;

      const derivedResult = sessionVault.withMnemonic((mnemonic) => {
        const derived = deriveTonAccount(
          mnemonic,
          derivationIdx,
          config.tonNetwork,
          versionToUse,
        );
        try {
          if (preview.hasTonProof && preview.tonProofPayload) {
            const sigB64 = signTonProof({
              rawAddress: derived.rawAddress,
              domain: preview.domainForProof,
              timestamp,
              payload: preview.tonProofPayload,
              secretKey: derived.secretKey,
            });
            tonProof = {
              timestamp,
              domain: preview.domainForProof,
              payload: preview.tonProofPayload,
              signatureBase64: sigB64,
            };
          }
          return {
            summary: derived.toSummary(),
            walletStateInitBase64: derived.walletStateInitBase64,
            publicKeyHex: derived.publicKeyHex,
            rawAddress: derived.rawAddress,
          };
        } finally {
          derived.zeroize();
        }
      });

      setTonAccount(derivedResult.summary);

      const connectEventJson = buildTonConnectSuccessEvent({
        rawAddress: derivedResult.rawAddress,
        network: config.tonNetwork,
        walletStateInitBase64: derivedResult.walletStateInitBase64,
        publicKeyHex: derivedResult.publicKeyHex,
        ...(tonProof ? { tonProof } : {}),
      });

      const sealed = cryptoSess.encrypt(connectEventJson, preview.dappClientId);
      await sendTonConnectBridgeMessage({
        bridgeUrl: config.tonBridgeUrl,
        clientId: cryptoSess.clientId,
        to: preview.dappClientId,
        payloadBase64: sealed,
      });

      if (startGen !== vaultGenerationRef.current || !sessionVault.has()) {
        throw new Error("Vault locked during TON Connect pairing");
      }

      const stored: StoredTonConnectSession = {
        ...(cleanScopeId ? { scopeId: cleanScopeId } : {}),
        walletClientId: cryptoSess.clientId,
        walletSecretHex: cryptoSess.secretKeyHex,
        dappClientId: preview.dappClientId,
        dappName: preview.dappName,
        dappUrl: preview.dappUrl,
        manifestUrl: preview.manifestUrl,
        network: config.tonNetwork,
        connectedAddress: derivedResult.rawAddress,
        derivationIndex: derivationIdx,
        walletVersion: versionToUse,
        createdAt: timestamp,
      };
      await saveTonConnectSession(stored);
      setTonConnectSessions((prev) => [
        stored,
        ...prev.filter((s) => s.dappClientId !== stored.dappClientId),
      ]);
      triggerTelegramHaptic("success");
      showToast(`Connected to ${preview.dappName} via TON Connect (${versionToUse.toUpperCase()})`);
      return stored;
    },
    [
      vaultStatus,
      activeAccount,
      activeIndex,
      config.tonBridgeUrl,
      config.tonNetwork,
      cleanScopeId,
      showToast,
    ],
  );

  const pairTonConnectUri = useCallback(
    async (uri: string): Promise<StoredTonConnectSession> => {
      const preview = await previewTonConnectUri(uri);
      return approveTonConnectPairing(preview);
    },
    [previewTonConnectUri, approveTonConnectPairing],
  );

  const disconnectTonConnectSession = useCallback(
    async (walletClientId: string) => {
      const { TonConnectCryptoSession, sendTonConnectBridgeMessage } = await loadTonCore();
      const target = tonConnectSessionsRef.current.find(
        (s) => s.walletClientId === walletClientId,
      );
      if (target && config.tonBridgeUrl) {
        try {
          const sess = new TonConnectCryptoSession(target.walletSecretHex);
          const msg = JSON.stringify({ event: "disconnect", id: Date.now(), payload: {} });
          await sendTonConnectBridgeMessage({
            bridgeUrl: config.tonBridgeUrl,
            clientId: target.walletClientId,
            to: target.dappClientId,
            payloadBase64: sess.encrypt(msg, target.dappClientId),
          });
        } catch {
          // Best-effort bridge notification
        }
      }
      await removeTonConnectSession(walletClientId);
      setTonConnectSessions((prev) => prev.filter((s) => s.walletClientId !== walletClientId));
      setPendingTonConnectTx((prev) =>
        prev?.walletClientId === walletClientId ? null : prev,
      );
      showToast("Disconnected TON Connect session", "info");
    },
    [config.tonBridgeUrl, showToast],
  );

  const resolvePendingTonConnectTx = useCallback(
    async (approved: boolean) => {
      const req = pendingTonConnectTx;
      if (!req || tonConnectResolvingRef.current) return;
      tonConnectResolvingRef.current = true;
      try {
        const sessRecord = tonConnectSessionsRef.current.find(
          (s) => s.walletClientId === req.walletClientId,
        );
        if (!sessRecord || !config.tonBridgeUrl) {
          setPendingTonConnectTx(null);
          return;
        }
        const {
          TonConnectCryptoSession,
          buildSignedTonTransfer,
          deriveTonAccount,
          enqueueTonAccountTx,
          sendTonConnectBridgeMessage,
        } = await loadTonCore();
        const cryptoSess = new TonConnectCryptoSession(sessRecord.walletSecretHex);

        if (!approved) {
          setPendingTonConnectTx(null);
          const errPayload = JSON.stringify({
            id: req.requestId,
            error: { code: 300, message: "User rejected TON Connect transaction" },
          });
          await sendTonConnectBridgeMessage({
            bridgeUrl: config.tonBridgeUrl,
            clientId: sessRecord.walletClientId,
            to: req.dappClientId,
            payloadBase64: cryptoSess.encrypt(errPayload, req.dappClientId),
          }).catch(() => undefined);
          triggerTelegramHaptic("warning");
          showToast("Rejected TON Connect request", "info");
          return;
        }

        if (!sessionVault.has()) {
          throw new Error("Unlock your vault to sign TON Connect transactions");
        }

        const tonClient = await getTonClient();
        const bocBase64 = await sessionVault.withMnemonic(async (mnemonic) => {
          const boundIndex = sessRecord.derivationIndex ?? 0;
          const boundVersion = sessRecord.walletVersion ?? "v4r2";
          const derived = deriveTonAccount(
            mnemonic,
            boundIndex,
            sessRecord.network,
            boundVersion,
          );
          try {
            if (derived.rawAddress !== sessRecord.connectedAddress) {
              throw new Error(
                "Connected TON Connect account does not match derived key — aborting signature.",
              );
            }
            return await enqueueTonAccountTx(derived.rawAddress, async () => {
              const chainState = await tonClient.getAccountState(derived.friendlyAddress);
              const boc = buildSignedTonTransfer({
                account: derived,
                seqno: chainState.seqno,
                validUntil: req.validUntil,
                messages: req.messages.map((m) => ({
                  destination: m.address,
                  amountNano: m.amountNano,
                  payloadCellBase64: m.payload,
                  stateInitBase64: m.stateInit,
                })),
              });
              await tonClient.broadcastBoc(boc);
              return boc;
            });
          } finally {
            derived.zeroize();
          }
        });

        setPendingTonConnectTx(null);
        const okPayload = JSON.stringify({ id: req.requestId, result: bocBase64 });
        await sendTonConnectBridgeMessage({
          bridgeUrl: config.tonBridgeUrl,
          clientId: sessRecord.walletClientId,
          to: req.dappClientId,
          payloadBase64: cryptoSess.encrypt(okPayload, req.dappClientId),
        });
        triggerTelegramHaptic("success");
        await refreshTonState();
        showToast(`Signed TON Connect transaction for ${req.dappName}`);
      } finally {
        tonConnectResolvingRef.current = false;
      }
    },
    [
      pendingTonConnectTx,
      config.apiBaseUrl,
      config.network,
      config.tonBridgeUrl,
      config.tonNetwork,
      activeAccount,
      activeIndex,
      getTonClient,
      refreshTonState,
      showToast,
    ],
  );

  // Live TON Connect v2 SSE listener while Mini App vault is unlocked
  useEffect(() => {
    const activeNetSessions = tonConnectSessions.filter((s) => s.network === config.tonNetwork);
    if (
      vaultStatus !== "unlocked" ||
      !config.tonBridgeUrl ||
      activeNetSessions.length === 0 ||
      typeof EventSource === "undefined"
    ) {
      return undefined;
    }

    let source: EventSource | null = null;
    let cancelled = false;

    void loadTonCore().then(
      ({
        TonConnectCryptoSession,
        buildTonConnectEventsUrl,
        classifyTonPayloadBoc,
        sendTonConnectBridgeMessage,
        validateTonConnectSendTxRequest,
      }) => {
        if (cancelled) return;
        const clientIds = activeNetSessions.map((s) => s.walletClientId);
        // Only pass a single-session cursor; sharing last_event_id across multiple sessions can drop peer events.
        const lastEventId =
          activeNetSessions.length === 1 ? activeNetSessions[0]?.lastEventId : undefined;
        const eventsUrl = buildTonConnectEventsUrl(config.tonBridgeUrl!, clientIds, lastEventId);
        source = new EventSource(eventsUrl);

        source.onmessage = (evt: MessageEvent<string>) => {
          try {
            const packet = JSON.parse(evt.data) as { from?: string; message?: string };
            if (!packet.from || !packet.message) return;
            const matched = tonConnectSessionsRef.current.find(
              (s) => s.dappClientId === packet.from && s.network === config.tonNetwork,
            );
            if (!matched) return;

            if (evt.lastEventId) {
              const dedupKey = `${matched.walletClientId}:${evt.lastEventId}`;
              if (processedTonEventIdsRef.current.has(dedupKey)) {
                return;
              }
              processedTonEventIdsRef.current.add(dedupKey);
              if (processedTonEventIdsRef.current.size > 200) {
                const oldest = processedTonEventIdsRef.current.values().next().value;
                if (oldest) processedTonEventIdsRef.current.delete(oldest);
              }
              const updated = { ...matched, lastEventId: evt.lastEventId };
              void saveTonConnectSession(updated).catch(() => undefined);
            }

            const cryptoSess = new TonConnectCryptoSession(matched.walletSecretHex);
            const decrypted = cryptoSess.decrypt(packet.message, matched.dappClientId);
            const rpc = JSON.parse(decrypted) as {
              id?: string;
              method?: string;
              params?: unknown[];
            };

            if (rpc.method === "disconnect") {
              void removeTonConnectSession(matched.walletClientId);
              setTonConnectSessions((prev) =>
                prev.filter((s) => s.walletClientId !== matched.walletClientId),
              );
              showToast(`${matched.dappName} disconnected`, "info");
              return;
            }

            if (rpc.method === "sendTransaction" && rpc.id) {
              const rawFirst = rpc.params?.[0];
              const txReq =
                typeof rawFirst === "string"
                  ? (JSON.parse(rawFirst) as Record<string, unknown>)
                  : (rawFirst as Record<string, unknown> | undefined);
              if (!txReq) return;

              const validated = validateTonConnectSendTxRequest(
                {
                  id: rpc.id,
                  validUntil:
                    typeof txReq.validUntil === "number" ? txReq.validUntil : undefined,
                  network: typeof txReq.network === "string" ? txReq.network : undefined,
                  from: typeof txReq.from === "string" ? txReq.from : undefined,
                  messages: Array.isArray(txReq.messages) ? txReq.messages : [],
                },
                config.tonNetwork,
                undefined,
                { expectedFromRawAddress: matched.connectedAddress },
              );

              if (!validated.ok) {
                const errJson = JSON.stringify({
                  id: rpc.id,
                  error: { code: validated.code, message: validated.message },
                });
                void sendTonConnectBridgeMessage({
                  bridgeUrl: config.tonBridgeUrl!,
                  clientId: matched.walletClientId,
                  to: matched.dappClientId,
                  payloadBase64: cryptoSess.encrypt(errJson, matched.dappClientId),
                }).catch(() => undefined);
                return;
              }

              const classifiedMessages = validated.messages.map((m) => ({
                ...m,
                classification: classifyTonPayloadBoc(m.payload, m.stateInit),
              }));

              triggerTelegramHaptic("warning");
              setPendingTonConnectTx({
                requestId: rpc.id,
                walletClientId: matched.walletClientId,
                dappClientId: matched.dappClientId,
                dappName: matched.dappName,
                dappUrl: matched.dappUrl,
                connectedAddress: matched.connectedAddress,
                validUntil: validated.validUntil,
                messages: classifiedMessages,
              });
            }
          } catch {
            // Ignore malformed bridge events
          }
        };
      },
    );

    return () => {
      cancelled = true;
      source?.close();
    };
  }, [vaultStatus, config.tonBridgeUrl, config.tonNetwork, tonConnectSessions, showToast]);

  const createOrImportVault = useCallback(
    async (mnemonic: string, pinOrPassphrase: string, initialLabel = "Primary") => {
      if (!validateMnemonicPhrase(mnemonic)) {
        throw new Error("Invalid 12 or 24-word BIP-39 recovery phrase");
      }
      const derived0 = deriveStellarAccount(mnemonic, 0);
      const initialAccounts: VaultAccountMetadata[] = [
        {
          index: 0,
          label: (initialLabel.trim() || "Primary").slice(0, 32),
          address: derived0.publicKey,
        },
      ];
      derived0.zeroize();

      const payload = {
        mnemonic: mnemonic.trim().toLowerCase().replace(/\s+/g, " "),
        accounts: initialAccounts,
        createdAt: Math.floor(Date.now() / 1000),
      };

      const envelope = await encryptVaultPayload(payload, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      await saveEncryptedVault(envelope, cleanScopeId);
      setLocalVaultUpdatedAt(envelope.updatedAt);

      const isCloudGrade = evaluateCloudBackupSecretStrength(pinOrPassphrase).acceptable;
      await markCloudGradeSecret(isCloudGrade);

      sessionVault.set(payload.mnemonic);
      setAccountMetaList(stripImportedSecrets(initialAccounts));
      setActiveIndex(0);
      setVaultStatus("unlocked");
      void saveSessionLease(pinOrPassphrase, initialAccounts, isCloudGrade);
      showToast("Sovereign SEP-0005 Vault created locally");
      return { envelopeJson: serializeAgVaultBackup(envelope) };
    },
    [cleanScopeId, markCloudGradeSecret, saveSessionLease, showToast],
  );

  const unlockWithPin = useCallback(
    async (pinOrPassphrase: string) => {
      const lockout = await getPinLockoutState(cleanScopeId);
      if (lockout.lockedUntilMs > Date.now()) {
        const sec = Math.max(1, Math.ceil((lockout.lockedUntilMs - Date.now()) / 1000));
        throw new Error(`Too many failed PIN attempts. Wait ${sec}s before retrying.`);
      }
      const startGen = vaultGenerationRef.current;
      const envelope = await loadEncryptedVault(cleanScopeId);
      if (!envelope) {
        throw new Error("No local vault found on this device");
      }
      let decrypted;
      try {
        decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
          deriveKeyFn: deriveKeyInWorker,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid PIN or passphrase";
        if (!/Corrupted/i.test(msg)) {
          await recordFailedPinAttempt(Date.now(), cleanScopeId);
        }
        throw err;
      }
      await clearPinLockoutState(cleanScopeId);
      if (startGen !== vaultGenerationRef.current) {
        return;
      }
      const isCloudGrade = evaluateCloudBackupSecretStrength(pinOrPassphrase).acceptable;
      await markCloudGradeSecret(isCloudGrade);
      sessionVault.set(decrypted.mnemonic);
      for (const acc of decrypted.accounts) {
        if (acc.importedSecret) {
          sessionVault.setImportedSecret(acc.address, acc.importedSecret);
        }
      }
      setAccountMetaList(stripImportedSecrets(decrypted.accounts));
      setActiveIndex(decrypted.accounts[0]?.index ?? 0);
      setLocalVaultUpdatedAt(envelope.updatedAt);
      setVaultStatus("unlocked");
      void saveSessionLease(pinOrPassphrase, decrypted.accounts, isCloudGrade);
    },
    [cleanScopeId, markCloudGradeSecret, saveSessionLease],
  );

  const unwrapPinFromTelegramBiometric = useCallback(
    async (token?: string): Promise<string | null> => {
      const cleanToken = token?.trim() ?? "";
      if (!cleanToken) return null;
      const bioWrapRaw = await tgSecureStorageGet(bioWrapKey).catch(() => null);
      if (bioWrapRaw && /^[a-f0-9]{64}$/i.test(cleanToken)) {
        const parsed = JSON.parse(bioWrapRaw) as {
          v?: unknown;
          ivB64?: unknown;
          ctB64?: unknown;
        };
        if (
          parsed.v === 2 &&
          typeof parsed.ivB64 === "string" &&
          typeof parsed.ctB64 === "string"
        ) {
          const aesKey = await importBioWrapAesKey(cleanToken);
          const pt = await unsealWithAesGcmKey(aesKey, {
            ivB64: parsed.ivB64,
            ctB64: parsed.ctB64,
          });
          const payload = JSON.parse(pt) as { v?: unknown; pin?: unknown };
          if (payload.v === 2 && typeof payload.pin === "string" && payload.pin.length > 0) {
            void tgSecureStorageRemove(securePinKey).catch(() => false);
            return payload.pin;
          }
        }
        return null;
      }
      // Migration path for pre-v2 biometric token stored inside hardware BiometricManager itself
      if (!bioWrapRaw && cleanToken.length > 0) {
        void tgSecureStorageRemove(securePinKey).catch(() => false);
        return cleanToken;
      }
      return null;
    },
    [bioWrapKey, securePinKey],
  );

  const unlockWithBiometric = useCallback(async () => {
    if (telegramBioAvailable) {
      const bio = await authenticateTelegramBiometric("Unlock your AstroWallet vault");
      if (bio.authenticated) {
        const pinFromBio = await unwrapPinFromTelegramBiometric(bio.token).catch(() => null);
        if (pinFromBio) {
          await unlockWithPin(pinFromBio);
          return;
        }
      }
    }
    const pin = await unlockWithFingerprint(resolveWebAuthnRpId(config.pwaOrigin), cleanScopeId);
    await unlockWithPin(pin);
  }, [
    telegramBioAvailable,
    unwrapPinFromTelegramBiometric,
    unlockWithPin,
    config.pwaOrigin,
    cleanScopeId,
  ]);

  const enableFingerprint = useCallback(
    async (pinOrPassphrase: string) => {
      const envelope = await loadEncryptedVault(cleanScopeId);
      if (!envelope) {
        throw new Error("Create and save your vault first");
      }
      await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });

      if (telegramBioAvailable) {
        const bio = await authenticateTelegramBiometric(
          "Enable Telegram biometric unlock for AstroWallet",
        );
        if (!bio.authenticated) {
          return { enrolled: false, message: "Telegram biometric permission was not granted." };
        }
        const bioKeyBytes = crypto.getRandomValues(new Uint8Array(32));
        const bioKeyHex = bytesToHex(bioKeyBytes);
        bioKeyBytes.fill(0);
        const aesKey = await importBioWrapAesKey(bioKeyHex);
        const sealed = await sealWithAesGcmKey(
          aesKey,
          JSON.stringify({ v: 2, pin: pinOrPassphrase }),
        );
        const savedBm = await updateTelegramBiometricToken(bioKeyHex);
        if (savedBm) {
          const savedStore = await tgSecureStorageSet(
            bioWrapKey,
            JSON.stringify({ v: 2, ...sealed }),
          );
          await tgSecureStorageRemove(securePinKey).catch(() => false);
          if (savedStore) {
            setFingerprintEnrolled(true);
            return {
              enrolled: true,
              message: "Telegram Biometrics + encrypted SecureStorage quick-unlock enabled.",
            };
          }
        }
        await updateTelegramBiometricToken("").catch(() => false);
      }

      const res = await enrollFingerprintUnlock(
        pinOrPassphrase,
        "AstroWallet",
        resolveWebAuthnRpId(config.pwaOrigin),
        cleanScopeId,
      );
      if (res.enrolled) {
        setFingerprintEnrolled(true);
        return { enrolled: true, message: "Fingerprint quick-unlock enabled on this device." };
      }
      return { enrolled: false, message: res.reason };
    },
    [telegramBioAvailable, bioWrapKey, securePinKey, config.pwaOrigin, cleanScopeId],
  );

  const disableFingerprint = useCallback(async () => {
    await updateTelegramBiometricToken("").catch(() => false);
    await tgSecureStorageRemove(bioWrapKey).catch(() => false);
    await tgSecureStorageRemove(securePinKey).catch(() => false);
    await disableFingerprintUnlock(cleanScopeId);
    setFingerprintEnrolled(false);
  }, [bioWrapKey, securePinKey, cleanScopeId]);

  const restoreAgVaultJson = useCallback(
    async (rawJson: string, pinOrPassphrase: string) => {
      const startGen = vaultGenerationRef.current;
      const envelope = parseAgVaultBackup(rawJson);
      const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      if (startGen !== vaultGenerationRef.current) return;
      await saveEncryptedVault(envelope, cleanScopeId);
      if (startGen !== vaultGenerationRef.current) return;
      const isCloudGrade = evaluateCloudBackupSecretStrength(pinOrPassphrase).acceptable;
      const cloudSha = await sha256HexText(rawJson).catch(() => undefined);
      await markCloudGradeSecret(isCloudGrade, cloudSha);
      setLocalVaultUpdatedAt(envelope.updatedAt);
      sessionVault.set(decrypted.mnemonic);
      for (const acc of decrypted.accounts) {
        if (acc.importedSecret) {
          sessionVault.setImportedSecret(acc.address, acc.importedSecret);
        }
      }
      setAccountMetaList(stripImportedSecrets(decrypted.accounts));
      setActiveIndex(decrypted.accounts[0]?.index ?? 0);
      setVaultStatus("unlocked");
      void saveSessionLease(pinOrPassphrase, decrypted.accounts, isCloudGrade);
      showToast("Encrypted .agvault restored locally");
    },
    [cleanScopeId, markCloudGradeSecret, saveSessionLease, showToast],
  );

  const syncFromNewerCloudBackup = useCallback(
    async (
      rawJson: string,
    ): Promise<{
      status: "synced" | "push_merged" | "pin_required" | "up_to_date" | "wallet_mismatch";
      envelopeJson?: string | undefined;
      accountCount?: number | undefined;
    }> =>
      withVaultMutex(async () => {
        const startGen = vaultGenerationRef.current;
        let cloudEnvelope;
        try {
          cloudEnvelope = parseAgVaultBackup(rawJson);
        } catch {
          return { status: "up_to_date" };
        }

        const localEnvelope = await loadEncryptedVault(cleanScopeId).catch(() => null);
        if (localEnvelope && localEnvelope.ciphertextB64 === cloudEnvelope.ciphertextB64) {
          return { status: "up_to_date" };
        }

        const activePin = inMemorySessionPinRef.current;
        if (!activePin || startGen !== vaultGenerationRef.current) {
          return { status: "pin_required" };
        }

        let cloudPayload;
        try {
          cloudPayload = await decryptVaultPayload(cloudEnvelope, activePin, {
            deriveKeyFn: deriveKeyInWorker,
          });
        } catch {
          return { status: "pin_required" };
        }
        if (startGen !== vaultGenerationRef.current) {
          return { status: "pin_required" };
        }

        const cloudSha = await sha256HexText(rawJson).catch(() => undefined);
        const isCloudGrade = evaluateCloudBackupSecretStrength(activePin).acceptable;

        if (!localEnvelope) {
          await saveEncryptedVault(cloudEnvelope, cleanScopeId);
          if (startGen !== vaultGenerationRef.current) return { status: "pin_required" };
          await markCloudGradeSecret(isCloudGrade, cloudSha);
          setLocalVaultUpdatedAt(cloudEnvelope.updatedAt);
          sessionVault.set(cloudPayload.mnemonic);
          for (const acc of cloudPayload.accounts) {
            if (acc.importedSecret) {
              sessionVault.setImportedSecret(acc.address, acc.importedSecret);
            }
          }
          setAccountMetaList(stripImportedSecrets(cloudPayload.accounts));
          setVaultStatus("unlocked");
          void saveSessionLease(activePin, cloudPayload.accounts, isCloudGrade);
          showToast(`Synced ${cloudPayload.accounts.length} accounts from Telegram Cloud`);
          return { status: "synced", accountCount: cloudPayload.accounts.length };
        }

        let localPayload;
        try {
          localPayload = await decryptVaultPayload(localEnvelope, activePin, {
            deriveKeyFn: deriveKeyInWorker,
          });
        } catch {
          // Local PIN differed or distinct wallet; never overwrite local IndexedDB silently
          return { status: "wallet_mismatch" };
        }
        if (startGen !== vaultGenerationRef.current) {
          return { status: "pin_required" };
        }

        if (localPayload.mnemonic.trim() !== cloudPayload.mnemonic.trim()) {
          // Distinct recovery phrases: never silently overwrite either local vault or cloud backup
          return { status: "wallet_mismatch" };
        }

        // CRDT account-union merge (never drop accounts from either device)
        const primaryFirst =
          localEnvelope.updatedAt >= cloudEnvelope.updatedAt
            ? localPayload.accounts
            : cloudPayload.accounts;
        const secondary =
          localEnvelope.updatedAt >= cloudEnvelope.updatedAt
            ? cloudPayload.accounts
            : localPayload.accounts;

        const byAddress = new Map<string, VaultAccountMetadata>();
        const usedIndices = new Set<number>();
        let maxIdx = 999;

        for (const acc of primaryFirst) {
          byAddress.set(acc.address, acc);
          usedIndices.add(acc.index);
          if (acc.index > maxIdx) maxIdx = acc.index;
        }
        for (const acc of secondary) {
          if (byAddress.has(acc.address)) continue;
          let nextIdx = acc.index;
          if (usedIndices.has(nextIdx)) {
            maxIdx += 1;
            nextIdx = maxIdx;
          }
          usedIndices.add(nextIdx);
          byAddress.set(acc.address, { ...acc, index: nextIdx });
        }

        const mergedAccounts = Array.from(byAddress.values()).sort((a, b) => a.index - b.index);
        const cloudMissingAny = mergedAccounts.length > cloudPayload.accounts.length;
        const localMissingAny = mergedAccounts.length > localPayload.accounts.length;

        if (cloudMissingAny) {
          const mergedEnvelope = await encryptVaultPayload(
            {
              mnemonic: localPayload.mnemonic,
              accounts: mergedAccounts,
              createdAt: Math.min(localPayload.createdAt, cloudPayload.createdAt),
            },
            activePin,
            { deriveKeyFn: deriveKeyInWorker },
          );
          if (startGen !== vaultGenerationRef.current) return { status: "pin_required" };
          await saveEncryptedVault(mergedEnvelope, cleanScopeId);
          if (startGen !== vaultGenerationRef.current) return { status: "pin_required" };
          await markCloudGradeSecret(isCloudGrade, cloudSha);
          setLocalVaultUpdatedAt(mergedEnvelope.updatedAt);
          sessionVault.set(localPayload.mnemonic);
          for (const acc of mergedAccounts) {
            if (acc.importedSecret) {
              sessionVault.setImportedSecret(acc.address, acc.importedSecret);
            }
          }
          setAccountMetaList(stripImportedSecrets(mergedAccounts));
          setVaultStatus("unlocked");
          void saveSessionLease(activePin, mergedAccounts, isCloudGrade);
          return {
            status: "push_merged",
            envelopeJson: serializeAgVaultBackup(mergedEnvelope),
            accountCount: mergedAccounts.length,
          };
        }

        if (localMissingAny || cloudEnvelope.updatedAt > localEnvelope.updatedAt) {
          await saveEncryptedVault(cloudEnvelope, cleanScopeId);
          if (startGen !== vaultGenerationRef.current) return { status: "pin_required" };
          await markCloudGradeSecret(isCloudGrade, cloudSha);
          setLocalVaultUpdatedAt(cloudEnvelope.updatedAt);
          sessionVault.set(cloudPayload.mnemonic);
          for (const acc of cloudPayload.accounts) {
            if (acc.importedSecret) {
              sessionVault.setImportedSecret(acc.address, acc.importedSecret);
            }
          }
          setAccountMetaList(stripImportedSecrets(cloudPayload.accounts));
          setVaultStatus("unlocked");
          void saveSessionLease(activePin, cloudPayload.accounts, isCloudGrade);
          showToast(`Synced ${cloudPayload.accounts.length} accounts from Telegram Cloud`);
          return { status: "synced", accountCount: cloudPayload.accounts.length };
        }

        return { status: "up_to_date" };
      }),
    [cleanScopeId, markCloudGradeSecret, saveSessionLease, showToast, withVaultMutex],
  );

  const exportAgVaultJson = useCallback(async () => {
    const envelope = await loadEncryptedVault(cleanScopeId);
    if (!envelope) {
      throw new Error("No encrypted vault present to export");
    }
    return serializeAgVaultBackup(envelope);
  }, [cleanScopeId]);

  const exportCloudBackupJson = useCallback(async () => {
    if (!cloudSyncEligibleRef.current) {
      throw new Error(
        "Cloud Sync requires a strong Recovery Password (not a numeric PIN). Upgrade your vault protection in the Accounts tab.",
      );
    }
    const envelope = await loadEncryptedVault(cleanScopeId);
    if (!envelope) {
      throw new Error("No encrypted vault present to export");
    }
    return serializeAgVaultBackup(envelope);
  }, [cleanScopeId]);

  const reEncryptLocalVault = useCallback(
    async (currentPin: string, newPinOrPassphrase: string): Promise<{ envelopeJson: string }> =>
      withVaultMutex(async () => {
        const envelope = await loadEncryptedVault(cleanScopeId);
        if (!envelope) {
          throw new Error("No encrypted vault present on this device");
        }
        const decrypted = await decryptVaultPayload(envelope, currentPin, {
          deriveKeyFn: deriveKeyInWorker,
        });
        const updatedEnvelope = await encryptVaultPayload(
          {
            mnemonic: decrypted.mnemonic,
            accounts: decrypted.accounts,
            createdAt: decrypted.createdAt,
          },
          newPinOrPassphrase,
          { deriveKeyFn: deriveKeyInWorker },
        );
        await saveEncryptedVault(updatedEnvelope, cleanScopeId);
        const isCloudGrade = evaluateCloudBackupSecretStrength(newPinOrPassphrase).acceptable;
        await markCloudGradeSecret(isCloudGrade);
        setLocalVaultUpdatedAt(updatedEnvelope.updatedAt);
        inMemorySessionPinRef.current = newPinOrPassphrase;
        void saveSessionLease(newPinOrPassphrase, decrypted.accounts, isCloudGrade);
        // Clear any previous biometric PIN wrapper so stale PIN credentials never cause a mismatch
        await disableFingerprint();
        showToast("Vault protection updated", "info");
        return { envelopeJson: serializeAgVaultBackup(updatedEnvelope) };
      }),
    [cleanScopeId, disableFingerprint, markCloudGradeSecret, saveSessionLease, showToast, withVaultMutex],
  );

  const revealMnemonicWithPin = useCallback(
    async (pinOrPassphrase: string): Promise<string> => {
      const envelope = await loadEncryptedVault(cleanScopeId);
      if (!envelope) {
        throw new Error("No encrypted vault stored on this device");
      }
      const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      return decrypted.mnemonic;
    },
    [cleanScopeId],
  );

  const verifyPinOrPassphrase = useCallback(
    async (pinOrPassphrase: string): Promise<void> => {
      const lockout = await getPinLockoutState(cleanScopeId);
      if (lockout.lockedUntilMs > Date.now()) {
        const sec = Math.max(1, Math.ceil((lockout.lockedUntilMs - Date.now()) / 1000));
        throw new Error(`Too many failed PIN attempts. Wait ${sec}s before retrying.`);
      }
      const envelope = await loadEncryptedVault(cleanScopeId);
      if (!envelope) {
        throw new Error("No encrypted vault stored on this device");
      }
      try {
        await decryptVaultPayload(envelope, pinOrPassphrase, {
          deriveKeyFn: deriveKeyInWorker,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Invalid PIN or passphrase";
        if (!/Corrupted/i.test(msg)) {
          await recordFailedPinAttempt(Date.now(), cleanScopeId);
        }
        throw err;
      }
      await clearPinLockoutState(cleanScopeId);
    },
    [cleanScopeId],
  );

  const verifyBiometricReauth = useCallback(
    async (reason = "Confirm high-value AstroWallet transaction"): Promise<void> => {
      if (telegramBioAvailable) {
        const bio = await authenticateTelegramBiometric(reason);
        if (bio.authenticated) {
          const pinFromBio = await unwrapPinFromTelegramBiometric(bio.token).catch(() => null);
          if (pinFromBio) {
            await verifyPinOrPassphrase(pinFromBio);
            return;
          }
        }
      }
      const pin = await unlockWithFingerprint(resolveWebAuthnRpId(config.pwaOrigin), cleanScopeId);
      await verifyPinOrPassphrase(pin);
    },
    [
      telegramBioAvailable,
      unwrapPinFromTelegramBiometric,
      verifyPinOrPassphrase,
      config.pwaOrigin,
      cleanScopeId,
    ],
  );

  const addDerivedAccount = useCallback(
    async (label: string, pinOrPassphrase: string): Promise<LinkedAccount> =>
      withVaultMutex(async () => {
        if (!sessionVault.has()) {
          throw new Error("Unlock your vault before deriving a new account");
        }
        const envelope = await loadEncryptedVault(cleanScopeId);
        if (!envelope) {
          throw new Error("Encrypted vault missing from IndexedDB");
        }
        const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
          deriveKeyFn: deriveKeyInWorker,
        });

        const rawNext =
          decrypted.accounts
            .filter((acc) => !acc.importedSecret && acc.index < 1000 && acc.index !== 99)
            .reduce((max, acc) => Math.max(max, acc.index), -1) + 1;
        const nextIndex = rawNext === 99 ? 100 : rawNext;
        const derived = deriveStellarAccount(decrypted.mnemonic, nextIndex);
        const cleanLabel = (label.trim() || `Account #${nextIndex + 1}`).slice(0, 32);
        const nextMeta: VaultAccountMetadata = {
          index: nextIndex,
          label: cleanLabel,
          address: derived.publicKey,
        };
        derived.zeroize();

        const updatedAccounts = [...decrypted.accounts, nextMeta];
        const updatedEnvelope = await encryptVaultPayload(
          {
            mnemonic: decrypted.mnemonic,
            accounts: updatedAccounts,
            createdAt: decrypted.createdAt,
          },
          pinOrPassphrase,
          { deriveKeyFn: deriveKeyInWorker },
        );

        await saveEncryptedVault(updatedEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(updatedEnvelope.updatedAt);
        setAccountMetaList(stripImportedSecrets(updatedAccounts));
        setActiveIndex(nextIndex);

        const linked = toLinkedAccounts([nextMeta])[0];
        if (!linked) {
          throw new Error("Failed to construct linked account");
        }
        showToast(`Derived ${cleanLabel} (m/44'/148'/${nextIndex}')`);
        return linked;
      }),
    [cleanScopeId, showToast, withVaultMutex],
  );

  const activateDerivedAccountAtIndex = useCallback(
    async (index: number, label: string, pinOrPassphrase: string): Promise<LinkedAccount> =>
      withVaultMutex(async () => {
        if (!sessionVault.has()) {
          throw new Error("Unlock your vault before activating a derived key");
        }
        if (!Number.isInteger(index) || index < 0 || index > 50) {
          throw new Error("Derivation index must be between 0 and 50");
        }
        const envelope = await loadEncryptedVault(cleanScopeId);
        if (!envelope) {
          throw new Error("Encrypted vault missing from IndexedDB");
        }
        const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
          deriveKeyFn: deriveKeyInWorker,
        });
        const derived = deriveStellarAccount(decrypted.mnemonic, index);
        const existingByAddr = decrypted.accounts.find((acc) => acc.address === derived.publicKey);
        if (existingByAddr) {
          derived.zeroize();
          setActiveIndex(existingByAddr.index);
          const linkedExisting = toLinkedAccounts([existingByAddr])[0];
          if (!linkedExisting) throw new Error("Failed to resolve existing account");
          return linkedExisting;
        }

        const cleanLabel = (label.trim() || `Account #${index + 1}`).slice(0, 32);
        const nextMeta: VaultAccountMetadata = {
          index,
          label: cleanLabel,
          address: derived.publicKey,
        };
        derived.zeroize();

        // Migrate any legacy imported external key that previously occupied this seed index to >= 1000
        let maxImportedIdx = Math.max(
          999,
          decrypted.accounts.reduce((max, acc) => Math.max(max, acc.index), -1),
        );
        const migratedAccounts = decrypted.accounts.map((acc) => {
          if (acc.index === index && acc.importedSecret) {
            maxImportedIdx += 1;
            return { ...acc, index: maxImportedIdx };
          }
          return acc;
        });

        const updatedAccounts = [...migratedAccounts, nextMeta].sort((a, b) => a.index - b.index);
        const updatedEnvelope = await encryptVaultPayload(
          {
            mnemonic: decrypted.mnemonic,
            accounts: updatedAccounts,
            createdAt: decrypted.createdAt,
          },
          pinOrPassphrase,
          { deriveKeyFn: deriveKeyInWorker },
        );

        await saveEncryptedVault(updatedEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(updatedEnvelope.updatedAt);
        setAccountMetaList(stripImportedSecrets(updatedAccounts));
        setActiveIndex(index);

        const linked = toLinkedAccounts([nextMeta])[0];
        if (!linked) {
          throw new Error("Failed to construct linked account");
        }
        showToast(`Activated ${cleanLabel} (m/44'/148'/${index}')`);
        return linked;
      }),
    [cleanScopeId, showToast, withVaultMutex],
  );

  const importExternalSecretAccount = useCallback(
    async (secretSeed: string, label: string, pinOrPassphrase: string): Promise<LinkedAccount> =>
      withVaultMutex(async () => {
        if (!sessionVault.has()) {
          throw new Error("Unlock your vault before importing an external key");
        }
        const parsed = parseExternalSecretAccount(secretSeed);
        try {
          const envelope = await loadEncryptedVault(cleanScopeId);
          if (!envelope) {
            throw new Error("Encrypted vault missing from IndexedDB");
          }
          const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
            deriveKeyFn: deriveKeyInWorker,
          });
          const duplicate = decrypted.accounts.find((acc) => acc.address === parsed.publicKey);
          if (duplicate) {
            setActiveIndex(duplicate.index);
            const linkedDup = toLinkedAccounts([duplicate])[0];
            if (!linkedDup) throw new Error("Failed to resolve existing account");
            showToast(`Account ${duplicate.label} is already in your vault`, "info");
            return linkedDup;
          }

          const nextIndex =
            Math.max(
              999,
              decrypted.accounts.reduce((max, acc) => Math.max(max, acc.index), -1),
            ) + 1;
          const cleanLabel = (label.trim() || `External #${nextIndex + 1}`).slice(0, 32);
          const nextMeta: VaultAccountMetadata = {
            index: nextIndex,
            label: cleanLabel,
            address: parsed.publicKey,
            importedSecret: parsed.secretKey,
          };

          const updatedAccounts = [...decrypted.accounts, nextMeta];
          const updatedEnvelope = await encryptVaultPayload(
            {
              mnemonic: decrypted.mnemonic,
              accounts: updatedAccounts,
              createdAt: decrypted.createdAt,
            },
            pinOrPassphrase,
            { deriveKeyFn: deriveKeyInWorker },
          );

          await saveEncryptedVault(updatedEnvelope, cleanScopeId);
          sessionVault.setImportedSecret(parsed.publicKey, parsed.secretKey);
          setLocalVaultUpdatedAt(updatedEnvelope.updatedAt);
          setAccountMetaList(stripImportedSecrets(updatedAccounts));
          setActiveIndex(nextIndex);

          const linked = toLinkedAccounts([nextMeta])[0];
          if (!linked) {
            throw new Error("Failed to construct imported account");
          }
          showToast(`Imported external account "${cleanLabel}"`);
          return linked;
        } finally {
          parsed.zeroize();
        }
      }),
    [cleanScopeId, showToast, withVaultMutex],
  );

  const isImportedAccount = useCallback(
    (address: string) => sessionVault.hasImportedSecret(address),
    [],
  );

  const renameDerivedAccount = useCallback(
    async (index: number, newLabel: string, pinOrPassphrase: string) =>
      withVaultMutex(async () => {
        const cleaned = newLabel.trim();
        if (!cleaned) {
          throw new Error("Account label cannot be empty");
        }
        const envelope = await loadEncryptedVault(cleanScopeId);
        if (!envelope) {
          throw new Error("Encrypted vault missing from IndexedDB");
        }
        const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
          deriveKeyFn: deriveKeyInWorker,
        });
        if (!decrypted.accounts.some((acc) => acc.index === index)) {
          throw new Error(`Account index ${index} not found in vault`);
        }

        const updatedAccounts = decrypted.accounts.map((acc) =>
          acc.index === index ? { ...acc, label: cleaned.slice(0, 32) } : acc,
        );
        const updatedEnvelope = await encryptVaultPayload(
          {
            mnemonic: decrypted.mnemonic,
            accounts: updatedAccounts,
            createdAt: decrypted.createdAt,
          },
          pinOrPassphrase,
          { deriveKeyFn: deriveKeyInWorker },
        );
        await saveEncryptedVault(updatedEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(updatedEnvelope.updatedAt);
        setAccountMetaList(stripImportedSecrets(updatedAccounts));
        showToast(`Renamed account to "${cleaned}"`);
      }),
    [cleanScopeId, showToast, withVaultMutex],
  );

  const saveContact = useCallback(
    async (input: { label: string; address: string; defaultMemo?: string | undefined }) => {
      const cleanLabel = input.label.trim();
      const cleanAddr = input.address.trim();
      if (!cleanLabel) throw new Error("Contact label is required");
      if (!cleanAddr) throw new Error("Contact Stellar address is required");

      const nextEntry: ContactEntry = {
        id: `c_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        label: cleanLabel.slice(0, 40),
        address: cleanAddr,
        defaultMemo: input.defaultMemo?.trim() || undefined,
        createdAt: Math.floor(Date.now() / 1000),
      };
      const filtered = contacts.filter((c) => c.address !== cleanAddr);
      const updated = [nextEntry, ...filtered].slice(0, 50);
      await saveContacts(updated, cleanScopeId);
      setContacts(updated);
      showToast(`Saved contact "${nextEntry.label}"`);
      return nextEntry;
    },
    [contacts, cleanScopeId, showToast],
  );

  const deleteContact = useCallback(
    async (id: string) => {
      const updated = contacts.filter((c) => c.id !== id);
      await saveContacts(updated, cleanScopeId);
      setContacts(updated);
      showToast("Removed contact", "info");
    },
    [contacts, cleanScopeId, showToast],
  );

  const lockVault = useCallback(() => {
    vaultGenerationRef.current += 1;
    chainFetchSeqRef.current += 1;
    tonFetchSeqRef.current += 1;
    tonEnabledRef.current = false;
    inMemorySessionPinRef.current = null;
    setTonAccount(null);
    setPendingTonConnectTx(null);
    sessionVault.clear();
    clearCachedClaimSecret();
    clearSessionLease();
    setAccountMetaList([]);
    setRawAccountState(null);
    setTonState(null);
    setRecentPayments([]);
    setRecentTrades([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setVaultStatus("locked");
  }, [clearSessionLease]);

  // Auto-lock after 15 minutes of inactivity or > 5 minutes in background tab
  useEffect(() => {
    if (vaultStatus !== "unlocked" || typeof window === "undefined") {
      return undefined;
    }

    const INACTIVITY_MS = 15 * 60 * 1000;
    const BACKGROUND_LOCK_MS = 5 * 60 * 1000;
    let lastLeaseExtendAt = Date.now();

    let timer = window.setTimeout(() => {
      lockVault();
      showToast("Vault auto-locked after 15 minutes of inactivity", "info");
    }, INACTIVITY_MS);

    const resetInactivityTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        lockVault();
        showToast("Vault auto-locked after 15 minutes of inactivity", "info");
      }, INACTIVITY_MS);
      const now = Date.now();
      if (now - lastLeaseExtendAt > 5 * 60 * 1000 && inMemoryLeaseExpiresAtRef.current) {
        lastLeaseExtendAt = now;
        void saveSessionLease();
      }
    };

    let hiddenAt: number | null = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
        if (expressSessionMinutesRef.current === 0) {
          lockVault();
          return;
        }
        hiddenAt = Date.now();
      } else if (hiddenAt !== null) {
        const elapsed = Date.now() - hiddenAt;
        hiddenAt = null;
        if (elapsed > BACKGROUND_LOCK_MS) {
          lockVault();
          showToast("Vault locked after staying in background", "info");
        }
      }
    };

    const opts: AddEventListenerOptions = { passive: true };
    window.addEventListener("pointerdown", resetInactivityTimer, opts);
    window.addEventListener("keydown", resetInactivityTimer, opts);
    window.addEventListener("touchstart", resetInactivityTimer, opts);
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointerdown", resetInactivityTimer);
      window.removeEventListener("keydown", resetInactivityTimer);
      window.removeEventListener("touchstart", resetInactivityTimer);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [vaultStatus, lockVault, showToast, loadValidSessionLease, saveSessionLease]);

  const wipeLocalVault = useCallback(async () => {
    vaultGenerationRef.current += 1;
    chainFetchSeqRef.current += 1;
    tonFetchSeqRef.current += 1;
    tonEnabledRef.current = false;
    inMemorySessionPinRef.current = null;
    setTonAccount(null);
    setPendingTonConnectTx(null);
    clearSessionLease();
    clearCachedClaimSecret();
    await updateTelegramBiometricToken("").catch(() => false);
    await tgSecureStorageRemove(bioWrapKey).catch(() => false);
    await tgSecureStorageRemove(securePinKey).catch(() => false);
    await clearAllTonConnectSessions(cleanScopeId).catch(() => undefined);
    await clearPinLockoutState(cleanScopeId).catch(() => undefined);
    await deleteEncryptedVault(cleanScopeId);
    sessionVault.clear();
    setCloudSyncEligible(false);
    cloudSyncEligibleRef.current = false;
    setLocalVaultUpdatedAt(null);
    setAccountMetaList([]);
    setRawAccountState(null);
    setTonState(null);
    setTonConnectSessions([]);
    setRecentPayments([]);
    setRecentTrades([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setFingerprintEnrolled(false);
    setVaultStatus("uninitialized");
    showToast("Local vault wiped from this device", "info");
  }, [bioWrapKey, securePinKey, cleanScopeId, clearSessionLease, showToast]);

  const fundActiveTestnetAccount = useCallback(async () => {
    if (!activeAccount) {
      throw new Error("No active account selected");
    }
    const targetAddr = activeAccount.address;
    const targetNet = config.network;
    setLoadingChain(true);
    setChainError(null);
    try {
      await stellarClient.fundWithFriendbot(targetAddr);
      await refreshChainState();
      showToast("Funded 10,000 Testnet XLM via Friendbot");
    } catch (err) {
      if (activeAddressRef.current === targetAddr && networkRef.current === targetNet) {
        const msg = err instanceof Error ? err.message : "Friendbot funding failed";
        setChainError(msg);
      }
      throw err;
    } finally {
      if (activeAddressRef.current === targetAddr && networkRef.current === targetNet) {
        setLoadingChain(false);
      }
    }
  }, [activeAccount, config.network, stellarClient, refreshChainState, showToast]);

  const fundAnyTestnetAddress = useCallback(
    async (address: ClassicAddress) => {
      await stellarClient.fundWithFriendbot(address);
      if (activeAccount?.address === address) {
        await refreshChainState();
      }
      showToast(`Funded ${address.slice(0, 6)}…${address.slice(-4)} on Testnet`);
    },
    [stellarClient, activeAccount, refreshChainState, showToast],
  );

  const enqueueAccountTx = useCallback(
    <T,>(accountKey: string, task: () => Promise<T>): Promise<T> =>
      enqueueSharedAccountTx(accountKey, task),
    [],
  );

  const sendPayment = useCallback(
    async (params: SendPaymentParams): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) =>
        enqueueAccountTx(keypair.publicKey(), async () => {
          const result = await stellarClient.buildAndSubmitPayment({
            sourceKeypair: keypair,
            destination: params.destination,
            amount: params.amount,
            assetCode: params.assetCode,
            assetIssuer: params.assetIssuer,
            memoText: params.memoText,
            typedMemo: params.typedMemo,
          });
          await refreshChainState();
          reportTelemetryEvent({
            apiBaseUrl: config.apiBaseUrl,
            network: config.network,
            sessionToken: sessionTokenRef.current,
            eventType: "tx_sent",
            txHash: result.hash,
            assetCode: params.assetCode,
            amountEst: params.amount,
          });
          showToast(`Sent ${params.amount} ${params.assetCode} cleanly`);
          return result;
        }),
      );
    },
    [
      withActiveKeypair,
      enqueueAccountTx,
      stellarClient,
      refreshChainState,
      config.apiBaseUrl,
      config.network,
      showToast,
    ],
  );

  const executePathSwap = useCallback(
    async (params: ExecutePathSwapParams): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) =>
        enqueueAccountTx(keypair.publicKey(), async () => {
          const result = await stellarClient.submitPathPaymentStrictSend({
            sourceKeypair: keypair,
            sendAsset: {
              assetCode: params.sendAssetCode,
              assetIssuer: params.sendAssetIssuer,
            },
            sendAmount: params.sendAmount,
            destAsset: {
              assetCode: params.destAssetCode,
              assetIssuer: params.destAssetIssuer,
            },
            destMin: params.destMin,
            path: params.path?.map((hop) => ({
              assetCode: hop.assetCode,
              assetIssuer: hop.assetIssuer as ClassicAddress | undefined,
            })),
          });
          await refreshChainState();
          showToast(`Swapped ${params.sendAmount} ${params.sendAssetCode} → ${params.destAssetCode}`);
          return result;
        }),
      );
    },
    [withActiveKeypair, enqueueAccountTx, stellarClient, refreshChainState, showToast],
  );

  const submitAccountDataEntry = useCallback(
    async (name: string, value: string | null): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) => {
        const res = await stellarClient.submitManageData({
          sourceKeypair: keypair,
          name,
          value,
        });
        await refreshChainState();
        showToast(`Updated account Data entry "${name}"`);
        return res;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const addOrRemoveTrustline = useCallback(
    async (
      assetCode: string,
      assetIssuer: ClassicAddress,
      limit?: string,
    ): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) =>
        enqueueAccountTx(keypair.publicKey(), async () => {
          const result = await stellarClient.submitChangeTrust({
            sourceKeypair: keypair,
            assetCode,
            assetIssuer,
            limit,
          });
          await refreshChainState();
          reportTelemetryEvent({
            apiBaseUrl: config.apiBaseUrl,
            network: config.network,
            sessionToken: sessionTokenRef.current,
            eventType: "trustline_added",
            txHash: result.hash,
            assetCode,
          });
          showToast(
            limit === "0" ? `Removed ${assetCode} trustline` : `Activated ${assetCode} trustline`,
          );
          return result;
        }),
      );
    },
    [
      withActiveKeypair,
      enqueueAccountTx,
      stellarClient,
      refreshChainState,
      config.apiBaseUrl,
      config.network,
      showToast,
    ],
  );

  const reclaimZeroBalanceReserves = useCallback(async (): Promise<{
    hash: string;
    ledger: number;
    reclaimedXlm: string;
  }> => {
    const trustlines = accountState?.reclaimableTrustlines ?? [];
    if (trustlines.length === 0) {
      throw new Error("No zero-balance trustlines available to reclaim");
    }
    return withActiveKeypair(async (keypair) => {
      const result = await stellarClient.reclaimZeroBalanceTrustlines({
        sourceKeypair: keypair,
        trustlines,
      });
      await refreshChainState();
      showToast(`Reclaimed +${result.reclaimedXlm} XLM reserve`);
      return result;
    });
  }, [accountState?.reclaimableTrustlines, withActiveKeypair, stellarClient, refreshChainState, showToast]);

  const claimBalanceById = useCallback(
    async (balanceId: string): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) => {
        const result = await stellarClient.claimClaimableBalance({
          sourceKeypair: keypair,
          balanceId,
        });
        await refreshChainState();
        showToast("Claimed balance onto ledger");
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const placeSdexOffer = useCallback(
    async (params: PlaceSdexOfferParams): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) => {
        const result = await stellarClient.submitSdexSellOffer({
          sourceKeypair: keypair,
          selling: { assetCode: params.sellingCode, assetIssuer: params.sellingIssuer },
          buying: { assetCode: params.buyingCode, assetIssuer: params.buyingIssuer },
          amount: params.amount,
          price: params.price,
          offerId: params.offerId,
        });
        await refreshChainState();
        showToast("Submitted Classic SDEX order");
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const signRawXdrWithShield = useCallback(
    async (
      xdrBase64: string,
      allowWarning = false,
    ): Promise<{ signedXdr: string; scanReport: ScanReport }> => {
      const trimmedXdr = xdrBase64.trim();
      const scan = scanTransactionEnvelopeXdr(trimmedXdr, {
        networkPassphrase: config.networkPassphrase,
        verifiedAssets,
      });
      if (
        activeAccount?.address &&
        scan.decoded.sourceAccount &&
        scan.decoded.sourceAccount !== activeAccount.address
      ) {
        throw new Error(
          `SOURCE_ACCOUNT_MISMATCH: transaction source ${scan.decoded.sourceAccount} does not match active account ${activeAccount.address}`,
        );
      }
      if (scan.report.verdict === "malicious") {
        throw new Error(
          `Scan & Shield blocked malicious XDR: ${scan.report.findings[0]?.title ?? "threat detected"}`,
        );
      }
      if (scan.report.verdict === "warning" && !allowWarning) {
        throw new Error(
          `Scan & Shield warning: ${scan.report.findings[0]?.title ?? "review required"}. Enable "Allow warnings" to sign explicitly.`,
        );
      }
      const hasSorobanOp = scan.decoded?.operations.some(
        (op) => op.type === "invokeHostFunction" || Boolean(op.soroban),
      );
      if (hasSorobanOp && config.network === "mainnet") {
        const sim = await sorobanDevClient.simulateRawXdr(trimmedXdr);
        if (!sim.ok) {
          throw new Error(
            `Mainnet Soroban pre-sign simulation failed: ${sim.error ?? "unknown simulation error"}`,
          );
        }
      }
      return withActiveKeypair(async (keypair) => {
        const signedXdr = signTransactionXdrEnvelope(
          trimmedXdr,
          config.networkPassphrase,
          keypair,
        );
        return { signedXdr, scanReport: scan.report };
      });
    },
    [
      activeAccount?.address,
      verifiedAssets,
      config.networkPassphrase,
      config.network,
      sorobanDevClient,
      withActiveKeypair,
    ],
  );

  const signAndSubmitRawXdrWithShield = useCallback(
    async (
      xdrBase64: string,
      allowWarning = false,
      intentAuth?: RelayIntentAuth,
    ): Promise<{
      hash: string;
      ledger: number;
      signedXdr: string;
      channel: "soroban-rpc" | "horizon";
    }> => {
      const addr = activeAccount?.address ?? "default";
      return enqueueAccountTx(addr, async () => {
        const { signedXdr } = await signRawXdrWithShield(xdrBase64, allowWarning);
        const submitted = await withActiveKeypair((sourceKeypair) =>
          sorobanDevClient.submitRawSignedXdr(signedXdr, {
            sourceKeypair,
            intentAuth,
          }),
        );
        await refreshChainState();
        showToast(`Submitted via ${submitted.channel}`);
        return {
          ...submitted,
          signedXdr,
        };
      });
    },
    [
      activeAccount?.address,
      enqueueAccountTx,
      signRawXdrWithShield,
      withActiveKeypair,
      sorobanDevClient,
      refreshChainState,
      showToast,
    ],
  );

  const fetchDevTelemetry = useCallback(
    () => sorobanDevClient.fetchNetworkTelemetry(),
    [sorobanDevClient],
  );

  const simulateSorobanCall = useCallback(
    (params: { contractId: ContractAddress; fnName: string; argsJson: string }) =>
      sorobanDevClient.simulateContractCall({
        ...params,
        sourceAddress: activeAccount?.address as ClassicAddress | undefined,
      }),
    [sorobanDevClient, activeAccount],
  );

  const invokeSorobanWrite = useCallback(
    async (params: {
      contractId: ContractAddress;
      fnName: string;
      argsJson: string;
    }): Promise<SorobanInvokeResult> => {
      return withActiveKeypair(async (keypair) => {
        const res = await sorobanDevClient.invokeContractWrite({
          sourceKeypair: keypair,
          ...params,
        });
        await refreshChainState();
        showToast(`Soroban call confirmed in ledger #${res.ledger}`);
        return res;
      });
    },
    [withActiveKeypair, sorobanDevClient, refreshChainState, showToast],
  );

  const simulateRawXdr = useCallback(
    (xdrBase64: string) => sorobanDevClient.simulateRawXdr(xdrBase64),
    [sorobanDevClient],
  );

  const buildDevTemplateXdr = useCallback(
    (template: DevTemplateKind) => {
      if (!activeAccount) {
        throw new Error("Unlock your vault to generate a live-sequence XDR template");
      }
      return sorobanDevClient.buildTemplateUnsignedXdr({
        sourceAddress: activeAccount.address as ClassicAddress,
        template,
      });
    },
    [activeAccount, sorobanDevClient],
  );

  const derivePublicKeyPreview = useCallback(
    (count: number): DerivedPublicKeyPreview[] => {
      if (!sessionVault.has()) {
        throw new Error("Unlock vault to inspect SEP-0005 derivation table");
      }
      const clamped = Math.max(1, Math.min(10, Math.trunc(count)));
      return sessionVault.withMnemonic((mnemonic) => {
        const rows: DerivedPublicKeyPreview[] = [];
        for (let i = 0; i < clamped; i += 1) {
          const derived = deriveStellarAccount(mnemonic, i);
          try {
            let smartAddr: string | undefined;
            if (config.smartAccountWasmHash) {
              try {
                smartAddr = deriveCounterfactualSmartAccount({
                  guardianAddress: derived.publicKey,
                  wasmHashHex: config.smartAccountWasmHash,
                  networkPassphrase: config.networkPassphrase,
                }).contractAddress;
              } catch {
                smartAddr = undefined;
              }
            }
            rows.push({
              index: derived.index,
              derivationPath: derived.derivationPath,
              publicKey: derived.publicKey,
              rawHex: publicKeyToRawHex(derived.publicKey),
              counterfactualSmartAddress: smartAddr,
            });
          } finally {
            derived.zeroize();
          }
        }
        return rows;
      });
    },
    [config.smartAccountWasmHash, config.networkPassphrase],
  );

  const deriveAgentAccountAddress = useCallback((): ClassicAddress | null => {
    if (!sessionVault.has()) return null;
    try {
      return sessionVault.withMnemonic((mnemonic) => {
        const derived = deriveStellarAccount(mnemonic, AGENT_DERIVATION_INDEX);
        try {
          return derived.publicKey;
        } finally {
          derived.zeroize();
        }
      });
    } catch {
      return null;
    }
  }, []);

  const signAgentX402Challenge = useCallback(
    (challenge: {
      x402Version: number;
      network: string;
      asset: string;
      amount: string;
      payTo: string;
      nonce: string;
    }) => {
      if (!sessionVault.has()) {
        throw new Error("Unlock vault before signing agent x402 payments.");
      }
      return sessionVault.withMnemonic((mnemonic) => {
        const derived = deriveStellarAccount(mnemonic, AGENT_DERIVATION_INDEX);
        const kp = derived.toKeypair();
        try {
          return signX402ChallengeWithKeypair(kp, challenge);
        } finally {
          derived.zeroize();
        }
      });
    },
    [],
  );

  const signSep10ChallengeXdr = useCallback(
    async (challengeXdr: string): Promise<string> => {
      return withActiveKeypair(async (keypair) =>
        signSep10ChallengeTransaction(challengeXdr, keypair, config.networkPassphrase),
      );
    },
    [withActiveKeypair, config.networkPassphrase],
  );

  const signActiveSep53Message = useCallback(
    async (message: string) => {
      return withActiveKeypair(async (keypair) => ({
        signature: signChallengeMessage(keypair, message),
        signerAddress: keypair.publicKey() as ClassicAddress,
      }));
    },
    [withActiveKeypair],
  );

  const signAuthEntryWithShield = useCallback(
    async (entryXdr: string, allowWarning = false) => {
      const inspection = await inspectDappAuthEntrySecurity(
        entryXdr,
        config.networkPassphrase,
      );
      if (inspection.blockedReason) {
        throw new Error(`Scan & Shield blocked Soroban auth entry: ${inspection.blockedReason}`);
      }
      const warning = inspection.findings.find((f) => f.severity === "warning");
      if (warning && !allowWarning) {
        throw new Error(`Warning requires review: ${warning.title}`);
      }
      const signed = await withActiveKeypair((keypair) =>
        signSorobanAuthEntry(keypair, entryXdr, {
          networkPassphrase: config.networkPassphrase,
        }),
      );
      return {
        signedAuthEntry: signed.signedAuthEntry,
        signerAddress: signed.signerAddress,
        inspection,
      };
    },
    [withActiveKeypair, config.networkPassphrase],
  );

  const bootstrapActiveAccount = useCallback(
    async (sessionToken: string) => {
      if (!sessionToken.trim()) {
        throw new Error("Open AstroWallet inside Telegram to claim sponsored activation.");
      }
      const apiBase = config.apiBaseUrl.replace(/\/+$/, "");
      return withActiveKeypair(async (keypair) =>
        enqueueAccountTx(keypair.publicKey(), async () => {
          const address = keypair.publicKey() as ClassicAddress;
          const mode = "sponsored_reserve" as const;
          const timestamp = Math.floor(Date.now() / 1000);
          const nonceBytes = new Uint8Array(12);
          crypto.getRandomValues(nonceBytes);
          const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
          const challengeMsg = `astrowallet-bootstrap:v1:${config.network}:${mode}:${address}:${timestamp}:${nonce}`;
          const signatureBase64 = signChallengeMessage(keypair, challengeMsg);
          const res = await fetch(`${apiBase}/v1/relay/bootstrap`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Astro-Network": config.network,
              Authorization: `Bearer ${sessionToken}`,
            },
            body: JSON.stringify({
              address,
              mode,
              timestamp,
              nonce,
              signatureBase64,
            }),
          });
          const body = (await res.json().catch(() => ({}))) as {
            error?: string;
            mode?: string;
            sponsorSignedXdr?: string;
            hash?: string;
            status?: string;
          };
          if (!res.ok) {
            throw new Error(body.error ?? `Sponsored activation failed (${res.status})`);
          }
          let finalHash = body.hash;
          if (body.sponsorSignedXdr) {
            const cosignedXdr = signTransactionXdrEnvelope(
              body.sponsorSignedXdr,
              config.networkPassphrase,
              keypair,
            );
            const submitted = await sorobanDevClient.submitRawSignedXdr(cosignedXdr, {
              sourceKeypair: keypair,
            });
            finalHash = submitted.hash;
          }
          await refreshChainState();
          showToast("Account activated on Stellar via sponsored bootstrap.", "success");
          return {
            hash: finalHash,
            address,
            status: finalHash ? "confirmed" : (body.status ?? "submitted"),
          };
        }),
      );
    },
    [
      config.apiBaseUrl,
      config.network,
      config.networkPassphrase,
      withActiveKeypair,
      enqueueAccountTx,
      sorobanDevClient,
      refreshChainState,
      showToast,
    ],
  );

  const signConnectChallenge = useCallback(
    async (
      message: string,
      selectedIndices: readonly number[],
      includePairedSmartAccount = false,
      preferredDefaultAddress?: string,
    ): Promise<SignedConnectAccountProof[]> => {
      if (!sessionVault.has()) {
        throw new Error("Unlock your vault first to sign the Telegram link challenge");
      }
      const chosen = accountMetaList.filter((m) => selectedIndices.includes(m.index));
      if (chosen.length === 0) {
        throw new Error("Select at least one account to link");
      }

      return sessionVault.withMnemonic((mnemonic) => {
        const proofs: SignedConnectAccountProof[] = [];
        for (let i = 0; i < chosen.length; i += 1) {
          const meta = chosen[i];
          if (!meta) continue;
          const isImported = sessionVault.hasImportedSecret(meta.address);
          const signer = isImported
            ? sessionVault.withImportedSecret(meta.address, (secret) =>
                parseExternalSecretAccount(secret),
              )
            : deriveStellarAccount(mnemonic, meta.index);
          try {
            const kp = signer.toKeypair();
            const signatureBase64 = signChallengeMessage(kp, message);
            const isClassicDefault = preferredDefaultAddress
              ? signer.publicKey === preferredDefaultAddress
              : i === 0;
            proofs.push({
              address: signer.publicKey,
              kind: "classic",
              label: meta.label,
              isDefault: isClassicDefault,
              signatureBase64,
            });
            if (i === 0 && !isImported && includePairedSmartAccount && config.smartAccountWasmHash) {
              const smart = deriveCounterfactualSmartAccount({
                guardianAddress: signer.publicKey,
                wasmHashHex: config.smartAccountWasmHash,
                networkPassphrase: config.networkPassphrase,
              });
              const boundMsg = formatSmartAccountLinkMessage(message, smart.contractAddress);
              proofs.push({
                address: smart.contractAddress,
                kind: "smart",
                label: `${meta.label} Smart`,
                isDefault: preferredDefaultAddress === smart.contractAddress,
                guardianAddress: signer.publicKey,
                signatureBase64: signChallengeMessage(kp, boundMsg),
              });
            }
          } finally {
            signer.zeroize();
          }
        }
        return proofs;
      });
    },
    [accountMetaList, config.smartAccountWasmHash, config.networkPassphrase],
  );

  const fundClaimEscrow = useCallback(
    async (params: {
      escrowContractId: ContractAddress;
      claimIdHex: string;
      amount: string;
      assetCode: string;
      assetIssuer?: string | undefined;
      expiresAtUnix: number;
      intentAuth?: RelayIntentAuth | undefined;
    }) => {
      return withActiveKeypair(async (keypair) => {
        const res = await stellarClient.fundClaimEscrow({
          sourceKeypair: keypair,
          ...params,
        });
        await refreshChainState();
        showToast(`Escrow funded (${params.amount} ${params.assetCode})`);
        return res;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const claimFromEscrow = useCallback(
    async (params: {
      escrowContractId: ContractAddress;
      claimIdHex: string;
      claimSecretSeedHex: string;
      intentAuth?: RelayIntentAuth | undefined;
    }) => {
      return withActiveKeypair(async (keypair) => {
        const res = await stellarClient.claimFromEscrow({
          sourceKeypair: keypair,
          ...params,
        });
        await refreshChainState();
        showToast("Claimed escrowed funds onto ledger");
        return res;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const cancelClaimEscrow = useCallback(
    async (params: {
      escrowContractId: ContractAddress;
      claimIdHex: string;
      intentAuth?: RelayIntentAuth | undefined;
    }) => {
      return withActiveKeypair(async (keypair) => {
        const res = await stellarClient.cancelClaimEscrow({
          sourceKeypair: keypair,
          ...params,
        });
        await refreshChainState();
        showToast("Escrow cancelled & funds reclaimed");
        return res;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const refundExpiredClaimEscrow = useCallback(
    async (params: {
      escrowContractId: ContractAddress;
      claimIdHex: string;
      recipientAddress?: StellarAddress | undefined;
      intentAuth?: RelayIntentAuth | undefined;
    }) => {
      return withActiveKeypair(async (keypair) => {
        const res = await stellarClient.refundExpiredClaimEscrow({
          sourceKeypair: keypair,
          ...params,
        });
        await refreshChainState();
        showToast("Expired escrow refunded");
        return res;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const value: WalletContextValue = useMemo(
    () => ({
      config,
      vaultStatus,
      accounts,
      activeAccount,
      activeIndex,
      accountState,
      recentPayments,
      recentTrades,
      claimableBalances,
      openOffers,
      contacts,
      toast,
      loadingChain,
      chainError,
      fingerprintSupported,
      fingerprintEnrolled,
      telegramBioAvailable,
      verifiedAssets,
      tokenMetaMap,
      tonAccount,
      tonWalletVersion,
      tonState,
      loadingTonChain,
      tonChainError,
      tonConnectSessions,
      pendingTonConnectTx,
      localVaultUpdatedAt,
      cloudSyncEligible,
      storageScopeId: cleanScopeId,
      setActiveIndex,
      setTonWalletVersion,
      ensureTonAccount,
      showToast,
      dismissToast,
      createOrImportVault,
      reEncryptLocalVault,
      restoreAgVaultJson,
      syncFromNewerCloudBackup,
      exportAgVaultJson,
      exportCloudBackupJson,
      revealMnemonicWithPin,
      verifyPinOrPassphrase,
      verifyBiometricReauth,
      unlockWithPin,
      unlockWithBiometric,
      expressSessionMinutes,
      setExpressSessionMinutes,
      enableFingerprint,
      disableFingerprint,
      addDerivedAccount,
      activateDerivedAccountAtIndex,
      importExternalSecretAccount,
      isImportedAccount,
      renameDerivedAccount,
      lockVault,
      wipeLocalVault,
      saveContact,
      deleteContact,
      refreshChainState,
      refreshTonState,
      fundActiveTestnetAccount,
      fundAnyTestnetAddress,
      sendPayment,
      sendTonPayment,
      previewTonConnectUri,
      approveTonConnectPairing,
      pairTonConnectUri,
      disconnectTonConnectSession,
      resolvePendingTonConnectTx,
      executePathSwap,
      submitAccountDataEntry,
      addOrRemoveTrustline,
      reclaimZeroBalanceReserves,
      claimBalanceById,
      placeSdexOffer,
      signRawXdrWithShield,
      signAndSubmitRawXdrWithShield,
      fetchDevTelemetry,
      simulateSorobanCall,
      invokeSorobanWrite,
      simulateRawXdr,
      buildDevTemplateXdr,
      derivePublicKeyPreview,
      deriveAgentAccountAddress,
      signAgentX402Challenge,
      signSep10ChallengeXdr,
      signActiveSep53Message,
      signAuthEntryWithShield,
      bootstrapActiveAccount,
      signConnectChallenge,
      fundClaimEscrow,
      claimFromEscrow,
      cancelClaimEscrow,
      refundExpiredClaimEscrow,
    }),
    [
      config,
      vaultStatus,
      accounts,
      activeAccount,
      activeIndex,
      accountState,
      recentPayments,
      recentTrades,
      claimableBalances,
      openOffers,
      contacts,
      toast,
      loadingChain,
      chainError,
      fingerprintSupported,
      fingerprintEnrolled,
      telegramBioAvailable,
      verifiedAssets,
      tokenMetaMap,
      tonAccount,
      tonWalletVersion,
      tonState,
      loadingTonChain,
      tonChainError,
      tonConnectSessions,
      pendingTonConnectTx,
      localVaultUpdatedAt,
      cloudSyncEligible,
      cleanScopeId,
      setActiveIndex,
      setTonWalletVersion,
      ensureTonAccount,
      showToast,
      dismissToast,
      createOrImportVault,
      reEncryptLocalVault,
      restoreAgVaultJson,
      syncFromNewerCloudBackup,
      exportAgVaultJson,
      exportCloudBackupJson,
      revealMnemonicWithPin,
      verifyPinOrPassphrase,
      verifyBiometricReauth,
      unlockWithPin,
      unlockWithBiometric,
      expressSessionMinutes,
      setExpressSessionMinutes,
      enableFingerprint,
      disableFingerprint,
      addDerivedAccount,
      activateDerivedAccountAtIndex,
      importExternalSecretAccount,
      isImportedAccount,
      renameDerivedAccount,
      lockVault,
      wipeLocalVault,
      saveContact,
      deleteContact,
      refreshChainState,
      refreshTonState,
      fundActiveTestnetAccount,
      fundAnyTestnetAddress,
      sendPayment,
      sendTonPayment,
      previewTonConnectUri,
      approveTonConnectPairing,
      pairTonConnectUri,
      disconnectTonConnectSession,
      resolvePendingTonConnectTx,
      executePathSwap,
      submitAccountDataEntry,
      addOrRemoveTrustline,
      reclaimZeroBalanceReserves,
      claimBalanceById,
      placeSdexOffer,
      signRawXdrWithShield,
      signAndSubmitRawXdrWithShield,
      fetchDevTelemetry,
      simulateSorobanCall,
      invokeSorobanWrite,
      simulateRawXdr,
      buildDevTemplateXdr,
      derivePublicKeyPreview,
      deriveAgentAccountAddress,
      signAgentX402Challenge,
      signSep10ChallengeXdr,
      signActiveSep53Message,
      signAuthEntryWithShield,
      bootstrapActiveAccount,
      signConnectChallenge,
      fundClaimEscrow,
      claimFromEscrow,
      cancelClaimEscrow,
      refundExpiredClaimEscrow,
    ],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside WalletProvider");
  }
  return ctx;
}
