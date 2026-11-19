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
} from "@astrowallet/domain";
import {
  fetchSep42VerifiedAssets,
  scanTransactionEnvelopeXdr,
  type VerifiedAssetEntry,
} from "@astrowallet/security-shield";
import { formatSmartAccountLinkMessage } from "@astrowallet/tg-protocol";
import {
  attachSep43WindowProvider,
  createSep43Provider,
  createSorobanDevClient,
  createStellarClient,
  createWalletConnectStellarResponder,
  decryptVaultPayload,
  deleteEncryptedVault,
  deriveCounterfactualSmartAccount,
  deriveKeyInWorker,
  deriveStellarAccount,
  disableFingerprintUnlock,
  encryptVaultPayload,
  enrollFingerprintUnlock,
  hasEncryptedVault,
  isFingerprintSupported,
  loadBiometricRecord,
  loadContacts,
  loadEncryptedVault,
  parseAgVaultBackup,
  publicKeyToRawHex,
  saveContacts,
  saveEncryptedVault,
  serializeAgVaultBackup,
  signChallengeMessage,
  signTransactionXdrEnvelope,
  unlockWithFingerprint,
  validateMnemonicPhrase,
  type ClaimableBalanceRecord,
  type ContactEntry,
  type DevTemplateKind,
  type RecentPaymentRecord,
  type SdexOfferRecord,
  type SorobanInvokeResult,
  type SorobanSimulationSummary,
  type SorobanTelemetry,
  type StellarAccountState,
  type TypedMemoInput,
  type VaultAccountMetadata,
  type WalletConnectStellarRequest,
  type WalletConnectStellarResponse,
} from "@astrowallet/stellar-core";

export type VaultStatus = "loading" | "uninitialized" | "locked" | "unlocked";

export interface ToastMessage {
  id: number;
  kind: "success" | "info" | "error";
  message: string;
}

export interface PendingDappConsent {
  id: number;
  method: string;
  origin?: string | undefined;
  summary: string;
  scanReport?: ScanReport | undefined;
}

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
  claimableBalances: readonly ClaimableBalanceRecord[];
  openOffers: readonly SdexOfferRecord[];
  contacts: readonly ContactEntry[];
  toast: ToastMessage | null;
  loadingChain: boolean;
  chainError: string | null;
  fingerprintSupported: boolean;
  fingerprintEnrolled: boolean;
  verifiedAssets: readonly VerifiedAssetEntry[];
  pendingDappConsent: PendingDappConsent | null;

  resolveDappConsent(approved: boolean): void;

  setActiveIndex(index: number): void;
  showToast(message: string, kind?: "success" | "info" | "error"): void;
  dismissToast(): void;
  createOrImportVault(mnemonic: string, pinOrPassphrase: string, initialLabel?: string): Promise<void>;
  restoreAgVaultJson(rawJson: string, pinOrPassphrase: string): Promise<void>;
  exportAgVaultJson(): Promise<string>;
  revealMnemonicWithPin(pinOrPassphrase: string): Promise<string>;
  unlockWithPin(pinOrPassphrase: string): Promise<void>;
  unlockWithBiometric(): Promise<void>;
  enableFingerprint(pinOrPassphrase: string): Promise<{ enrolled: boolean; message: string }>;
  disableFingerprint(): Promise<void>;
  addDerivedAccount(label: string, pinOrPassphrase: string): Promise<LinkedAccount>;
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
  fundActiveTestnetAccount(): Promise<void>;
  fundAnyTestnetAddress(address: ClassicAddress): Promise<void>;
  sendPayment(params: SendPaymentParams): Promise<{ hash: string; ledger: number }>;
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
  signActiveSep53Message(message: string): Promise<{ signature: string; signerAddress: ClassicAddress }>;
  handleDappRpcRequest(
    request: WalletConnectStellarRequest,
  ): Promise<WalletConnectStellarResponse>;
  signConnectChallenge(
    message: string,
    selectedIndices: readonly number[],
    includePairedSmartAccount?: boolean,
  ): Promise<SignedConnectAccountProof[]>;
  fundClaimEscrow(params: {
    escrowContractId: ContractAddress;
    claimIdHex: string;
    amount: string;
    assetCode: string;
    assetIssuer?: string | undefined;
    expiresAtUnix: number;
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

export function WalletProvider({
  config,
  children,
}: {
  config: PwaConfig;
  children: ReactNode;
}) {
  const stellarClient = useMemo(() => createStellarClient(config), [config]);
  const sorobanDevClient = useMemo(
    () =>
      createSorobanDevClient({
        rpcUrls: config.rpcUrls,
        horizonUrls: config.horizonUrls,
        networkPassphrase: config.networkPassphrase,
      }),
    [config.rpcUrls, config.horizonUrls, config.networkPassphrase],
  );

  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("loading");
  const [unlockedMnemonic, setUnlockedMnemonic] = useState<string | null>(null);
  const [accountMetaList, setAccountMetaList] = useState<VaultAccountMetadata[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);

  const [accountState, setAccountState] = useState<StellarAccountState | null>(null);
  const [recentPayments, setRecentPayments] = useState<RecentPaymentRecord[]>([]);
  const [claimableBalances, setClaimableBalances] = useState<ClaimableBalanceRecord[]>([]);
  const [openOffers, setOpenOffers] = useState<SdexOfferRecord[]>([]);
  const [contacts, setContacts] = useState<ContactEntry[]>([]);
  const [toast, setToast] = useState<ToastMessage | null>(null);

  const [loadingChain, setLoadingChain] = useState<boolean>(false);
  const [chainError, setChainError] = useState<string | null>(null);

  const [fingerprintSupported, setFingerprintSupported] = useState<boolean>(false);
  const [fingerprintEnrolled, setFingerprintEnrolled] = useState<boolean>(false);
  const [verifiedAssets, setVerifiedAssets] = useState<readonly VerifiedAssetEntry[]>([]);
  const [pendingDappConsent, setPendingDappConsent] = useState<PendingDappConsent | null>(null);
  const dappConsentResolverRef = useRef<((approved: boolean) => void) | null>(null);

  const resolveDappConsent = useCallback((approved: boolean) => {
    const resolver = dappConsentResolverRef.current;
    dappConsentResolverRef.current = null;
    setPendingDappConsent(null);
    if (resolver) {
      resolver(approved);
    }
  }, []);

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

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const [exists, fpSupported, bioRecord, storedContacts] = await Promise.all([
        hasEncryptedVault().catch(() => false),
        isFingerprintSupported().catch(() => false),
        loadBiometricRecord().catch(() => null),
        loadContacts().catch(() => []),
      ]);
      if (cancelled) return;
      setFingerprintSupported(fpSupported);
      setFingerprintEnrolled(bioRecord !== null);
      setContacts(storedContacts);
      setVaultStatus(exists ? "locked" : "uninitialized");
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (config.sep42AssetListUrls.length === 0) {
      setVerifiedAssets([]);
      return undefined;
    }
    void fetchSep42VerifiedAssets(config.sep42AssetListUrls)
      .then((assets) => {
        if (!cancelled) setVerifiedAssets(assets);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [config.sep42AssetListUrls]);

  const refreshChainState = useCallback(async () => {
    if (!activeAccount) return;
    setLoadingChain(true);
    setChainError(null);
    try {
      const [state, payments, claimables, offers] = await Promise.all([
        stellarClient.fetchAccountState(activeAccount.address),
        stellarClient.fetchRecentPayments(activeAccount.address, 25),
        stellarClient.fetchClaimableBalances(activeAccount.address, 20),
        stellarClient.fetchOpenOffers(activeAccount.address, 20),
      ]);
      const verifiedSet = new Set(
        verifiedAssets.map((v) => `${v.code.toUpperCase()}:${v.issuer}`),
      );
      const enrichedBalances = state.balances.map((b) => ({
        ...b,
        isVerifiedAsset:
          b.isVerifiedAsset ||
          (b.assetCode === "XLM" && !b.assetIssuer) ||
          (Boolean(b.assetIssuer) &&
            verifiedSet.has(`${b.assetCode.toUpperCase()}:${b.assetIssuer}`)),
      }));
      setAccountState({ ...state, balances: enrichedBalances });
      setRecentPayments(payments);
      setClaimableBalances(claimables);
      setOpenOffers(offers);
    } catch (err) {
      setChainError(err instanceof Error ? err.message : "Failed to load Stellar Horizon state");
    } finally {
      setLoadingChain(false);
    }
  }, [activeAccount, stellarClient, verifiedAssets]);

  useEffect(() => {
    if (vaultStatus === "unlocked" && activeAccount) {
      void refreshChainState();
    } else {
      setAccountState(null);
      setRecentPayments([]);
      setClaimableBalances([]);
      setOpenOffers([]);
    }
  }, [vaultStatus, activeAccount, refreshChainState]);

  const withActiveKeypair = useCallback(
    async <T,>(
      fn: (keypair: ReturnType<ReturnType<typeof deriveStellarAccount>["toKeypair"]>) => Promise<T>,
    ): Promise<T> => {
      if (!unlockedMnemonic || !activeAccount) {
        throw new Error("Vault is locked");
      }
      const derived = deriveStellarAccount(
        unlockedMnemonic,
        activeAccount.derivationIndex ?? 0,
      );
      try {
        return await fn(derived.toKeypair());
      } finally {
        derived.zeroize();
      }
    },
    [unlockedMnemonic, activeAccount],
  );

  // Register SEP-43 / SEP-60 window.stellar provider while vault is unlocked
  useEffect(() => {
    if (vaultStatus !== "unlocked" || !unlockedMnemonic || !activeAccount) {
      return undefined;
    }

    const provider = createSep43Provider({
      network: config.network,
      networkPassphrase: config.networkPassphrase,
      horizonUrls: config.horizonUrls,
      getKeypair: () => {
        const derived = deriveStellarAccount(
          unlockedMnemonic,
          activeAccount.derivationIndex ?? 0,
        );
        const kp = derived.toKeypair();
        derived.zeroize();
        return kp;
      },
      authorizeRequest: async (ctx) => {
        const rawXdr = typeof ctx.params.xdr === "string" ? ctx.params.xdr : undefined;
        let scanReport: ScanReport | undefined;
        if (rawXdr) {
          const scan = scanTransactionEnvelopeXdr(rawXdr, {
            networkPassphrase: config.networkPassphrase,
            verifiedAssets,
          });
          scanReport = scan.report;
          if (scan.report.verdict === "malicious") {
            throw new Error(
              `Scan & Shield blocked malicious dApp XDR: ${scan.report.findings[0]?.title ?? "drainer detected"}`,
            );
          }
        }

        if (dappConsentResolverRef.current) {
          dappConsentResolverRef.current(false);
          dappConsentResolverRef.current = null;
        }

        const msgPreview =
          typeof ctx.params.message === "string"
            ? ctx.params.message.slice(0, 140)
            : rawXdr
              ? `${scanReport?.operationsCount ?? 1} operation(s), verdict: ${scanReport?.verdict.toUpperCase() ?? "UNKNOWN"}`
              : "Soroban authorization entry";

        return new Promise<boolean>((resolve) => {
          dappConsentResolverRef.current = resolve;
          setPendingDappConsent({
            id: Date.now(),
            method: ctx.method,
            origin: ctx.origin,
            summary: msgPreview,
            scanReport,
          });
        });
      },
    });

    const detach = attachSep43WindowProvider(provider);
    return () => {
      detach();
      if (dappConsentResolverRef.current) {
        dappConsentResolverRef.current(false);
        dappConsentResolverRef.current = null;
      }
      setPendingDappConsent(null);
    };
  }, [vaultStatus, unlockedMnemonic, activeAccount, config, verifiedAssets]);

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
      await saveEncryptedVault(envelope);

      setUnlockedMnemonic(payload.mnemonic);
      setAccountMetaList(initialAccounts);
      setActiveIndex(0);
      setVaultStatus("unlocked");
      showToast("Sovereign SEP-0005 Vault created locally");
    },
    [showToast],
  );

  const unlockWithPin = useCallback(async (pinOrPassphrase: string) => {
    const envelope = await loadEncryptedVault();
    if (!envelope) {
      throw new Error("No local vault found on this device");
    }
    const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
      deriveKeyFn: deriveKeyInWorker,
    });
    setUnlockedMnemonic(decrypted.mnemonic);
    setAccountMetaList(decrypted.accounts);
    setActiveIndex(decrypted.accounts[0]?.index ?? 0);
    setVaultStatus("unlocked");
  }, []);

  const unlockWithBiometric = useCallback(async () => {
    const pin = await unlockWithFingerprint(resolveWebAuthnRpId(config.pwaOrigin));
    await unlockWithPin(pin);
  }, [unlockWithPin, config.pwaOrigin]);

  const enableFingerprint = useCallback(
    async (pinOrPassphrase: string) => {
      const envelope = await loadEncryptedVault();
      if (!envelope) {
        throw new Error("Create and save your vault first");
      }
      await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      const res = await enrollFingerprintUnlock(
        pinOrPassphrase,
        "AstroWallet",
        resolveWebAuthnRpId(config.pwaOrigin),
      );
      if (res.enrolled) {
        setFingerprintEnrolled(true);
        return { enrolled: true, message: "Fingerprint quick-unlock enabled on this device." };
      }
      return { enrolled: false, message: res.reason };
    },
    [config.pwaOrigin],
  );

  const disableFingerprint = useCallback(async () => {
    await disableFingerprintUnlock();
    setFingerprintEnrolled(false);
  }, []);

  const restoreAgVaultJson = useCallback(
    async (rawJson: string, pinOrPassphrase: string) => {
      const envelope = parseAgVaultBackup(rawJson);
      const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });
      await saveEncryptedVault(envelope);
      setUnlockedMnemonic(decrypted.mnemonic);
      setAccountMetaList(decrypted.accounts);
      setActiveIndex(decrypted.accounts[0]?.index ?? 0);
      setVaultStatus("unlocked");
      showToast("Encrypted .agvault restored locally");
    },
    [showToast],
  );

  const exportAgVaultJson = useCallback(async () => {
    const envelope = await loadEncryptedVault();
    if (!envelope) {
      throw new Error("No encrypted vault present to export");
    }
    return serializeAgVaultBackup(envelope);
  }, []);

  const revealMnemonicWithPin = useCallback(async (pinOrPassphrase: string): Promise<string> => {
    const envelope = await loadEncryptedVault();
    if (!envelope) {
      throw new Error("No encrypted vault stored on this device");
    }
    const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
      deriveKeyFn: deriveKeyInWorker,
    });
    return decrypted.mnemonic;
  }, []);

  const addDerivedAccount = useCallback(
    async (label: string, pinOrPassphrase: string): Promise<LinkedAccount> => {
      if (!unlockedMnemonic) {
        throw new Error("Unlock your vault before deriving a new account");
      }
      const envelope = await loadEncryptedVault();
      if (!envelope) {
        throw new Error("Encrypted vault missing from IndexedDB");
      }
      const decrypted = await decryptVaultPayload(envelope, pinOrPassphrase, {
        deriveKeyFn: deriveKeyInWorker,
      });

      const nextIndex =
        decrypted.accounts.reduce((max, acc) => Math.max(max, acc.index), -1) + 1;
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

      await saveEncryptedVault(updatedEnvelope);
      setAccountMetaList(updatedAccounts);
      setActiveIndex(nextIndex);

      const linked = toLinkedAccounts([nextMeta])[0];
      if (!linked) {
        throw new Error("Failed to construct linked account");
      }
      showToast(`Derived ${cleanLabel} (m/44'/148'/${nextIndex}')`);
      return linked;
    },
    [unlockedMnemonic, showToast],
  );

  const renameDerivedAccount = useCallback(
    async (index: number, newLabel: string, pinOrPassphrase: string) => {
      const cleaned = newLabel.trim();
      if (!cleaned) {
        throw new Error("Account label cannot be empty");
      }
      const envelope = await loadEncryptedVault();
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
      await saveEncryptedVault(updatedEnvelope);
      setAccountMetaList(updatedAccounts);
      showToast(`Renamed account to "${cleaned}"`);
    },
    [showToast],
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
      await saveContacts(updated);
      setContacts(updated);
      showToast(`Saved contact "${nextEntry.label}"`);
      return nextEntry;
    },
    [contacts, showToast],
  );

  const deleteContact = useCallback(
    async (id: string) => {
      const updated = contacts.filter((c) => c.id !== id);
      await saveContacts(updated);
      setContacts(updated);
      showToast("Removed contact", "info");
    },
    [contacts, showToast],
  );

  const lockVault = useCallback(() => {
    if (dappConsentResolverRef.current) {
      dappConsentResolverRef.current(false);
      dappConsentResolverRef.current = null;
    }
    setPendingDappConsent(null);
    setUnlockedMnemonic(null);
    setAccountState(null);
    setRecentPayments([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setVaultStatus("locked");
  }, []);

  // Auto-lock after 5 min of inactivity or > 60s in background tab
  useEffect(() => {
    if (vaultStatus !== "unlocked" || typeof window === "undefined") {
      return undefined;
    }

    const INACTIVITY_MS = 5 * 60 * 1000;
    const BACKGROUND_LOCK_MS = 60 * 1000;

    let timer = window.setTimeout(() => {
      lockVault();
      showToast("Vault auto-locked after 5 minutes of inactivity", "info");
    }, INACTIVITY_MS);

    const resetInactivityTimer = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        lockVault();
        showToast("Vault auto-locked after 5 minutes of inactivity", "info");
      }, INACTIVITY_MS);
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
  }, [vaultStatus, lockVault, showToast]);

  const wipeLocalVault = useCallback(async () => {
    if (dappConsentResolverRef.current) {
      dappConsentResolverRef.current(false);
      dappConsentResolverRef.current = null;
    }
    setPendingDappConsent(null);
    await deleteEncryptedVault();
    setUnlockedMnemonic(null);
    setAccountMetaList([]);
    setAccountState(null);
    setRecentPayments([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setFingerprintEnrolled(false);
    setVaultStatus("uninitialized");
    showToast("Local vault wiped from this device", "info");
  }, [showToast]);

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

  const sendPayment = useCallback(
    async (params: SendPaymentParams): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) => {
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
        showToast(`Sent ${params.amount} ${params.assetCode} cleanly`);
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
  );

  const executePathSwap = useCallback(
    async (params: ExecutePathSwapParams): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) => {
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
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
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
      return withActiveKeypair(async (keypair) => {
        const result = await stellarClient.submitChangeTrust({
          sourceKeypair: keypair,
          assetCode,
          assetIssuer,
          limit,
        });
        await refreshChainState();
        showToast(
          limit === "0" ? `Removed ${assetCode} trustline` : `Activated ${assetCode} trustline`,
        );
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState, showToast],
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
      const scan = scanTransactionEnvelopeXdr(xdrBase64.trim(), {
        networkPassphrase: config.networkPassphrase,
        verifiedAssets,
      });
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
      return withActiveKeypair(async (keypair) => {
        const signedXdr = signTransactionXdrEnvelope(
          xdrBase64.trim(),
          config.networkPassphrase,
          keypair,
        );
        return { signedXdr, scanReport: scan.report };
      });
    },
    [config.networkPassphrase, verifiedAssets, withActiveKeypair],
  );

  const signAndSubmitRawXdrWithShield = useCallback(
    async (
      xdrBase64: string,
      allowWarning = false,
    ): Promise<{
      hash: string;
      ledger: number;
      signedXdr: string;
      channel: "soroban-rpc" | "horizon";
    }> => {
      const { signedXdr } = await signRawXdrWithShield(xdrBase64, allowWarning);
      const submitted = await sorobanDevClient.submitRawSignedXdr(signedXdr);
      await refreshChainState();
      showToast(`Submitted via ${submitted.channel}`);
      return {
        ...submitted,
        signedXdr,
      };
    },
    [signRawXdrWithShield, sorobanDevClient, refreshChainState, showToast],
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
      if (!unlockedMnemonic) {
        throw new Error("Unlock vault to inspect SEP-0005 derivation table");
      }
      const clamped = Math.max(1, Math.min(10, Math.trunc(count)));
      const rows: DerivedPublicKeyPreview[] = [];
      for (let i = 0; i < clamped; i += 1) {
        const derived = deriveStellarAccount(unlockedMnemonic, i);
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
    },
    [unlockedMnemonic, config.smartAccountWasmHash, config.networkPassphrase],
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

  const handleDappRpcRequest = useCallback(
    async (request: WalletConnectStellarRequest): Promise<WalletConnectStellarResponse> => {
      return withActiveKeypair(async (keypair) => {
        const responder = createWalletConnectStellarResponder({
          network: config.network,
          networkPassphrase: config.networkPassphrase,
          horizonUrls: config.horizonUrls,
          getKeypair: () => keypair,
          authorizeRequest: async (ctx) => {
            const rawXdr = typeof ctx.params.xdr === "string" ? ctx.params.xdr : undefined;
            if (rawXdr) {
              const scan = scanTransactionEnvelopeXdr(rawXdr, {
                networkPassphrase: config.networkPassphrase,
                verifiedAssets,
              });
              if (scan.report.verdict === "malicious") {
                throw new Error(
                  `Scan & Shield blocked malicious dApp transaction: ${scan.report.findings[0]?.title ?? "threat detected"}`,
                );
              }
            }
            return true;
          },
        });
        const response = await responder.handleRequest(request);
        if (request.method === "stellar_signAndSubmitXDR") {
          await refreshChainState();
        }
        return response;
      });
    },
    [withActiveKeypair, config, verifiedAssets, refreshChainState],
  );

  const signConnectChallenge = useCallback(
    async (
      message: string,
      selectedIndices: readonly number[],
      includePairedSmartAccount = false,
    ): Promise<SignedConnectAccountProof[]> => {
      if (!unlockedMnemonic) {
        throw new Error("Unlock your wallet first to sign the Telegram link challenge");
      }
      const chosen = accountMetaList.filter((m) => selectedIndices.includes(m.index));
      if (chosen.length === 0) {
        throw new Error("Select at least one account to link");
      }

      const proofs: SignedConnectAccountProof[] = [];
      for (let i = 0; i < chosen.length; i += 1) {
        const meta = chosen[i];
        if (!meta) continue;
        const derived = deriveStellarAccount(unlockedMnemonic, meta.index);
        try {
          const kp = derived.toKeypair();
          const signatureBase64 = signChallengeMessage(kp, message);
          proofs.push({
            address: derived.publicKey,
            kind: "classic",
            label: meta.label,
            isDefault: i === 0,
            signatureBase64,
          });
          if (i === 0 && includePairedSmartAccount && config.smartAccountWasmHash) {
            const smart = deriveCounterfactualSmartAccount({
              guardianAddress: derived.publicKey,
              wasmHashHex: config.smartAccountWasmHash,
              networkPassphrase: config.networkPassphrase,
            });
            const boundMsg = formatSmartAccountLinkMessage(message, smart.contractAddress);
            proofs.push({
              address: smart.contractAddress,
              kind: "smart",
              label: `${meta.label} Smart`,
              isDefault: false,
              guardianAddress: derived.publicKey,
              signatureBase64: signChallengeMessage(kp, boundMsg),
            });
          }
        } finally {
          derived.zeroize();
        }
      }
      return proofs;
    },
    [unlockedMnemonic, accountMetaList, config.smartAccountWasmHash, config.networkPassphrase],
  );

  const fundClaimEscrow = useCallback(
    async (params: {
      escrowContractId: ContractAddress;
      claimIdHex: string;
      amount: string;
      assetCode: string;
      assetIssuer?: string | undefined;
      expiresAtUnix: number;
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

  const value: WalletContextValue = {
    config,
    vaultStatus,
    accounts,
    activeAccount,
    activeIndex,
    accountState,
    recentPayments,
    claimableBalances,
    openOffers,
    contacts,
    toast,
    loadingChain,
    chainError,
    fingerprintSupported,
    fingerprintEnrolled,
    verifiedAssets,
    pendingDappConsent,
    resolveDappConsent,
    setActiveIndex,
    showToast,
    dismissToast,
    createOrImportVault,
    restoreAgVaultJson,
    exportAgVaultJson,
    revealMnemonicWithPin,
    unlockWithPin,
    unlockWithBiometric,
    enableFingerprint,
    disableFingerprint,
    addDerivedAccount,
    renameDerivedAccount,
    lockVault,
    wipeLocalVault,
    saveContact,
    deleteContact,
    refreshChainState,
    fundActiveTestnetAccount,
    fundAnyTestnetAddress,
    sendPayment,
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
    signActiveSep53Message,
    handleDappRpcRequest,
    signConnectChallenge,
    fundClaimEscrow,
    claimFromEscrow,
  };

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet(): WalletContextValue {
  const ctx = useContext(WalletContext);
  if (!ctx) {
    throw new Error("useWallet must be used inside WalletProvider");
  }
  return ctx;
}
