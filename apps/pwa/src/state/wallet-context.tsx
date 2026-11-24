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
  createSorobanDevClient,
  createStellarClient,
  decryptVaultPayload,
  deleteEncryptedVault,
  deriveCounterfactualSmartAccount,
  deriveKeyInWorker,
  deriveStellarAccount,
  disableFingerprintUnlock,
  encryptVaultPayload,
  enrollFingerprintUnlock,
  fetchHeldAssetsTomlMetadata,
  isFingerprintSupported,
  loadBiometricRecord,
  loadContacts,
  loadEncryptedVault,
  parseAgVaultBackup,
  parseExternalSecretAccount,
  publicKeyToRawHex,
  saveContacts,
  saveEncryptedVault,
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
import type { TonAccountChainState } from "@astrowallet/ton-core";

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

const EXPRESS_SESSION_TTL_KEY = "aw_express_session_ttl_min";
const DEFAULT_EXPRESS_SESSION_MINUTES = 15;
const TG_SESSION_LEASE_KEY = "aw_session_lease_v1";

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

export interface PendingTonConnectTxRequest {
  requestId: string;
  walletClientId: string;
  dappClientId: string;
  dappName: string;
  dappUrl: string;
  validUntil: number;
  messages: Array<{
    address: string;
    amountNano: bigint;
    payload?: string | undefined;
    stateInit?: string | undefined;
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
  tonState: TonAccountChainState | null;
  loadingTonChain: boolean;
  tonChainError: string | null;
  tonConnectSessions: readonly StoredTonConnectSession[];
  pendingTonConnectTx: PendingTonConnectTxRequest | null;
  localVaultUpdatedAt: number | null;
  storageScopeId: string | undefined;

  setActiveIndex(index: number): void;
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
    status: "synced" | "push_merged" | "pin_required" | "up_to_date";
    envelopeJson?: string | undefined;
    accountCount?: number | undefined;
  }>;
  exportAgVaultJson(): Promise<string>;
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
  const sessionLeaseKey = cleanScopeId
    ? `${TG_SESSION_LEASE_KEY}:${cleanScopeId}`
    : TG_SESSION_LEASE_KEY;

  const [expressSessionMinutes, setExpressSessionMinutesState] = useState<number>(
    readExpressSessionMinutes,
  );

  const setExpressSessionMinutes = useCallback((minutes: 0 | 15 | 30 | 60) => {
    setExpressSessionMinutesState(minutes);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.setItem(EXPRESS_SESSION_TTL_KEY, String(minutes));
      }
    } catch {
      // Ignore storage errors
    }
    if (minutes === 0) {
      try {
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(sessionLeaseKey);
        }
      } catch {
        // Ignore
      }
      void tgSecureStorageRemove(sessionLeaseKey).catch(() => false);
    }
  }, [sessionLeaseKey]);

  const inMemoryLeaseRef = useRef<{ pin: string; expiresAt: number } | null>(null);

  const saveSessionLease = useCallback(
    async (pinOrPassphrase: string) => {
      // Never persist plaintext PINs in window.sessionStorage
      try {
        if (typeof window !== "undefined") {
          window.sessionStorage.removeItem(sessionLeaseKey);
        }
      } catch {
        // Ignore
      }
      if (expressSessionMinutes <= 0) {
        inMemoryLeaseRef.current = null;
        await tgSecureStorageRemove(sessionLeaseKey).catch(() => false);
        return;
      }
      const lease = {
        pin: pinOrPassphrase,
        expiresAt: Date.now() + expressSessionMinutes * 60 * 1000,
      };
      inMemoryLeaseRef.current = lease;
      await tgSecureStorageSet(sessionLeaseKey, JSON.stringify(lease)).catch(() => false);
    },
    [sessionLeaseKey, expressSessionMinutes],
  );

  const loadValidSessionLease = useCallback(async (): Promise<{
    pin: string;
    expiresAt: number;
  } | null> => {
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(sessionLeaseKey);
      }
    } catch {
      // Ignore
    }

    const mem = inMemoryLeaseRef.current;
    if (mem && Date.now() < mem.expiresAt) {
      return mem;
    }
    inMemoryLeaseRef.current = null;

    const parseLease = (raw: string | null) => {
      if (!raw) return null;
      try {
        const parsed = JSON.parse(raw) as { pin?: unknown; expiresAt?: unknown };
        if (
          typeof parsed.pin === "string" &&
          parsed.pin.length > 0 &&
          typeof parsed.expiresAt === "number" &&
          Date.now() < parsed.expiresAt
        ) {
          return { pin: parsed.pin, expiresAt: parsed.expiresAt };
        }
      } catch {
        // Ignore malformed lease
      }
      return null;
    };

    const secLease = parseLease(await tgSecureStorageGet(sessionLeaseKey).catch(() => null));
    if (secLease) {
      inMemoryLeaseRef.current = secLease;
      return secLease;
    }

    void tgSecureStorageRemove(sessionLeaseKey).catch(() => false);
    return null;
  }, [sessionLeaseKey]);

  const clearSessionLease = useCallback(() => {
    inMemoryLeaseRef.current = null;
    try {
      if (typeof window !== "undefined") {
        window.sessionStorage.removeItem(sessionLeaseKey);
      }
    } catch {
      // Ignore
    }
    void tgSecureStorageRemove(sessionLeaseKey).catch(() => false);
  }, [sessionLeaseKey]);
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
  const [accountMetaList, setAccountMetaList] = useState<VaultAccountMetadata[]>([]);
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

  const [tonAccount, setTonAccount] = useState<TonAccountSummary | null>(null);

  useEffect(() => {
    if (vaultStatus !== "unlocked" || !sessionVault.has()) {
      setTonAccount(null);
      return undefined;
    }
    let cancelled = false;
    void loadTonCore()
      .then(({ deriveTonAccount }) => {
        if (cancelled || !sessionVault.has()) return;
        const summary = sessionVault.withMnemonic((mnemonic) => {
          const tonDerivationIndex = resolveTonDerivationIndex(activeAccount, activeIndex);
          const derived = deriveTonAccount(
            mnemonic,
            tonDerivationIndex,
            config.tonNetwork,
            "v4r2",
          );
          try {
            return derived.toSummary();
          } finally {
            derived.zeroize();
          }
        });
        if (!cancelled) {
          setTonAccount(summary);
        }
      })
      .catch(() => {
        if (!cancelled) setTonAccount(null);
      });
    return () => {
      cancelled = true;
    };
  }, [vaultStatus, activeAccount, activeIndex, config.tonNetwork]);

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const [vaultEnvelope, fpSupported, tgBio, bioRecord, tgPin, storedContacts, storedTcSessions] =
        await Promise.all([
          loadEncryptedVault(cleanScopeId).catch(() => null),
          isFingerprintSupported().catch(() => false),
          isTelegramBiometricAvailable().catch(() => false),
          loadBiometricRecord(cleanScopeId).catch(() => null),
          tgSecureStorageGet(securePinKey).catch(() => null),
          loadContacts(cleanScopeId).catch(() => []),
          loadTonConnectSessions(cleanScopeId).catch(() => []),
        ]);
      if (cancelled) return;
      const bmSaved = Boolean(getTelegramWebApp()?.BiometricManager?.isBiometricTokenSaved);
      setTelegramBioAvailable(tgBio);
      setFingerprintSupported(fpSupported || tgBio);
      setFingerprintEnrolled(bioRecord !== null || Boolean(tgPin) || bmSaved);
      setContacts(storedContacts);
      setTonConnectSessions(storedTcSessions);
      setLocalVaultUpdatedAt(vaultEnvelope?.updatedAt ?? null);
      if (!vaultEnvelope) {
        setVaultStatus("uninitialized");
        return;
      }
      const lease = await loadValidSessionLease();
      if (lease && !cancelled) {
        try {
          const decrypted = await decryptVaultPayload(vaultEnvelope, lease.pin, {
            deriveKeyFn: deriveKeyInWorker,
          });
          if (!cancelled) {
            sessionVault.set(decrypted.mnemonic);
            for (const acc of decrypted.accounts) {
              if (acc.importedSecret) {
                sessionVault.setImportedSecret(acc.address, acc.importedSecret);
              }
            }
            setAccountMetaList(decrypted.accounts);
            setActiveIndex(decrypted.accounts[0]?.index ?? 0);
            setVaultStatus("unlocked");
            return;
          }
        } catch {
          clearSessionLease();
        }
      }
      if (!cancelled) {
        setVaultStatus("locked");
      }
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, [cleanScopeId, securePinKey, loadValidSessionLease, clearSessionLease]);

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
    if (!activeAccount) return;
    const seq = ++chainFetchSeqRef.current;
    const targetAddress = activeAccount.address;
    setLoadingChain(true);
    setChainError(null);
    try {
      const state = await stellarClient.fetchAccountState(targetAddress);
      if (seq !== chainFetchSeqRef.current) return;
      if (!state.funded) {
        setRawAccountState(state);
        setRecentPayments([]);
        setRecentTrades([]);
        setClaimableBalances([]);
        setOpenOffers([]);
        return;
      }
      const [payments, trades, claimables, offers] = await Promise.all([
        stellarClient.fetchRecentPayments(targetAddress, 25),
        stellarClient.fetchRecentTrades(targetAddress, 20),
        stellarClient.fetchClaimableBalances(targetAddress, 20),
        stellarClient.fetchOpenOffers(targetAddress, 20),
      ]);
      if (seq !== chainFetchSeqRef.current) return;
      setRawAccountState(state);
      setRecentPayments(payments);
      setRecentTrades(trades);
      setClaimableBalances(claimables);
      setOpenOffers(offers);
    } catch (err) {
      if (seq !== chainFetchSeqRef.current) return;
      setChainError(err instanceof Error ? err.message : "Failed to load Stellar Horizon state");
    } finally {
      if (seq === chainFetchSeqRef.current) {
        setLoadingChain(false);
      }
    }
  }, [activeAccount, stellarClient]);

  useEffect(() => {
    if (vaultStatus === "unlocked" && activeAccount) {
      void refreshChainState();
    } else {
      chainFetchSeqRef.current += 1;
      setLoadingChain(false);
      setRawAccountState(null);
      setRecentPayments([]);
      setRecentTrades([]);
      setClaimableBalances([]);
      setOpenOffers([]);
    }
  }, [vaultStatus, activeAccount, refreshChainState]);

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
      sessionVault.clear();
    };
    window.addEventListener("pagehide", handleUnload);
    window.addEventListener("beforeunload", handleUnload);
    return () => {
      window.removeEventListener("pagehide", handleUnload);
      window.removeEventListener("beforeunload", handleUnload);
      sessionVault.clear();
    };
  }, []);

  const refreshTonState = useCallback(async () => {
    if (!tonAccount || config.tonRpcUrls.length === 0) {
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
      const state = await tonClient.getAccountState(tonAccount.friendlyAddress);
      if (seq !== tonFetchSeqRef.current) return;
      setTonState(state);
    } catch (err) {
      if (seq !== tonFetchSeqRef.current) return;
      setTonChainError(err instanceof Error ? err.message : "Failed to fetch TON account state");
    } finally {
      if (seq === tonFetchSeqRef.current) {
        setLoadingTonChain(false);
      }
    }
  }, [tonAccount, getTonClient, config.tonRpcUrls.length]);

  useEffect(() => {
    if (vaultStatus === "unlocked" && tonAccount && config.tonRpcUrls.length > 0) {
      void refreshTonState();
    } else {
      tonFetchSeqRef.current += 1;
      setLoadingTonChain(false);
      setTonState(null);
      setTonChainError(null);
    }
  }, [vaultStatus, tonAccount, config.tonRpcUrls.length, refreshTonState]);

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
          "v4r2",
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

  const pairTonConnectUri = useCallback(
    async (uri: string): Promise<StoredTonConnectSession> => {
      if (vaultStatus !== "unlocked" || !sessionVault.has() || !tonAccount) {
        throw new Error("Unlock your vault before connecting TON apps");
      }
      if (!config.tonBridgeUrl) {
        throw new Error("VITE_TON_BRIDGE_URL is not configured");
      }

      const {
        TonConnectCryptoSession,
        buildTonConnectSuccessEvent,
        deriveTonAccount,
        parseTonConnectUri,
        sendTonConnectBridgeMessage,
        signTonProof,
      } = await loadTonCore();
      const parsed = parseTonConnectUri(uri);
      const manifestOrigin = new URL(parsed.manifestUrl);
      let dappName = manifestOrigin.hostname;
      let dappUrl = manifestOrigin.origin;

      try {
        const manifestRes = await fetch(parsed.manifestUrl, { signal: AbortSignal.timeout(4000) });
        if (manifestRes.ok) {
          const m = (await manifestRes.json()) as { name?: unknown; url?: unknown };
          if (typeof m.name === "string" && m.name.trim()) {
            dappName = m.name.trim().slice(0, 64);
          }
          if (typeof m.url === "string" && m.url.trim().startsWith("http")) {
            dappUrl = m.url.trim();
          }
        }
      } catch {
        // Fallback cleanly to manifest hostname when manifest lacks CORS headers
      }

      const cryptoSess = new TonConnectCryptoSession();
      const timestamp = Math.floor(Date.now() / 1000);
      const proofItem = parsed.items.find((i) => i.name === "ton_proof" && i.payload);
      let tonProof:
        | { timestamp: number; domain: string; payload: string; signatureBase64: string }
        | undefined;

      if (proofItem?.payload) {
        const domain = new URL(dappUrl).hostname;
        const signatureBase64 = sessionVault.withMnemonic((mnemonic) => {
          const derived = deriveTonAccount(
            mnemonic,
            resolveTonDerivationIndex(activeAccount, activeIndex),
            config.tonNetwork,
            "v4r2",
          );
          try {
            return signTonProof({
              rawAddress: derived.rawAddress,
              domain,
              timestamp,
              payload: proofItem.payload!,
              secretKey: derived.secretKey,
            });
          } finally {
            derived.zeroize();
          }
        });
        tonProof = { timestamp, domain, payload: proofItem.payload, signatureBase64 };
      }

      const connectEventJson = buildTonConnectSuccessEvent({
        rawAddress: tonAccount.rawAddress,
        network: config.tonNetwork,
        walletStateInitBase64: tonAccount.walletStateInitBase64,
        publicKeyHex: tonAccount.publicKeyHex,
        ...(tonProof ? { tonProof } : {}),
      });

      const sealed = cryptoSess.encrypt(connectEventJson, parsed.clientId);
      await sendTonConnectBridgeMessage({
        bridgeUrl: config.tonBridgeUrl,
        clientId: cryptoSess.clientId,
        to: parsed.clientId,
        payloadBase64: sealed,
      });

      const stored: StoredTonConnectSession = {
        ...(cleanScopeId ? { scopeId: cleanScopeId } : {}),
        walletClientId: cryptoSess.clientId,
        walletSecretHex: cryptoSess.secretKeyHex,
        dappClientId: parsed.clientId,
        dappName,
        dappUrl,
        manifestUrl: parsed.manifestUrl,
        network: config.tonNetwork,
        connectedAddress: tonAccount.rawAddress,
        createdAt: timestamp,
      };
      await saveTonConnectSession(stored);
      setTonConnectSessions((prev) => [
        stored,
        ...prev.filter((s) => s.dappClientId !== stored.dappClientId),
      ]);
      triggerTelegramHaptic("success");
      showToast(`Connected to ${dappName} via TON Connect`);
      return stored;
    },
    [
      vaultStatus,
      tonAccount,
      activeAccount,
      activeIndex,
      config.tonBridgeUrl,
      config.tonNetwork,
      cleanScopeId,
      showToast,
    ],
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
          const derived = deriveTonAccount(
            mnemonic,
            resolveTonDerivationIndex(activeAccount, activeIndex),
            config.tonNetwork,
            "v4r2",
          );
          try {
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
    if (
      vaultStatus !== "unlocked" ||
      !config.tonBridgeUrl ||
      tonConnectSessions.length === 0 ||
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
        sendTonConnectBridgeMessage,
        validateTonConnectSendTxRequest,
      }) => {
        if (cancelled) return;
        const clientIds = tonConnectSessions.map((s) => s.walletClientId);
        const lastEventId = tonConnectSessions.find((s) => s.lastEventId)?.lastEventId;
        const eventsUrl = buildTonConnectEventsUrl(config.tonBridgeUrl!, clientIds, lastEventId);
        source = new EventSource(eventsUrl);

        source.onmessage = (evt: MessageEvent<string>) => {
          try {
            const packet = JSON.parse(evt.data) as { from?: string; message?: string };
            if (!packet.from || !packet.message) return;
            const matched = tonConnectSessionsRef.current.find(
              (s) => s.dappClientId === packet.from,
            );
            if (!matched) return;

            if (evt.lastEventId) {
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

              triggerTelegramHaptic("warning");
              setPendingTonConnectTx({
                requestId: rpc.id,
                walletClientId: matched.walletClientId,
                dappClientId: matched.dappClientId,
                dappName: matched.dappName,
                dappUrl: matched.dappUrl,
                validUntil: validated.validUntil,
                messages: validated.messages,
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
          label: initialLabel.trim() || "Primary",
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

      sessionVault.set(payload.mnemonic);
      setAccountMetaList(initialAccounts);
      setActiveIndex(0);
      setVaultStatus("unlocked");
      void saveSessionLease(pinOrPassphrase);
      showToast("Sovereign SEP-0005 Vault created locally");
      return { envelopeJson: serializeAgVaultBackup(envelope) };
    },
    [cleanScopeId, saveSessionLease, showToast],
  );

  const unlockWithPin = useCallback(
    async (pinOrPassphrase: string) => {
      const envelope = await loadEncryptedVault(cleanScopeId);
      if (!envelope) {
        throw new Error("No local vault found on this device");
      }
      const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      sessionVault.set(decrypted.mnemonic);
      for (const acc of decrypted.accounts) {
        if (acc.importedSecret) {
          sessionVault.setImportedSecret(acc.address, acc.importedSecret);
        }
      }
      setAccountMetaList(decrypted.accounts);
      setActiveIndex(decrypted.accounts[0]?.index ?? 0);
      setLocalVaultUpdatedAt(envelope.updatedAt);
      setVaultStatus("unlocked");
      void saveSessionLease(pinOrPassphrase);
    },
    [cleanScopeId, saveSessionLease],
  );

  const unlockWithBiometric = useCallback(async () => {
    if (telegramBioAvailable) {
      const bio = await authenticateTelegramBiometric("Unlock your AstroWallet vault");
      if (bio.authenticated) {
        const pinFromBio =
          bio.token || (await tgSecureStorageGet(securePinKey));
        if (pinFromBio) {
          await unlockWithPin(pinFromBio);
          return;
        }
      }
    }
    const pin = await unlockWithFingerprint(resolveWebAuthnRpId(config.pwaOrigin), cleanScopeId);
    await unlockWithPin(pin);
  }, [telegramBioAvailable, securePinKey, unlockWithPin, config.pwaOrigin, cleanScopeId]);

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
        const savedBm = await updateTelegramBiometricToken(pinOrPassphrase);
        const savedStore = await tgSecureStorageSet(securePinKey, pinOrPassphrase);
        if (savedBm || savedStore) {
          setFingerprintEnrolled(true);
          return {
            enrolled: true,
            message: "Telegram Biometrics + device SecureStorage quick-unlock enabled.",
          };
        }
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
    [telegramBioAvailable, securePinKey, config.pwaOrigin, cleanScopeId],
  );

  const disableFingerprint = useCallback(async () => {
    await updateTelegramBiometricToken("").catch(() => false);
    await tgSecureStorageRemove(securePinKey).catch(() => false);
    await disableFingerprintUnlock(cleanScopeId);
    setFingerprintEnrolled(false);
  }, [securePinKey, cleanScopeId]);

  const restoreAgVaultJson = useCallback(
    async (rawJson: string, pinOrPassphrase: string) => {
      const envelope = parseAgVaultBackup(rawJson);
      const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      await saveEncryptedVault(envelope, cleanScopeId);
      setLocalVaultUpdatedAt(envelope.updatedAt);
      sessionVault.set(decrypted.mnemonic);
      for (const acc of decrypted.accounts) {
        if (acc.importedSecret) {
          sessionVault.setImportedSecret(acc.address, acc.importedSecret);
        }
      }
      setAccountMetaList(decrypted.accounts);
      setActiveIndex(decrypted.accounts[0]?.index ?? 0);
      setVaultStatus("unlocked");
      void saveSessionLease(pinOrPassphrase);
      showToast("Encrypted .agvault restored locally");
    },
    [cleanScopeId, saveSessionLease, showToast],
  );

  const syncFromNewerCloudBackup = useCallback(
    async (
      rawJson: string,
    ): Promise<{
      status: "synced" | "push_merged" | "pin_required" | "up_to_date";
      envelopeJson?: string | undefined;
      accountCount?: number | undefined;
    }> => {
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

      const lease = await loadValidSessionLease();
      if (!lease) {
        return { status: "pin_required" };
      }

      let cloudPayload;
      try {
        cloudPayload = await decryptVaultPayload(cloudEnvelope, lease.pin, {
          deriveKeyFn: deriveKeyInWorker,
        });
      } catch {
        return { status: "pin_required" };
      }

      if (!localEnvelope) {
        await saveEncryptedVault(cloudEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(cloudEnvelope.updatedAt);
        sessionVault.set(cloudPayload.mnemonic);
        for (const acc of cloudPayload.accounts) {
          if (acc.importedSecret) {
            sessionVault.setImportedSecret(acc.address, acc.importedSecret);
          }
        }
        setAccountMetaList(cloudPayload.accounts);
        setVaultStatus("unlocked");
        showToast(`Synced ${cloudPayload.accounts.length} accounts from Telegram Cloud`);
        return { status: "synced", accountCount: cloudPayload.accounts.length };
      }

      let localPayload;
      try {
        localPayload = await decryptVaultPayload(localEnvelope, lease.pin, {
          deriveKeyFn: deriveKeyInWorker,
        });
      } catch {
        // Local PIN differed from session lease; replace with cloud
        await saveEncryptedVault(cloudEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(cloudEnvelope.updatedAt);
        sessionVault.set(cloudPayload.mnemonic);
        for (const acc of cloudPayload.accounts) {
          if (acc.importedSecret) {
            sessionVault.setImportedSecret(acc.address, acc.importedSecret);
          }
        }
        setAccountMetaList(cloudPayload.accounts);
        setVaultStatus("unlocked");
        showToast(`Synced ${cloudPayload.accounts.length} accounts from Telegram Cloud`);
        return { status: "synced", accountCount: cloudPayload.accounts.length };
      }

      if (localPayload.mnemonic.trim() !== cloudPayload.mnemonic.trim()) {
        if (cloudEnvelope.updatedAt > localEnvelope.updatedAt) {
          await saveEncryptedVault(cloudEnvelope, cleanScopeId);
          setLocalVaultUpdatedAt(cloudEnvelope.updatedAt);
          sessionVault.set(cloudPayload.mnemonic);
          for (const acc of cloudPayload.accounts) {
            if (acc.importedSecret) {
              sessionVault.setImportedSecret(acc.address, acc.importedSecret);
            }
          }
          setAccountMetaList(cloudPayload.accounts);
          setVaultStatus("unlocked");
          showToast(`Synced ${cloudPayload.accounts.length} accounts from Telegram Cloud`);
          return { status: "synced", accountCount: cloudPayload.accounts.length };
        }
        return {
          status: "push_merged",
          envelopeJson: serializeAgVaultBackup(localEnvelope),
          accountCount: localPayload.accounts.length,
        };
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
          lease.pin,
          { deriveKeyFn: deriveKeyInWorker },
        );
        await saveEncryptedVault(mergedEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(mergedEnvelope.updatedAt);
        sessionVault.set(localPayload.mnemonic);
        for (const acc of mergedAccounts) {
          if (acc.importedSecret) {
            sessionVault.setImportedSecret(acc.address, acc.importedSecret);
          }
        }
        setAccountMetaList(mergedAccounts);
        setVaultStatus("unlocked");
        return {
          status: "push_merged",
          envelopeJson: serializeAgVaultBackup(mergedEnvelope),
          accountCount: mergedAccounts.length,
        };
      }

      if (localMissingAny || cloudEnvelope.updatedAt > localEnvelope.updatedAt) {
        await saveEncryptedVault(cloudEnvelope, cleanScopeId);
        setLocalVaultUpdatedAt(cloudEnvelope.updatedAt);
        sessionVault.set(cloudPayload.mnemonic);
        for (const acc of cloudPayload.accounts) {
          if (acc.importedSecret) {
            sessionVault.setImportedSecret(acc.address, acc.importedSecret);
          }
        }
        setAccountMetaList(cloudPayload.accounts);
        setVaultStatus("unlocked");
        showToast(`Synced ${cloudPayload.accounts.length} accounts from Telegram Cloud`);
        return { status: "synced", accountCount: cloudPayload.accounts.length };
      }

      return { status: "up_to_date" };
    },
    [cleanScopeId, loadValidSessionLease, showToast],
  );

  const exportAgVaultJson = useCallback(async () => {
    const envelope = await loadEncryptedVault(cleanScopeId);
    if (!envelope) {
      throw new Error("No encrypted vault present to export");
    }
    return serializeAgVaultBackup(envelope);
  }, [cleanScopeId]);

  const reEncryptLocalVault = useCallback(
    async (currentPin: string, newPinOrPassphrase: string): Promise<{ envelopeJson: string }> => {
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
      setLocalVaultUpdatedAt(updatedEnvelope.updatedAt);
      clearSessionLease();
      // Clear any previous biometric PIN wrapper so stale PIN credentials never cause a mismatch
      await disableFingerprint();
      showToast("Vault protection updated", "info");
      return { envelopeJson: serializeAgVaultBackup(updatedEnvelope) };
    },
    [cleanScopeId, clearSessionLease, disableFingerprint, showToast],
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
      const envelope = await loadEncryptedVault(cleanScopeId);
      if (!envelope) {
        throw new Error("No encrypted vault stored on this device");
      }
      await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
    },
    [cleanScopeId],
  );

  const verifyBiometricReauth = useCallback(
    async (reason = "Confirm high-value AstroWallet transaction"): Promise<void> => {
      if (telegramBioAvailable) {
        const bio = await authenticateTelegramBiometric(reason);
        if (bio.authenticated) {
          const pinFromBio =
            bio.token || (await tgSecureStorageGet(securePinKey));
          if (pinFromBio) {
            await verifyPinOrPassphrase(pinFromBio);
            return;
          }
        }
      }
      const pin = await unlockWithFingerprint(resolveWebAuthnRpId(config.pwaOrigin), cleanScopeId);
      await verifyPinOrPassphrase(pin);
    },
    [telegramBioAvailable, securePinKey, verifyPinOrPassphrase, config.pwaOrigin, cleanScopeId],
  );

  const addDerivedAccount = useCallback(
    async (label: string, pinOrPassphrase: string): Promise<LinkedAccount> => {
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
      const cleanLabel = label.trim() || `Account #${nextIndex + 1}`;
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
      setAccountMetaList(updatedAccounts);
      setActiveIndex(nextIndex);

      const linked = toLinkedAccounts([nextMeta])[0];
      if (!linked) {
        throw new Error("Failed to construct linked account");
      }
      showToast(`Derived ${cleanLabel} (m/44'/148'/${nextIndex}')`);
      return linked;
    },
    [cleanScopeId, showToast],
  );

  const activateDerivedAccountAtIndex = useCallback(
    async (index: number, label: string, pinOrPassphrase: string): Promise<LinkedAccount> => {
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

      const cleanLabel = label.trim() || `Account #${index + 1}`;
      const nextMeta: VaultAccountMetadata = {
        index,
        label: cleanLabel.slice(0, 32),
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
      setAccountMetaList(updatedAccounts);
      setActiveIndex(index);

      const linked = toLinkedAccounts([nextMeta])[0];
      if (!linked) {
        throw new Error("Failed to construct linked account");
      }
      showToast(`Activated ${cleanLabel} (m/44'/148'/${index}')`);
      return linked;
    },
    [cleanScopeId, showToast],
  );

  const importExternalSecretAccount = useCallback(
    async (secretSeed: string, label: string, pinOrPassphrase: string): Promise<LinkedAccount> => {
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
        const cleanLabel = label.trim() || `External #${nextIndex + 1}`;
        const nextMeta: VaultAccountMetadata = {
          index: nextIndex,
          label: cleanLabel.slice(0, 32),
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
        setAccountMetaList(updatedAccounts);
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
    },
    [cleanScopeId, showToast],
  );

  const isImportedAccount = useCallback(
    (address: string) => sessionVault.hasImportedSecret(address),
    [],
  );

  const renameDerivedAccount = useCallback(
    async (index: number, newLabel: string, pinOrPassphrase: string) => {
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
      setAccountMetaList(updatedAccounts);
      showToast(`Renamed account to "${cleaned}"`);
    },
    [cleanScopeId, showToast],
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
    chainFetchSeqRef.current += 1;
    tonFetchSeqRef.current += 1;
    setPendingTonConnectTx(null);
    sessionVault.clear();
    clearSessionLease();
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
      if (now - lastLeaseExtendAt > 5 * 60 * 1000) {
        lastLeaseExtendAt = now;
        void loadValidSessionLease().then((lease) => {
          if (lease) {
            void saveSessionLease(lease.pin);
          }
        });
      }
    };

    let hiddenAt: number | null = null;
    const onVisibilityChange = () => {
      if (document.hidden) {
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
    chainFetchSeqRef.current += 1;
    tonFetchSeqRef.current += 1;
    setPendingTonConnectTx(null);
    clearSessionLease();
    await updateTelegramBiometricToken("").catch(() => false);
    await tgSecureStorageRemove(securePinKey).catch(() => false);
    await clearAllTonConnectSessions(cleanScopeId).catch(() => undefined);
    await clearPinLockoutState(cleanScopeId).catch(() => undefined);
    await deleteEncryptedVault(cleanScopeId);
    sessionVault.clear();
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
  }, [securePinKey, cleanScopeId, showToast]);

  const fundActiveTestnetAccount = useCallback(async () => {
    if (!activeAccount) {
      throw new Error("No active account selected");
    }
    setLoadingChain(true);
    setChainError(null);
    try {
      await stellarClient.fundWithFriendbot(activeAccount.address);
      await refreshChainState();
      showToast("Funded 10,000 Testnet XLM via Friendbot");
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Friendbot funding failed";
      setChainError(msg);
      throw err;
    } finally {
      setLoadingChain(false);
    }
  }, [activeAccount, stellarClient, refreshChainState, showToast]);

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

  const accountTxQueueRef = useRef<Map<string, Promise<unknown>>>(new Map());

  const enqueueAccountTx = useCallback(
    async <T,>(accountKey: string, task: () => Promise<T>): Promise<T> => {
      const prev = accountTxQueueRef.current.get(accountKey) ?? Promise.resolve();
      const next = prev.catch(() => undefined).then(task);
      accountTxQueueRef.current.set(accountKey, next);
      try {
        return await next;
      } finally {
        if (accountTxQueueRef.current.get(accountKey) === next) {
          accountTxQueueRef.current.delete(accountKey);
        }
      }
    },
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
      return withActiveKeypair(async (keypair) => {
        const address = keypair.publicKey() as ClassicAddress;
        const timestamp = Math.floor(Date.now() / 1000);
        const nonceBytes = new Uint8Array(12);
        crypto.getRandomValues(nonceBytes);
        const nonce = Array.from(nonceBytes, (b) => b.toString(16).padStart(2, "0")).join("");
        const challengeMsg = `astrowallet-bootstrap:v1:${config.network}:${address}:${timestamp}:${nonce}`;
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
      });
    },
    [
      config.apiBaseUrl,
      config.network,
      config.networkPassphrase,
      withActiveKeypair,
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
      tonState,
      loadingTonChain,
      tonChainError,
      tonConnectSessions,
      pendingTonConnectTx,
      localVaultUpdatedAt,
      storageScopeId: cleanScopeId,
      setActiveIndex,
      showToast,
      dismissToast,
      createOrImportVault,
      reEncryptLocalVault,
      restoreAgVaultJson,
      syncFromNewerCloudBackup,
      exportAgVaultJson,
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
      tonState,
      loadingTonChain,
      tonChainError,
      tonConnectSessions,
      pendingTonConnectTx,
      localVaultUpdatedAt,
      cleanScopeId,
      setActiveIndex,
      showToast,
      dismissToast,
      createOrImportVault,
      reEncryptLocalVault,
      restoreAgVaultJson,
      syncFromNewerCloudBackup,
      exportAgVaultJson,
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
