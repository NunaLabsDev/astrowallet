import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  defaultCapabilitiesForKind,
  type ClassicAddress,
  type LinkedAccount,
  type PwaConfig,
  type StellarAddress,
} from "@astrowallet/domain";
import { scanTransactionEnvelopeXdr } from "@astrowallet/security-shield";
import {
  attachSep43WindowProvider,
  createSep43Provider,
  createStellarClient,
  createWalletConnectStellarResponder,
  decryptVaultPayload,
  deleteEncryptedVault,
  deriveKeyInWorker,
  deriveStellarAccount,
  disableFingerprintUnlock,
  encryptVaultPayload,
  enrollFingerprintUnlock,
  hasEncryptedVault,
  isFingerprintSupported,
  loadBiometricRecord,
  loadEncryptedVault,
  parseAgVaultBackup,
  saveEncryptedVault,
  serializeAgVaultBackup,
  signChallengeMessage,
  unlockWithFingerprint,
  validateMnemonicPhrase,
  type ClaimableBalanceRecord,
  type RecentPaymentRecord,
  type SdexOfferRecord,
  type StellarAccountState,
  type TypedMemoInput,
  type VaultAccountMetadata,
  type WalletConnectStellarRequest,
  type WalletConnectStellarResponse,
} from "@astrowallet/stellar-core";

export type VaultStatus = "loading" | "uninitialized" | "locked" | "unlocked";

export interface SendPaymentParams {
  destination: StellarAddress;
  amount: string;
  assetCode: string;
  assetIssuer?: string | undefined;
  memoText?: string | undefined;
  typedMemo?: TypedMemoInput | undefined;
}

export interface SignedConnectAccountProof {
  address: ClassicAddress;
  kind: "classic";
  label: string;
  isDefault: boolean;
  signatureBase64: string;
}

export interface PlaceSdexOfferParams {
  sellingCode: string;
  sellingIssuer?: ClassicAddress | undefined;
  buyingCode: string;
  buyingIssuer?: ClassicAddress | undefined;
  amount: string;
  price: string;
  offerId?: string | undefined;
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
  loadingChain: boolean;
  chainError: string | null;
  fingerprintSupported: boolean;
  fingerprintEnrolled: boolean;

  setActiveIndex(index: number): void;
  createOrImportVault(mnemonic: string, pinOrPassphrase: string, initialLabel?: string): Promise<void>;
  restoreAgVaultJson(rawJson: string, pinOrPassphrase: string): Promise<void>;
  exportAgVaultJson(): Promise<string>;
  unlockWithPin(pinOrPassphrase: string): Promise<void>;
  unlockWithBiometric(): Promise<void>;
  enableFingerprint(pinOrPassphrase: string): Promise<{ enrolled: boolean; message: string }>;
  disableFingerprint(): Promise<void>;
  addDerivedAccount(label: string, pinOrPassphrase: string): Promise<LinkedAccount>;
  lockVault(): void;
  wipeLocalVault(): Promise<void>;
  refreshChainState(): Promise<void>;
  fundActiveTestnetAccount(): Promise<void>;
  sendPayment(params: SendPaymentParams): Promise<{ hash: string; ledger: number }>;
  addOrRemoveTrustline(
    assetCode: string,
    assetIssuer: ClassicAddress,
    limit?: string,
  ): Promise<{ hash: string; ledger: number }>;
  reclaimZeroBalanceReserves(): Promise<{ hash: string; ledger: number; reclaimedXlm: string }>;
  claimBalanceById(balanceId: string): Promise<{ hash: string; ledger: number }>;
  placeSdexOffer(params: PlaceSdexOfferParams): Promise<{ hash: string; ledger: number }>;
  handleDappRpcRequest(
    request: WalletConnectStellarRequest,
  ): Promise<WalletConnectStellarResponse>;
  signConnectChallenge(
    message: string,
    selectedIndices: readonly number[],
  ): Promise<SignedConnectAccountProof[]>;
}

const WalletContext = createContext<WalletContextValue | null>(null);

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

  const [vaultStatus, setVaultStatus] = useState<VaultStatus>("loading");
  const [unlockedMnemonic, setUnlockedMnemonic] = useState<string | null>(null);
  const [accountMetaList, setAccountMetaList] = useState<VaultAccountMetadata[]>([]);
  const [activeIndex, setActiveIndex] = useState<number>(0);

  const [accountState, setAccountState] = useState<StellarAccountState | null>(null);
  const [recentPayments, setRecentPayments] = useState<RecentPaymentRecord[]>([]);
  const [claimableBalances, setClaimableBalances] = useState<ClaimableBalanceRecord[]>([]);
  const [openOffers, setOpenOffers] = useState<SdexOfferRecord[]>([]);
  const [loadingChain, setLoadingChain] = useState<boolean>(false);
  const [chainError, setChainError] = useState<string | null>(null);

  const [fingerprintSupported, setFingerprintSupported] = useState<boolean>(false);
  const [fingerprintEnrolled, setFingerprintEnrolled] = useState<boolean>(false);

  const accounts = useMemo(() => toLinkedAccounts(accountMetaList), [accountMetaList]);
  const activeAccount = useMemo(
    () => accounts.find((a) => a.derivationIndex === activeIndex) ?? accounts[0] ?? null,
    [accounts, activeIndex],
  );

  useEffect(() => {
    let cancelled = false;
    async function init() {
      const [exists, fpSupported, bioRecord] = await Promise.all([
        hasEncryptedVault().catch(() => false),
        isFingerprintSupported().catch(() => false),
        loadBiometricRecord().catch(() => null),
      ]);
      if (cancelled) return;
      setFingerprintSupported(fpSupported);
      setFingerprintEnrolled(bioRecord !== null);
      setVaultStatus(exists ? "locked" : "uninitialized");
    }
    void init();
    return () => {
      cancelled = true;
    };
  }, []);

  const refreshChainState = useCallback(async () => {
    if (!activeAccount) return;
    setLoadingChain(true);
    setChainError(null);
    try {
      const [state, payments, claimables, offers] = await Promise.all([
        stellarClient.fetchAccountState(activeAccount.address),
        stellarClient.fetchRecentPayments(activeAccount.address, 10),
        stellarClient.fetchClaimableBalances(activeAccount.address, 20),
        stellarClient.fetchOpenOffers(activeAccount.address, 20),
      ]);
      setAccountState(state);
      setRecentPayments(payments);
      setClaimableBalances(claimables);
      setOpenOffers(offers);
    } catch (err) {
      setChainError(err instanceof Error ? err.message : "Failed to load Stellar Horizon state");
    } finally {
      setLoadingChain(false);
    }
  }, [activeAccount, stellarClient]);

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
    async <T,>(fn: (keypair: ReturnType<ReturnType<typeof deriveStellarAccount>["toKeypair"]>) => Promise<T>): Promise<T> => {
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
        if (rawXdr) {
          const scan = scanTransactionEnvelopeXdr(rawXdr, {
            networkPassphrase: config.networkPassphrase,
          });
          if (scan.report.verdict === "malicious") {
            throw new Error(
              `Scan & Shield blocked malicious dApp XDR: ${scan.report.findings[0]?.title ?? "drainer detected"}`,
            );
          }
        }
        return true;
      },
    });

    return attachSep43WindowProvider(provider);
  }, [vaultStatus, unlockedMnemonic, activeAccount, config]);

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
    },
    [],
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
    const pin = await unlockWithFingerprint();
    await unlockWithPin(pin);
  }, [unlockWithPin]);

  const enableFingerprint = useCallback(async (pinOrPassphrase: string) => {
    const envelope = await loadEncryptedVault();
    if (!envelope) {
      throw new Error("Create and save your vault first");
    }
    await decryptVaultPayload(envelope, pinOrPassphrase, {
      deriveKeyFn: deriveKeyInWorker,
    });
    const res = await enrollFingerprintUnlock(pinOrPassphrase);
    if (res.enrolled) {
      setFingerprintEnrolled(true);
      return { enrolled: true, message: "Fingerprint quick-unlock enabled on this device." };
    }
    return { enrolled: false, message: res.reason };
  }, []);

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
    },
    [],
  );

  const exportAgVaultJson = useCallback(async () => {
    const envelope = await loadEncryptedVault();
    if (!envelope) {
      throw new Error("No encrypted vault present to export");
    }
    return serializeAgVaultBackup(envelope);
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
      return linked;
    },
    [unlockedMnemonic],
  );

  const lockVault = useCallback(() => {
    setUnlockedMnemonic(null);
    setAccountState(null);
    setRecentPayments([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setVaultStatus("locked");
  }, []);

  const wipeLocalVault = useCallback(async () => {
    await deleteEncryptedVault();
    setUnlockedMnemonic(null);
    setAccountMetaList([]);
    setAccountState(null);
    setRecentPayments([]);
    setClaimableBalances([]);
    setOpenOffers([]);
    setFingerprintEnrolled(false);
    setVaultStatus("uninitialized");
  }, []);

  const fundActiveTestnetAccount = useCallback(async () => {
    if (!activeAccount) {
      throw new Error("No active account selected");
    }
    setLoadingChain(true);
    setChainError(null);
    try {
      await stellarClient.fundWithFriendbot(activeAccount.address);
      await refreshChainState();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Friendbot funding failed";
      setChainError(msg);
      throw err;
    } finally {
      setLoadingChain(false);
    }
  }, [activeAccount, stellarClient, refreshChainState]);

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
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState],
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
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState],
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
      return result;
    });
  }, [accountState?.reclaimableTrustlines, withActiveKeypair, stellarClient, refreshChainState]);

  const claimBalanceById = useCallback(
    async (balanceId: string): Promise<{ hash: string; ledger: number }> => {
      return withActiveKeypair(async (keypair) => {
        const result = await stellarClient.claimClaimableBalance({
          sourceKeypair: keypair,
          balanceId,
        });
        await refreshChainState();
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState],
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
        return result;
      });
    },
    [withActiveKeypair, stellarClient, refreshChainState],
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
    [withActiveKeypair, config, refreshChainState],
  );

  const signConnectChallenge = useCallback(
    async (
      message: string,
      selectedIndices: readonly number[],
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
          const signatureBase64 = signChallengeMessage(derived.toKeypair(), message);
          proofs.push({
            address: derived.publicKey,
            kind: "classic",
            label: meta.label,
            isDefault: i === 0,
            signatureBase64,
          });
        } finally {
          derived.zeroize();
        }
      }
      return proofs;
    },
    [unlockedMnemonic, accountMetaList],
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
    loadingChain,
    chainError,
    fingerprintSupported,
    fingerprintEnrolled,
    setActiveIndex,
    createOrImportVault,
    restoreAgVaultJson,
    exportAgVaultJson,
    unlockWithPin,
    unlockWithBiometric,
    enableFingerprint,
    disableFingerprint,
    addDerivedAccount,
    lockVault,
    wipeLocalVault,
    refreshChainState,
    fundActiveTestnetAccount,
    sendPayment,
    addOrRemoveTrustline,
    reclaimZeroBalanceReserves,
    claimBalanceById,
    placeSdexOffer,
    handleDappRpcRequest,
    signConnectChallenge,
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
