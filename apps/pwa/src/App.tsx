import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import {
  StellarAddressSchema,
  applyPwaNetworkProfile,
  type PwaConfig,
  type StellarNetwork,
} from "@astrowallet/domain";
import {
  deriveCounterfactualSmartAccount,
  evaluateCloudBackupSecretStrength,
} from "@astrowallet/stellar-core";

function formatNanoTonDisplay(nano: string | bigint): string {
  const val = typeof nano === "bigint" ? nano : BigInt(nano || "0");
  const whole = val / 1_000_000_000n;
  const frac = (val % 1_000_000_000n).toString().padStart(9, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

function formatAssetBalance(raw: string): string {
  const num = Number(raw);
  if (!Number.isFinite(num) || num === 0) return "0.00";
  if (Math.abs(num) >= 1) {
    return num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 4 });
  }
  return num.toFixed(7).replace(/\.?0+$/, "");
}
import { AccountSwitcher } from "./components/AccountSwitcher.js";
import { AstroNavigatorAvatar } from "./components/AstroNavigatorAvatar.js";
import { AstroWalletLogo } from "./components/AstroWalletLogo.js";
import { TelegramOnlyGate } from "./components/TelegramOnlyGate.js";
import {
  IconAccounts,
  IconActivity,
  IconArrowDownLeft,
  IconArrowUpRight,
  IconBridge,
  IconChart,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconCode,
  IconCopy,
  IconEdit,
  IconEye,
  IconFingerprint,
  IconKey,
  IconLock,
  IconNft,
  IconPlug,
  IconReceive,
  IconRefresh,
  IconSearch,
  IconSend,
  IconShield,
  IconSwap,
  IconTelegram,
  IconTools,
  IconTrash,
  IconUserPlus,
  IconWallet,
  IconZap,
} from "./components/Icons.js";
import type { SelectedTokenTarget } from "./components/TokenExplorerSheet.js";
import { TokenBadge } from "./components/TokenBadge.js";
import { classifyTokenTrust } from "./components/token-catalog.js";
import {
  ConnectRequestSheet,
  parseConnectRouteFromLocation,
  type ActiveConnectRoute,
} from "./components/ConnectRequestSheet.js";
import {
  IntentSheet,
  parseIntentRouteFromLocation,
  type ActiveIntentRoute,
} from "./components/IntentSheet.js";
import { ModalDrawer } from "./components/ModalDrawer.js";
import { OnboardingSheet } from "./components/OnboardingSheet.js";
import { formatSeedBackupFilename } from "./components/onboarding-helpers.js";
import { UnlockSheet } from "./components/UnlockSheet.js";
import { loadPwaEnv } from "./config/env.js";
import { TelegramProvider, useTelegram } from "./state/telegram-context.js";
import { WalletProvider, useWallet } from "./state/wallet-context.js";
import {
  copyTextToClipboard,
  setTelegramClosingConfirmation,
  triggerTelegramHaptic,
  useTelegramBackButton,
} from "./telegram/webapp.js";

const ClassicToolsSheet = lazy(() =>
  import("./components/ClassicToolsSheet.js").then((m) => ({ default: m.ClassicToolsSheet })),
);
const CollectiblesSheet = lazy(() =>
  import("./components/CollectiblesSheet.js").then((m) => ({ default: m.CollectiblesSheet })),
);
const DevLabSheet = lazy(() =>
  import("./components/DevLabSheet.js").then((m) => ({ default: m.DevLabSheet })),
);
const RampSheet = lazy(() =>
  import("./components/RampSheet.js").then((m) => ({ default: m.RampSheet })),
);
const ReceiveSheet = lazy(() =>
  import("./components/ReceiveSheet.js").then((m) => ({ default: m.ReceiveSheet })),
);
const ScanShieldSheet = lazy(() =>
  import("./components/ScanShieldSheet.js").then((m) => ({ default: m.ScanShieldSheet })),
);
const SendSheet = lazy(() =>
  import("./components/SendSheet.js").then((m) => ({ default: m.SendSheet })),
);
const SwapSheet = lazy(() =>
  import("./components/SwapSheet.js").then((m) => ({ default: m.SwapSheet })),
);
const TonConnectSheet = lazy(() =>
  import("./components/TonConnectSheet.js").then((m) => ({ default: m.TonConnectSheet })),
);
const TonWalletSheet = lazy(() =>
  import("./components/TonWalletSheet.js").then((m) => ({ default: m.TonWalletSheet })),
);
const TokenExplorerSheet = lazy(() =>
  import("./components/TokenExplorerSheet.js").then((m) => ({ default: m.TokenExplorerSheet })),
);

export type AppDockTab = "wallet" | "ton" | "activity" | "nfts" | "accounts";

type ActiveDrawer =
  | "send"
  | "receive"
  | "swap"
  | "scan"
  | "tokens"
  | "tools"
  | "ramp"
  | "tonConnect"
  | "dev"
  | "revealSeed"
  | null;

type ActivityFilter = "all" | "received" | "sent";

interface SendPrefill {
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  destination?: string | undefined;
  memo?: string | undefined;
}

const VALID_TABS: readonly AppDockTab[] = [
  "wallet",
  "ton",
  "activity",
  "nfts",
  "accounts",
];

function parseTabFromSearch(search: string): AppDockTab | null {
  const raw = new URLSearchParams(search).get("tab");
  if (raw && (VALID_TABS as readonly string[]).includes(raw)) {
    return raw as AppDockTab;
  }
  return null;
}

function readLocationRoute(): {
  tab: AppDockTab | null;
  intent: ActiveIntentRoute | null;
  connect: ActiveConnectRoute | null;
} {
  if (typeof window === "undefined") {
    return { tab: null, intent: null, connect: null };
  }
  const intent = parseIntentRouteFromLocation();
  if (intent) {
    return { tab: "wallet", intent, connect: null };
  }
  const connect = parseConnectRouteFromLocation();
  if (connect) {
    return { tab: "wallet", intent: null, connect };
  }
  return {
    tab: parseTabFromSearch(window.location.search),
    intent: null,
    connect: null,
  };
}

function drawerMetadata(
  drawer: Exclude<ActiveDrawer, null>,
  network: string,
): { title: string; subtitle: string } {
  switch (drawer) {
    case "send":
      return {
        title: "Send Payment",
        subtitle: `Stellar ${network.toUpperCase()} · Multi-Asset, G.../M.../C..., Federation & QR`,
      };
    case "receive":
      return {
        title: "Receive Stellar Assets",
        subtitle: `Standard G..., SEP-0007 Payment Request & M... Muxed · ${network.toUpperCase()}`,
      };
    case "swap":
      return {
        title: "Swap & Path Router",
        subtitle: "Soroswap Soroban AMM + Live Horizon Path Execution",
      };
    case "scan":
      return {
        title: "Scan & Shield Firewall",
        subtitle: "Pre-sign XDR simulator & anti-drainer analysis",
      };
    case "tokens":
      return {
        title: "Stellar Token Explorer & Scanner",
        subtitle: `Official SEP-42 directory, chart, SAC C... & issuer flags · ${network.toUpperCase()}`,
      };
    case "tools":
      return {
        title: "Classic Tools & Reserves",
        subtitle: "SDEX offers, Trustlines, CAP-27 M..., Claimables & LumenWipe",
      };
    case "ramp":
      return {
        title: "CCTP Precision Guard",
        subtitle: "Circle CCTP 6↔7 USDC decimal guard & forwarder validator",
      };
    case "tonConnect":
      return {
        title: "TON Connect v2",
        subtitle: "Telegram ToS §7.3 compliant encrypted NaCl bridge sessions",
      };
    case "dev":
      return {
        title: "Developer Workbench",
        subtitle: "Soroban RPC Telemetry, Contracts, Raw XDR & SEP-0005 Tools",
      };
    case "revealSeed":
      return {
        title: "Reveal Recovery Phrase",
        subtitle: "Verify PIN locally to decrypt your SEP-0005 mnemonic",
      };
  }
}

function renderDockIcon(tab: AppDockTab) {
  switch (tab) {
    case "wallet":
      return <IconWallet size={19} />;
    case "ton":
      return <IconZap size={19} />;
    case "nfts":
      return <IconNft size={19} />;
    case "activity":
      return <IconActivity size={19} />;
    case "accounts":
      return <IconAccounts size={19} />;
  }
}

const MOBILE_DOCK_ITEMS: ReadonlyArray<{ id: AppDockTab; label: string }> = [
  { id: "wallet", label: "Wallet" },
  { id: "activity", label: "Activity" },
  { id: "accounts", label: "Accounts" },
  { id: "ton", label: "TON" },
];

function RevealSeedModalContent({ onDone }: { onDone: () => void }) {
  const { revealMnemonicWithPin, showToast } = useWallet();
  const [pin, setPin] = useState("");
  const [revealed, setRevealed] = useState<string | null>(null);
  const [unblurred, setUnblurred] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleReveal = async (e: FormEvent) => {
    e.preventDefault();
    if (!pin) return;
    setBusy(true);
    setError(null);
    try {
      const phrase = await revealMnemonicWithPin(pin);
      setRevealed(phrase);
      setPin("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid PIN");
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = async () => {
    if (!revealed) return;
    const ok = await copyTextToClipboard(revealed);
    if (ok) {
      showToast("Recovery phrase copied — clear clipboard after storing", "info");
    } else {
      showToast("Clipboard copy blocked by WebView", "error");
    }
  };

  if (!revealed) {
    return (
      <form onSubmit={handleReveal} style={{ display: "grid", gap: 12 }}>
        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
          Never share your 12/24 recovery words with anyone. Anyone holding these words controls
          all derived accounts.
        </div>
        <div>
          <label className="aw-label" htmlFor="reveal-seed-pin">
            Confirm Vault PIN / Passphrase
          </label>
          <input
            id="reveal-seed-pin"
            type="password"
            className="aw-input"
            placeholder="Enter Vault PIN"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </div>
        {error && <div className="aw-banner aw-banner--danger">{error}</div>}
        <button type="submit" className="aw-btn-primary" disabled={busy || pin.length < 6}>
          <IconEye size={15} />
          <span>{busy ? "Decrypting Vault..." : "Verify PIN & Reveal Seed"}</span>
        </button>
      </form>
    );
  }

  const words = revealed.split(" ");
  return (
    <div style={{ display: "grid", gap: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
        <button
          type="button"
          className="aw-chip-btn"
          onClick={() => setUnblurred((v) => !v)}
        >
          <IconEye size={13} />
          <span>{unblurred ? "Hide Words" : "Reveal Clear Text"}</span>
        </button>
        <button type="button" className="aw-chip-btn" onClick={() => void handleCopy()}>
          <IconCopy size={13} />
          <span>Copy Phrase</span>
        </button>
      </div>

      <div className={`aw-seed-grid ${unblurred ? "" : "aw-seed-grid--blurred"}`}>
        {words.map((word, idx) => (
          <div key={`${idx}-${word}`} className="aw-seed-word">
            <span className="aw-seed-index">{String(idx + 1).padStart(2, "0")}</span>
            <span className="aw-seed-text">{word}</span>
          </div>
        ))}
      </div>

      <button
        type="button"
        className="aw-btn-secondary"
        onClick={() => {
          setRevealed(null);
          onDone();
        }}
      >
        Hide &amp; Close
      </button>
    </div>
  );
}

function WalletShell({
  initialTab,
  initialDrawer,
  onClearInitialDrawer,
  intentRoute,
  onClearIntent,
  connectRoute,
  onClearConnect,
  onSwitchNetwork,
  canSwitchNetwork,
}: {
  initialTab: AppDockTab;
  initialDrawer?: ActiveDrawer;
  onClearInitialDrawer?: () => void;
  intentRoute: ActiveIntentRoute | null;
  onClearIntent: () => void;
  connectRoute: ActiveConnectRoute | null;
  onClearConnect: () => void;
  onSwitchNetwork?: ((next: StellarNetwork) => void) | undefined;
  canSwitchNetwork?: boolean | undefined;
}) {
  const {
    tgUser,
    sessionToken,
    linkedAccounts,
    refreshLinkedAccounts,
    hasEncryptedBackup,
    backupUpdatedAt,
    uploadEncryptedBackup,
    deleteEncryptedBackup,
  } = useTelegram();
  const {
    config,
    vaultStatus,
    accounts,
    activeAccount,
    accountState,
    recentPayments,
    recentTrades,
    claimableBalances,
    openOffers,
    contacts,
    toast,
    dismissToast,
    loadingChain,
    chainError,
    fingerprintSupported,
    fingerprintEnrolled,
    verifiedAssets,
    tokenMetaMap,
    tonAccount,
    tonConnectSessions,
    pendingTonConnectTx,
    resolvePendingTonConnectTx,
    signConnectChallenge,
    enableFingerprint,
    disableFingerprint,
    reEncryptLocalVault,
    exportAgVaultJson,
    renameDerivedAccount,
    saveContact,
    deleteContact,
    lockVault,
    wipeLocalVault,
    refreshChainState,
    fundActiveTestnetAccount,
    claimBalanceById,
    reclaimZeroBalanceReserves,
    showToast,
  } = useWallet();

  const [activeTab, setActiveTab] = useState<AppDockTab>(initialTab);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(initialDrawer ?? null);
  const [sendPrefill, setSendPrefill] = useState<SendPrefill>({});
  const [swapFromPrefill, setSwapFromPrefill] = useState<string | undefined>(undefined);
  const [swapToPrefill, setSwapToPrefill] = useState<string | undefined>(undefined);
  const [selectedTokenTarget, setSelectedTokenTarget] = useState<SelectedTokenTarget | null>(null);

  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [actionBusy, setActionBusy] = useState(false);

  // Telegram Mini App link sync & TON Connect tx approval state
  const [tgSyncBusy, setTgSyncBusy] = useState(false);
  const [tgSyncError, setTgSyncError] = useState<string | null>(null);
  const [tcApproveBusy, setTcApproveBusy] = useState(false);

  // Vault controls state
  const [fpPin, setFpPin] = useState("");
  const [fpBusy, setFpBusy] = useState(false);
  const [fpStatusMsg, setFpStatusMsg] = useState<string | null>(null);
  const [exportedVault, setExportedVault] = useState<string | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [copiedVaultExport, setCopiedVaultExport] = useState(false);

  // Zero-Knowledge Telegram cloud backup controls
  const [cloudSyncBusy, setCloudSyncBusy] = useState(false);
  const [cloudSyncError, setCloudSyncError] = useState<string | null>(null);
  const [cloudUpgradeOpen, setCloudUpgradeOpen] = useState(false);
  const [cloudCurrentPin, setCloudCurrentPin] = useState("");
  const [cloudNewPassword, setCloudNewPassword] = useState("");
  const [cloudConfirmPassword, setCloudConfirmPassword] = useState("");
  const [pendingSyncEnvelopeJson, setPendingSyncEnvelopeJson] = useState<string | null>(null);
  const [cloudDeleteArmed, setCloudDeleteArmed] = useState(false);

  const autoLinkedKeyRef = useRef<string | null>(null);
  const onboardingBackRef = useRef<(() => void) | null>(null);
  const [onboardingCanGoBack, setOnboardingCanGoBack] = useState(false);

  const registerOnboardingBack = useCallback((handler: (() => void) | null) => {
    onboardingBackRef.current = handler;
    setOnboardingCanGoBack(handler !== null);
  }, []);

  const isWalletUnlocked = vaultStatus === "unlocked" && activeAccount !== null;

  useEffect(() => {
    if (vaultStatus !== "unlocked") {
      setExportedVault(null);
      setExportError(null);
      setActiveDrawer(null);
      setCloudUpgradeOpen(false);
      setCloudCurrentPin("");
      setCloudNewPassword("");
      setCloudConfirmPassword("");
      setPendingSyncEnvelopeJson(null);
      setCloudDeleteArmed(false);
    }
  }, [vaultStatus]);

  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [renamePin, setRenamePin] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [contactAdding, setContactAdding] = useState(false);
  const [newContactLabel, setNewContactLabel] = useState("");
  const [newContactAddr, setNewContactAddr] = useState("");
  const [newContactMemo, setNewContactMemo] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);

  const [wipeConfirmArmed, setWipeConfirmArmed] = useState(false);
  const [showMoreTools, setShowMoreTools] = useState(false);
  const [activitySubTab, setActivitySubTab] = useState<
    "payments" | "trades" | "holdings" | "ledger"
  >("payments");

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    if (initialDrawer) {
      setActiveDrawer(initialDrawer);
      onClearInitialDrawer?.();
    }
  }, [initialDrawer, onClearInitialDrawer]);

  const selectTab = useCallback((tab: AppDockTab) => {
    triggerTelegramHaptic("selection");
    setActiveTab(tab);
    if (typeof window !== "undefined") {
      window.scrollTo({ top: 0, behavior: "smooth" });
      if (window.location.pathname === "/" || window.location.pathname.startsWith("/app")) {
        const targetUrl = tab === "wallet" ? "/app" : `/app?tab=${tab}`;
        window.history.replaceState({}, "", targetUrl);
      }
    }
  }, []);

  const handleBack = useCallback(() => {
    if (pendingTonConnectTx) {
      if (!tcApproveBusy) {
        void resolvePendingTonConnectTx(false);
      }
      return;
    }
    if (activeDrawer !== null) {
      setActiveDrawer(null);
      return;
    }
    if (intentRoute !== null) {
      onClearIntent();
      return;
    }
    if (vaultStatus === "uninitialized" && onboardingBackRef.current) {
      onboardingBackRef.current();
      return;
    }
    if (isWalletUnlocked && activeTab !== "wallet") {
      selectTab("wallet");
    }
  }, [
    pendingTonConnectTx,
    tcApproveBusy,
    resolvePendingTonConnectTx,
    activeDrawer,
    intentRoute,
    onClearIntent,
    vaultStatus,
    isWalletUnlocked,
    activeTab,
    selectTab,
  ]);

  useTelegramBackButton(
    pendingTonConnectTx !== null ||
      activeDrawer !== null ||
      intentRoute !== null ||
      (vaultStatus === "uninitialized" && onboardingCanGoBack) ||
      (isWalletUnlocked && activeTab !== "wallet"),
    handleBack,
  );

  useEffect(() => {
    const shouldConfirm =
      vaultStatus === "uninitialized" ||
      activeDrawer === "send" ||
      activeDrawer === "swap" ||
      activeDrawer === "revealSeed" ||
      pendingTonConnectTx !== null ||
      intentRoute !== null;
    setTelegramClosingConfirmation(shouldConfirm);
    return () => setTelegramClosingConfirmation(false);
  }, [vaultStatus, activeDrawer, pendingTonConnectTx, intentRoute]);

  const primaryXlmBalance =
    accountState?.balances.find((b) => b.assetCode === "XLM")?.balance ?? "0.0000000";

  const reserveStats = useMemo(() => {
    const total = Math.max(0, Number(primaryXlmBalance));
    const reserved = accountState?.funded ? Number(accountState.minReserveXlm) : 0;
    const spendable = accountState?.funded
      ? Math.max(0, Number(accountState.spendableXlm))
      : 0;
    const reclaimable = accountState?.funded ? Number(accountState.reclaimableXlm) : 0;
    const denom = Math.max(total, spendable + reserved, 1);
    const spendPct = Math.min(100, Math.round((spendable / denom) * 100));
    const reservedPct = Math.min(100 - spendPct, Math.round((reserved / denom) * 100));
    return { total, reserved, spendable, reclaimable, spendPct, reservedPct };
  }, [primaryXlmBalance, accountState]);

  const filteredPayments = useMemo(() => {
    if (!activeAccount) return [];
    return recentPayments.filter((p) => {
      if (activityFilter === "all") return true;
      const inbound = p.to === activeAccount.address;
      return activityFilter === "received" ? inbound : !inbound;
    });
  }, [recentPayments, activeAccount, activityFilter]);

  const pairedSmartAccount = useMemo(() => {
    if (!activeAccount || !config.smartAccountWasmHash) return null;
    try {
      return deriveCounterfactualSmartAccount({
        guardianAddress: activeAccount.address as never,
        wasmHashHex: config.smartAccountWasmHash,
        networkPassphrase: config.networkPassphrase,
      });
    } catch {
      return null;
    }
  }, [activeAccount, config.smartAccountWasmHash, config.networkPassphrase]);

  const openSendWith = (prefill: SendPrefill = {}) => {
    setSendPrefill(prefill);
    setActiveDrawer("send");
  };

  const openSwapWith = (opts?: string | { fromAsset?: string; toAsset?: string }) => {
    if (typeof opts === "string") {
      setSwapFromPrefill(opts);
      setSwapToPrefill(undefined);
    } else {
      setSwapFromPrefill(opts?.fromAsset);
      setSwapToPrefill(opts?.toAsset);
    }
    setActiveDrawer("swap");
  };

  const openTokenExplorer = (target: SelectedTokenTarget | null = null) => {
    triggerTelegramHaptic("selection");
    setSelectedTokenTarget(target);
    setActiveDrawer("tokens");
  };

  const handleCopyAddress = async () => {
    if (!activeAccount) return;
    const ok = await copyTextToClipboard(activeAccount.address);
    if (ok) {
      setCopiedAddr(true);
      setTimeout(() => setCopiedAddr(false), 1800);
    } else {
      showToast("Clipboard copy blocked by WebView", "error");
    }
  };

  const handleCopyTxHash = async (txHash: string) => {
    const ok = await copyTextToClipboard(txHash);
    if (ok) {
      setCopiedTxId(txHash);
      setTimeout(() => setCopiedTxId(null), 1600);
    } else {
      showToast("Clipboard copy blocked by WebView", "error");
    }
  };

  const handleQuickClaimFirst = async () => {
    const first = claimableBalances[0];
    if (!first) return;
    setActionBusy(true);
    try {
      await claimBalanceById(first.id);
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to claim balance", "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleQuickReclaim = async () => {
    setActionBusy(true);
    try {
      await reclaimZeroBalanceReserves();
    } catch (err) {
      showToast(err instanceof Error ? err.message : "Failed to reclaim reserve", "error");
    } finally {
      setActionBusy(false);
    }
  };

  const handleEnrollFingerprint = async () => {
    if (!fpPin || fpBusy) return;
    setFpBusy(true);
    setFpStatusMsg(null);
    try {
      const res = await enableFingerprint(fpPin);
      setFpStatusMsg(res.message);
      setFpPin("");
    } catch (err) {
      setFpStatusMsg(err instanceof Error ? err.message : "Failed to enroll Fingerprint");
    } finally {
      setFpBusy(false);
    }
  };

  const handleExportVault = async () => {
    setExportError(null);
    try {
      const json = await exportAgVaultJson();
      setExportedVault(json);
      setCopiedVaultExport(false);
    } catch (err) {
      setExportError(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleCopyExportedVault = async () => {
    if (!exportedVault) return;
    const ok = await copyTextToClipboard(exportedVault);
    if (ok) {
      setCopiedVaultExport(true);
      triggerTelegramHaptic("selection");
      showToast("Encrypted .agvault JSON copied");
      setTimeout(() => setCopiedVaultExport(false), 1800);
    } else {
      showToast("Clipboard copy blocked by WebView — use Download instead", "error");
    }
  };

  const handleDownloadExportedVault = () => {
    if (!exportedVault) return;
    const blob = new Blob([exportedVault], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = formatSeedBackupFilename(config.network);
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    triggerTelegramHaptic("success");
    showToast("Downloaded .agvault.json backup");
  };

  const handleRenameSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (renamingIndex === null || renameBusy) return;
    setRenameBusy(true);
    setRenameError(null);
    try {
      await renameDerivedAccount(renamingIndex, renameLabel, renamePin);
      setRenamingIndex(null);
      setRenameLabel("");
      setRenamePin("");
      if (hasEncryptedBackup) {
        void exportAgVaultJson()
          .then((json) => uploadEncryptedBackup(json))
          .catch(() => undefined);
      }
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setRenameBusy(false);
    }
  };

  const handleSaveContactSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setContactError(null);
    const parsedAddr = StellarAddressSchema.safeParse(newContactAddr.trim());
    if (!parsedAddr.success) {
      setContactError("Enter a valid G..., C..., or M... Stellar address.");
      return;
    }
    try {
      await saveContact({
        label: newContactLabel,
        address: parsedAddr.data,
        defaultMemo: newContactMemo || undefined,
      });
      setNewContactLabel("");
      setNewContactAddr("");
      setNewContactMemo("");
      setContactAdding(false);
    } catch (err) {
      setContactError(err instanceof Error ? err.message : "Failed to save contact");
    }
  };

  const handleSyncWalletWithTelegram = useCallback(
    async (opts: { silent?: boolean } = {}) => {
      if (!sessionToken || accounts.length === 0) return;
      setTgSyncBusy(true);
      if (!opts.silent) {
        setTgSyncError(null);
      }
      try {
        const base = config.apiBaseUrl.replace(/\/+$/, "");
        const preferredDefault = linkedAccounts.find((a) => a.isDefault)?.address;
        const selectedIndices = accounts.map((a) => a.derivationIndex ?? 0);

        const syncToNetwork = async (targetNet: StellarNetwork) => {
          const chRes = await fetch(`${base}/v1/tg/link-challenge`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${sessionToken}`,
              "X-Astro-Network": targetNet,
            },
          });
          const chData = (await chRes.json()) as {
            intentId?: string;
            sig?: string;
            message?: string;
            error?: string;
          };
          if (!chRes.ok || !chData.intentId || !chData.sig || !chData.message) {
            throw new Error(
              chData.error ?? `Failed to start Telegram link challenge (${chRes.status})`,
            );
          }
          const proofs = await signConnectChallenge(
            chData.message,
            selectedIndices,
            Boolean(config.smartAccountWasmHash),
            preferredDefault,
          );
          const cfRes = await fetch(`${base}/v1/tg/link-confirm`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bearer ${sessionToken}`,
              "X-Astro-Network": targetNet,
            },
            body: JSON.stringify({
              intentId: chData.intentId,
              sig: chData.sig,
              accounts: proofs,
            }),
          });
          const cfData = (await cfRes.json()) as {
            ok?: boolean;
            linkedCount?: number;
            error?: string;
          };
          if (!cfRes.ok) {
            throw new Error(cfData.error ?? `Failed to verify Telegram link (${cfRes.status})`);
          }
          return cfData.linkedCount ?? proofs.length;
        };

        const linkedCount = await syncToNetwork(config.network);
        if (config.altNetworkProfile) {
          void syncToNetwork(config.altNetworkProfile.network).catch(() => undefined);
        }
        await refreshLinkedAccounts();
        if (!opts.silent) {
          triggerTelegramHaptic("success");
        }
        showToast(
          `Linked ${linkedCount} address(es) with @${config.tgBotUsername}`,
        );
      } catch (err) {
        if (!opts.silent) {
          triggerTelegramHaptic("error");
          setTgSyncError(
            err instanceof Error ? err.message : "Failed to sync wallet with Telegram",
          );
        }
      } finally {
        setTgSyncBusy(false);
      }
    },
    [
      sessionToken,
      accounts,
      linkedAccounts,
      config.apiBaseUrl,
      config.smartAccountWasmHash,
      config.tgBotUsername,
      signConnectChallenge,
      refreshLinkedAccounts,
      showToast,
    ],
  );

  // Automatically bind verified public addresses to the user's Telegram ID on unlock/import
  useEffect(() => {
    if (
      vaultStatus !== "unlocked" ||
      !activeAccount ||
      !sessionToken ||
      accounts.length === 0
    ) {
      return;
    }
    const allLinked = accounts.every((acc) =>
      linkedAccounts.some((linked) => linked.address === acc.address),
    );
    if (allLinked) return;
    const key = `${sessionToken}:${accounts.map((a) => a.address).join(",")}`;
    if (autoLinkedKeyRef.current === key) return;
    autoLinkedKeyRef.current = key;
    void handleSyncWalletWithTelegram({ silent: true });
  }, [
    vaultStatus,
    activeAccount,
    sessionToken,
    accounts,
    linkedAccounts,
    handleSyncWalletWithTelegram,
  ]);

  const handleReSyncCloudBackup = async () => {
    setCloudSyncBusy(true);
    setCloudSyncError(null);
    try {
      const json = await exportAgVaultJson();
      await uploadEncryptedBackup(json);
      triggerTelegramHaptic("success");
      showToast("Encrypted backup synced to Telegram");
    } catch (err) {
      triggerTelegramHaptic("error");
      setCloudSyncError(
        err instanceof Error ? err.message : "Failed to sync encrypted backup",
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const cloudPasswordStrength = useMemo(
    () => evaluateCloudBackupSecretStrength(cloudNewPassword),
    [cloudNewPassword],
  );

  const handleRetryPendingCloudUpload = async () => {
    if (!pendingSyncEnvelopeJson) return;
    setCloudSyncBusy(true);
    setCloudSyncError(null);
    try {
      await uploadEncryptedBackup(pendingSyncEnvelopeJson);
      setPendingSyncEnvelopeJson(null);
      setCloudCurrentPin("");
      setCloudNewPassword("");
      setCloudConfirmPassword("");
      setCloudUpgradeOpen(false);
      triggerTelegramHaptic("success");
      showToast("Telegram Zero-Knowledge Sync enabled");
    } catch (err) {
      triggerTelegramHaptic("error");
      setCloudSyncError(
        err instanceof Error ? err.message : "Cloud upload failed — tap Retry Upload again",
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleEnableCloudSyncSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setCloudSyncError(null);
    if (!cloudPasswordStrength.acceptable) {
      setCloudSyncError(
        cloudPasswordStrength.reasons[0] ??
          "Recovery Password must be at least 10 characters with strong entropy.",
      );
      return;
    }
    if (cloudNewPassword !== cloudConfirmPassword) {
      setCloudSyncError("Recovery Password confirmation does not match.");
      return;
    }
    setCloudSyncBusy(true);
    let envelopeJson: string;
    try {
      const updated = await reEncryptLocalVault(cloudCurrentPin, cloudNewPassword);
      envelopeJson = updated.envelopeJson;
    } catch (err) {
      triggerTelegramHaptic("error");
      setCloudSyncError(
        err instanceof Error ? err.message : "Failed to re-encrypt local vault",
      );
      setCloudSyncBusy(false);
      return;
    }

    try {
      await uploadEncryptedBackup(envelopeJson);
      setPendingSyncEnvelopeJson(null);
      setCloudCurrentPin("");
      setCloudNewPassword("");
      setCloudConfirmPassword("");
      setCloudUpgradeOpen(false);
      triggerTelegramHaptic("success");
      showToast("Telegram Zero-Knowledge Sync enabled");
    } catch (err) {
      setPendingSyncEnvelopeJson(envelopeJson);
      setCloudCurrentPin("");
      triggerTelegramHaptic("error");
      setCloudSyncError(
        `Local vault updated to your new Recovery Password, but cloud upload failed: ${err instanceof Error ? err.message : "network error"}. Tap Retry Upload below.`,
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleDeleteCloudBackup = async () => {
    setCloudSyncBusy(true);
    setCloudSyncError(null);
    try {
      await deleteEncryptedBackup();
      setCloudDeleteArmed(false);
      triggerTelegramHaptic("warning");
      showToast("Removed cloud copy (local vault kept on device)", "info");
    } catch (err) {
      setCloudSyncError(
        err instanceof Error ? err.message : "Failed to remove cloud copy",
      );
    } finally {
      setCloudSyncBusy(false);
    }
  };

  const handleApproveTonConnectTx = async () => {
    setTcApproveBusy(true);
    try {
      await resolvePendingTonConnectTx(true);
    } catch (err) {
      triggerTelegramHaptic("error");
      showToast(
        err instanceof Error ? err.message : "TON Connect transaction signing failed",
        "error",
      );
    } finally {
      setTcApproveBusy(false);
    }
  };

  const currentDrawerMeta = activeDrawer
    ? drawerMetadata(activeDrawer, config.network)
    : null;

  return (
    <div className="aw-app-canvas">
      <div className="aw-app-frame">
        {/* Main Mini App Workspace Stage */}
        <main className={isWalletUnlocked ? "aw-app-main" : "aw-app-main aw-app-main--no-dock"}>
          <div className="aw-main-inner">
            {/* Compact Mini App Header */}
            <header className="aw-mobile-header">
              <button
                type="button"
                className="aw-sidebar-brand"
                onClick={() => {
                  if (isWalletUnlocked) selectTab("wallet");
                }}
                title="AstroWallet Home"
              >
                <AstroWalletLogo size={34} />
                <div className="aw-brand-text">
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                    AstroWallet
                  </div>
                  <div className="aw-brand-subline">
                    {tgUser?.username ? `@${tgUser.username} · Stellar & TON` : "Stellar & TON Mini App"}
                  </div>
                </div>
              </button>

              <div className="aw-header-actions">
                {isWalletUnlocked && (
                  <button
                    type="button"
                    className="aw-chip-btn"
                    aria-label="Open TON Connect"
                    onClick={() => setActiveDrawer("tonConnect")}
                  >
                    <IconPlug size={14} />
                    {tonConnectSessions.length > 0 && (
                      <span className="tabular-nums">{tonConnectSessions.length}</span>
                    )}
                  </button>
                )}
                {canSwitchNetwork && onSwitchNetwork ? (
                  <button
                    type="button"
                    className={
                      config.network === "testnet"
                        ? "glass-pill glass-pill--gold"
                        : "glass-pill glass-pill--trust"
                    }
                    style={{ cursor: "pointer", border: "none", fontFamily: "inherit" }}
                    title={`Switch to ${config.network === "mainnet" ? "TESTNET" : "MAINNET"}`}
                    onClick={() => {
                      const next: StellarNetwork =
                        config.network === "mainnet" ? "testnet" : "mainnet";
                      triggerTelegramHaptic("selection");
                      onSwitchNetwork(next);
                    }}
                  >
                    {config.network.toUpperCase()} ⇄
                  </button>
                ) : (
                  <span
                    className={
                      config.network === "testnet"
                        ? "glass-pill glass-pill--gold"
                        : "glass-pill glass-pill--trust"
                    }
                  >
                    {config.network.toUpperCase()}
                  </span>
                )}
                {isWalletUnlocked && (
                  <button type="button" className="aw-chip-btn" onClick={lockVault}>
                    <IconLock size={13} />
                    <span>Lock</span>
                  </button>
                )}
              </div>
            </header>

            {intentRoute && (
              <IntentSheet route={intentRoute} onDismiss={onClearIntent} />
            )}

            {connectRoute && (
              <ConnectRequestSheet route={connectRoute} onDismiss={onClearConnect} />
            )}

            {vaultStatus === "loading" && (
              <section className="glass-card" style={{ textAlign: "center", padding: 32 }}>
                Opening encrypted IndexedDB vault...
              </section>
            )}

            {vaultStatus === "uninitialized" && (
              <div className="aw-center-stage">
                <OnboardingSheet onRegisterBackHandler={registerOnboardingBack} />
              </div>
            )}

            {vaultStatus === "locked" && (
              <div className="aw-center-stage">
                <UnlockSheet />
              </div>
            )}

            {vaultStatus === "unlocked" && activeAccount && (
              <>
                {activeTab !== "accounts" && <AccountSwitcher />}

                {activeTab === "wallet" && (
                  <div className="aw-wallet-stack">
                    {/* Hero Balance, Spendable Reserve Bar & Quick Actions */}
                    <section className="glass-card glass-card--vault aw-hero-balance-card">
                      <div className="aw-balance-top">
                        <div className="aw-pixel-frame">
                          <AstroNavigatorAvatar
                            seedKey={activeAccount.address}
                            kind={activeAccount.kind}
                            state={loadingChain ? "warp" : "float"}
                            size={82}
                          />
                        </div>

                        <div className="aw-balance-meta">
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                            <span className="glass-pill">{activeAccount.label}</span>
                            <button
                              type="button"
                              className="aw-chip-btn"
                              onClick={() => void handleCopyAddress()}
                              title="Copy public Stellar address"
                            >
                              {copiedAddr ? <IconCheck size={13} /> : <IconCopy size={13} />}
                              <code>
                                {activeAccount.address.slice(0, 6)}…{activeAccount.address.slice(-4)}
                              </code>
                            </button>
                          </div>

                          <div className="aw-balance-figure tabular-nums">
                            {reserveStats.total.toFixed(2)}{" "}
                            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--aw-stellar-gold)" }}>
                              XLM
                            </span>
                          </div>

                          {accountState?.funded ? (
                            <div className="aw-reserve-panel">
                              <div className="aw-reserve-labels tabular-nums">
                                <span style={{ color: "var(--aw-trust-emerald)" }}>
                                  Spendable: {reserveStats.spendable.toFixed(2)} XLM
                                </span>
                                <span style={{ color: "var(--aw-ink-secondary)" }}>
                                  Reserved: {reserveStats.reserved.toFixed(2)} XLM ({accountState.subentryCount} entries)
                                </span>
                              </div>
                              <div className="aw-reserve-track" aria-hidden="true">
                                <div
                                  className="aw-reserve-fill aw-reserve-fill--spendable"
                                  style={{ width: `${reserveStats.spendPct}%` }}
                                />
                                <div
                                  className="aw-reserve-fill aw-reserve-fill--reserved"
                                  style={{ width: `${reserveStats.reservedPct}%` }}
                                />
                              </div>
                            </div>
                          ) : (
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              Unfunded account on {config.network.toUpperCase()} ledger
                            </div>
                          )}
                        </div>
                      </div>

                      {chainError && (
                        <div className="aw-banner aw-banner--danger" style={{ marginTop: 4 }}>
                          {chainError}
                        </div>
                      )}

                      {config.network === "testnet" &&
                        config.friendbotUrl &&
                        accountState &&
                        !accountState.funded && (
                          <button
                            type="button"
                            className="aw-btn-gold"
                            style={{ width: "100%" }}
                            disabled={loadingChain}
                            onClick={() => void fundActiveTestnetAccount()}
                          >
                            <IconZap size={16} />
                            <span>
                              {loadingChain
                                ? "Funding via Testnet Friendbot..."
                                : "Activate & Fund 10,000 Testnet XLM (1-Click Friendbot)"}
                            </span>
                          </button>
                        )}

                      {/* Actionable On-Chain Banners */}
                      {claimableBalances.length > 0 && (
                        <div className="aw-action-alert">
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                              {claimableBalances.length} Incoming Claimable Balance
                              {claimableBalances.length > 1 ? "s" : ""}
                            </div>
                            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                              Next: {claimableBalances[0]?.amount} {claimableBalances[0]?.assetCode}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="aw-chip-btn"
                            disabled={actionBusy}
                            onClick={() => void handleQuickClaimFirst()}
                          >
                            Claim First
                          </button>
                        </div>
                      )}

                      {reserveStats.reclaimable > 0 && (
                        <div className="aw-action-alert">
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 13, color: "var(--aw-stellar-gold)" }}>
                              +{accountState?.reclaimableXlm} XLM Reclaimable Reserve
                            </div>
                            <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                              Empty trustlines holding unnecessary 0.5 XLM base reserves
                            </div>
                          </div>
                          <button
                            type="button"
                            className="aw-chip-btn"
                            disabled={actionBusy}
                            onClick={() => void handleQuickReclaim()}
                          >
                            Reclaim XLM
                          </button>
                        </div>
                      )}

                      {/* 4 Quick Actions */}
                      <div className="aw-quick-actions">
                        <button
                          type="button"
                          className="aw-action-tile aw-action-tile--primary"
                          onClick={() => openSendWith()}
                        >
                          <span className="aw-action-circle">
                            <IconSend size={18} />
                          </span>
                          <span className="aw-action-label">Send</span>
                        </button>

                        <button
                          type="button"
                          className="aw-action-tile"
                          onClick={() => setActiveDrawer("receive")}
                        >
                          <span className="aw-action-circle">
                            <IconReceive size={18} />
                          </span>
                          <span className="aw-action-label">Receive</span>
                        </button>

                        <button
                          type="button"
                          className="aw-action-tile"
                          onClick={() => openSwapWith()}
                        >
                          <span className="aw-action-circle">
                            <IconSwap size={18} />
                          </span>
                          <span className="aw-action-label">Swap</span>
                        </button>

                        <button
                          type="button"
                          className="aw-action-tile"
                          onClick={() => setActiveDrawer("scan")}
                        >
                          <span className="aw-action-circle">
                            <IconShield size={18} />
                          </span>
                          <span className="aw-action-label">Shield</span>
                        </button>
                      </div>
                    </section>

                    {/* Balanced Desktop 2-Column Dashboard Grid */}
                    <div className="aw-wallet-grid">
                      {/* Left: Multi-Asset Balances Card */}
                      <section className="glass-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                            gap: 8,
                            flexWrap: "wrap",
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: 15 }}>On-Chain Balances</span>
                          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="aw-chip-btn"
                              onClick={() => openTokenExplorer(null)}
                            >
                              <IconSearch size={13} />
                              <span>Explore Tokens</span>
                            </button>
                            <button
                              type="button"
                              className="aw-chip-btn"
                              onClick={() => setActiveDrawer("tools")}
                            >
                              + Trustline
                            </button>
                            <button
                              type="button"
                              className="aw-chip-btn"
                              disabled={loadingChain}
                              onClick={() => void refreshChainState()}
                            >
                              <IconRefresh size={13} />
                              <span>{loadingChain ? "Syncing..." : "Refresh"}</span>
                            </button>
                          </div>
                        </div>

                        {accountState?.balances && accountState.balances.length > 0 ? (
                          <div style={{ display: "grid", gap: 8 }}>
                            {accountState.balances.map((b) => {
                              const isNativeAsset = b.assetCode === "XLM" && !b.assetIssuer;
                              const matchedVerified = verifiedAssets.find(
                                (v) =>
                                  v.code.toUpperCase() === b.assetCode.toUpperCase() &&
                                  v.issuer === b.assetIssuer,
                              );
                              const tomlMeta = b.assetIssuer
                                ? tokenMetaMap[`${b.assetCode.toUpperCase()}:${b.assetIssuer}`]
                                : undefined;
                              const resolvedIcon = tomlMeta?.image ?? matchedVerified?.icon;
                              const resolvedFallbackIcon =
                                tomlMeta?.image &&
                                matchedVerified?.icon &&
                                matchedVerified.icon !== tomlMeta.image
                                  ? matchedVerified.icon
                                  : undefined;
                              const resolvedName = tomlMeta?.name ?? matchedVerified?.name;
                              const resolvedDomain = tomlMeta?.homeDomain ?? matchedVerified?.domain;
                              const trust = classifyTokenTrust({
                                assetCode: b.assetCode,
                                assetIssuer: b.assetIssuer,
                                verifiedAssets,
                              });
                              const explorerTarget: SelectedTokenTarget = {
                                assetCode: b.assetCode,
                                assetIssuer: b.assetIssuer,
                                name: resolvedName,
                                domain: resolvedDomain,
                                icon: resolvedIcon,
                              };
                              return (
                                <div
                                  key={`${b.assetCode}:${b.assetIssuer ?? "native"}`}
                                  className="aw-balance-row"
                                >
                                  <div className="aw-balance-row-top">
                                    <button
                                      type="button"
                                      className="aw-balance-row-main"
                                      onClick={() => openTokenExplorer(explorerTarget)}
                                    >
                                      <TokenBadge
                                        code={b.assetCode}
                                        icon={resolvedIcon}
                                        fallbackIcon={resolvedFallbackIcon}
                                        isNative={isNativeAsset}
                                        size={36}
                                        trustStatus={trust.status}
                                      />
                                      <div style={{ minWidth: 0, flex: 1 }}>
                                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                          <span style={{ fontWeight: 700, fontSize: 14 }}>{b.assetCode}</span>
                                          {(b.isVerifiedAsset || trust.status === "official") && (
                                            <span className="glass-pill glass-pill--trust" style={{ padding: "1px 6px", fontSize: 10 }}>
                                              ✓ Official
                                            </span>
                                          )}
                                        </div>
                                        <div
                                          style={{
                                            fontSize: 11,
                                            color: "var(--aw-ink-secondary)",
                                            overflow: "hidden",
                                            textOverflow: "ellipsis",
                                            whiteSpace: "nowrap",
                                          }}
                                        >
                                          {resolvedDomain
                                            ? resolvedName
                                              ? `${resolvedName} · ${resolvedDomain}`
                                              : resolvedDomain
                                            : b.assetIssuer
                                              ? `${b.assetIssuer.slice(0, 6)}…${b.assetIssuer.slice(-4)}`
                                              : "Native Stellar Lumen"}
                                        </div>
                                      </div>
                                    </button>

                                    <div className="aw-balance-row-amount tabular-nums">
                                      {formatAssetBalance(b.balance)}
                                    </div>
                                  </div>

                                  <div className="aw-balance-row-actions">
                                    <button
                                      type="button"
                                      className="aw-mini-chip"
                                      onClick={() => openTokenExplorer(explorerTarget)}
                                    >
                                      <IconChart size={11} />
                                      <span>Inspect</span>
                                    </button>
                                    <button
                                      type="button"
                                      className="aw-mini-chip"
                                      onClick={() =>
                                        openSendWith({
                                          assetCode: b.assetCode,
                                          assetIssuer: b.assetIssuer,
                                        })
                                      }
                                    >
                                      Send
                                    </button>
                                    <button
                                      type="button"
                                      className="aw-mini-chip"
                                      onClick={() =>
                                        openSwapWith(
                                          b.assetIssuer ? `${b.assetCode}:${b.assetIssuer}` : b.assetCode,
                                        )
                                      }
                                    >
                                      Swap
                                    </button>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        ) : (
                          <div className="aw-empty-state">
                            <div style={{ fontWeight: 600, fontSize: 13 }}>No ledger balances yet</div>
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              Fund this account with at least 1 XLM to activate it on{" "}
                              {config.network.toUpperCase()}.
                            </div>
                          </div>
                        )}

                        {verifiedAssets.length > 0 && (
                          <div className="aw-vault-divider">
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--aw-ink-secondary)" }}>
                                Official Stellar Tokens (SEP-42)
                              </span>
                              <button
                                type="button"
                                className="aw-mini-chip"
                                onClick={() => openTokenExplorer(null)}
                              >
                                View All ({verifiedAssets.length + 1})
                              </button>
                            </div>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              {verifiedAssets.slice(0, 6).map((v) => (
                                <button
                                  key={`${v.code}:${v.issuer}`}
                                  type="button"
                                  className="aw-mini-chip"
                                  onClick={() =>
                                    openTokenExplorer({
                                      assetCode: v.code,
                                      assetIssuer: v.issuer,
                                      name: v.name,
                                      domain: v.domain,
                                      icon: v.icon,
                                    })
                                  }
                                >
                                  <TokenBadge
                                    code={v.code}
                                    icon={v.icon}
                                    size={16}
                                    trustStatus="official"
                                  />
                                  <span>{v.code}</span>
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </section>

                      {/* Right: Progressive-Disclosure Pro Tools Drawer Launcher */}
                      <section className="glass-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
                        <button
                          type="button"
                          onClick={() => setShowMoreTools((prev) => !prev)}
                          aria-expanded={showMoreTools}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "space-between",
                            gap: 10,
                            width: "100%",
                            background: "transparent",
                            border: "none",
                            padding: 0,
                            color: "inherit",
                            fontFamily: "inherit",
                            cursor: "pointer",
                            textAlign: "left",
                          }}
                        >
                          <div style={{ minWidth: 0 }}>
                            <div style={{ fontWeight: 700, fontSize: 15 }}>More Tools</div>
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              Reserves, Bridge, TON Connect, Dev Lab
                            </div>
                          </div>
                          <span className="aw-chip-btn" style={{ flexShrink: 0 }}>
                            <span>{showMoreTools ? "Hide" : "Open"}</span>
                            <span
                              style={{
                                display: "inline-flex",
                                transform: showMoreTools ? "rotate(90deg)" : undefined,
                                transition: "transform 160ms ease",
                              }}
                            >
                              <IconChevronRight size={14} />
                            </span>
                          </span>
                        </button>

                        {showMoreTools && (
                          <div style={{ display: "grid", gap: 10 }}>
                            <div className="aw-tool-grid">
                              <button
                                type="button"
                                className="aw-tool-card"
                                onClick={() => setActiveDrawer("tools")}
                              >
                                <div className="aw-tool-card-top">
                                  <span className="aw-tool-icon aw-tool-icon--gold">
                                    <IconTools size={18} />
                                  </span>
                                  <IconChevronRight size={16} />
                                </div>
                                <div className="aw-tool-title">Classic &amp; Reserves</div>
                                <div className="aw-tool-sub">SDEX, M..., LumenWipe</div>
                              </button>

                              <button
                                type="button"
                                className="aw-tool-card"
                                onClick={() => setActiveDrawer("ramp")}
                              >
                                <div className="aw-tool-card-top">
                                  <span className="aw-tool-icon aw-tool-icon--orange">
                                    <IconBridge size={18} />
                                  </span>
                                  <IconChevronRight size={16} />
                                </div>
                                <div className="aw-tool-title">CCTP Bridge</div>
                                <div className="aw-tool-sub">Circle CCTP 6&harr;7 Guard</div>
                              </button>

                              <button
                                type="button"
                                className="aw-tool-card"
                                onClick={() => setActiveDrawer("tonConnect")}
                              >
                                <div className="aw-tool-card-top">
                                  <span className="aw-tool-icon aw-tool-icon--purple">
                                    <IconPlug size={18} />
                                  </span>
                                  <IconChevronRight size={16} />
                                </div>
                                <div className="aw-tool-title">TON Connect</div>
                                <div className="aw-tool-sub">Linked dApp sessions</div>
                              </button>

                              <button
                                type="button"
                                className="aw-tool-card"
                                onClick={() => selectTab("nfts")}
                              >
                                <div className="aw-tool-card-top">
                                  <span className="aw-tool-icon aw-tool-icon--emerald">
                                    <IconNft size={18} />
                                  </span>
                                  <IconChevronRight size={16} />
                                </div>
                                <div className="aw-tool-title">Collectibles</div>
                                <div className="aw-tool-sub">View on-chain assets</div>
                              </button>
                            </div>

                            <button
                              type="button"
                              className="aw-chip-btn"
                              style={{ justifyContent: "center" }}
                              onClick={() => setActiveDrawer("dev")}
                            >
                              <IconCode size={13} />
                              <span>Open Dev Lab</span>
                            </button>
                          </div>
                        )}
                      </section>
                    </div>
                  </div>
                )}

                {activeTab === "ton" && (
                  <Suspense
                    fallback={
                      <section className="glass-card" style={{ padding: 24, textAlign: "center" }}>
                        Loading TON Wallet...
                      </section>
                    }
                  >
                    <TonWalletSheet
                      onOpenCrossChainBridge={() => setActiveDrawer("ramp")}
                    />
                  </Suspense>
                )}

                {activeTab === "nfts" && (
                  <Suspense
                    fallback={
                      <section className="glass-card" style={{ padding: 24, textAlign: "center" }}>
                        Loading Collectibles...
                      </section>
                    }
                  >
                    <CollectiblesSheet />
                  </Suspense>
                )}

                {activeTab === "activity" && (
                  <section className="glass-card" style={{ display: "grid", gap: 12 }}>
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 10,
                        flexWrap: "wrap",
                      }}
                    >
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>
                          Horizon Activity · {activeAccount.label}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                          Live payments settled on Stellar {config.network.toUpperCase()}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="aw-chip-btn"
                        disabled={loadingChain}
                        onClick={() => void refreshChainState()}
                      >
                        <IconRefresh size={13} />
                        <span>{loadingChain ? "Syncing..." : "Refresh"}</span>
                      </button>
                    </div>

                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                      {(
                        [
                          ["payments", "Payments"],
                          ["trades", `Trades & Offers (${recentTrades.length + openOffers.length})`],
                          ["holdings", `Claims & Holdings (${claimableBalances.length})`],
                          ["ledger", "Signers & Ledger"],
                        ] as const
                      ).map(([id, label]) => (
                        <button
                          key={id}
                          type="button"
                          className="aw-chip-btn"
                          aria-pressed={activitySubTab === id}
                          onClick={() => setActivitySubTab(id)}
                        >
                          {label}
                        </button>
                      ))}
                    </div>

                    {activitySubTab === "payments" && (
                      <>
                        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                          {(
                            [
                              ["all", "All"],
                              ["received", "Received"],
                              ["sent", "Sent"],
                            ] as const
                          ).map(([id, label]) => (
                            <button
                              key={id}
                              type="button"
                              className="aw-chip-btn"
                              aria-pressed={activityFilter === id}
                              onClick={() => setActivityFilter(id)}
                            >
                              {label}
                            </button>
                          ))}
                        </div>

                        {filteredPayments.length === 0 ? (
                          <div className="aw-empty-state">
                            <div style={{ fontWeight: 600, fontSize: 14 }}>
                              No {activityFilter === "all" ? "" : `${activityFilter} `}transactions on{" "}
                              {config.network.toUpperCase()}
                            </div>
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              Receive XLM or test a payment to inspect live ledger confirmations here.
                            </div>
                            <div
                              style={{
                                display: "flex",
                                gap: 8,
                                flexWrap: "wrap",
                                justifyContent: "center",
                                marginTop: 6,
                              }}
                            >
                              <button
                                type="button"
                                className="aw-btn-secondary"
                                onClick={() => setActiveDrawer("receive")}
                              >
                                <IconReceive size={15} />
                                <span>Receive / QR</span>
                              </button>
                              {config.network === "testnet" &&
                                config.friendbotUrl &&
                                accountState &&
                                !accountState.funded && (
                                  <button
                                    type="button"
                                    className="aw-btn-gold"
                                    disabled={loadingChain}
                                    onClick={() => void fundActiveTestnetAccount()}
                                  >
                                    <IconZap size={15} />
                                    <span>Fund 10,000 XLM</span>
                                  </button>
                                )}
                            </div>
                          </div>
                        ) : (
                          filteredPayments.map((p) => {
                            const inbound = p.to === activeAccount.address;
                            return (
                              <div key={p.id} className="aw-list-row" style={{ flexWrap: "wrap" }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span
                                    className={
                                      inbound
                                        ? "aw-tx-dir aw-tx-dir--in"
                                        : "aw-tx-dir aw-tx-dir--out"
                                    }
                                  >
                                    {inbound ? (
                                      <IconArrowDownLeft size={16} />
                                    ) : (
                                      <IconArrowUpRight size={16} />
                                    )}
                                  </span>
                                  <div>
                                    <div style={{ fontWeight: 700, fontSize: 13 }}>
                                      {inbound ? "Received" : "Sent"} {p.assetCode}
                                    </div>
                                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                      {inbound
                                        ? `From ${p.from.slice(0, 6)}…${p.from.slice(-4)}`
                                        : `To ${p.to.slice(0, 6)}…${p.to.slice(-4)}`}{" "}
                                      · {new Date(p.createdAt).toLocaleString()}
                                    </div>
                                  </div>
                                </div>

                                <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr)", justifyItems: "end", gap: 4, marginLeft: "auto", minWidth: 0 }}>
                                  <div
                                    className="tabular-nums"
                                    style={{
                                      fontWeight: 700,
                                      color: inbound
                                        ? "var(--aw-safe-emerald)"
                                        : "var(--aw-ink-primary)",
                                    }}
                                  >
                                    {inbound ? "+" : "-"}
                                    {p.amount} {p.assetCode}
                                  </div>
                                  <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap", justifyContent: "flex-end" }}>
                                    <button
                                      type="button"
                                      className="aw-mini-chip"
                                      onClick={() => void handleCopyTxHash(p.txHash)}
                                    >
                                      {copiedTxId === p.txHash ? "Copied Hash" : "Copy Tx"}
                                    </button>
                                    {config.explorerBaseUrl && (
                                      <a
                                        href={`${config.explorerBaseUrl.replace(/\/+$/, "")}/tx/${p.txHash}`}
                                        target="_blank"
                                        rel="noreferrer"
                                        className="aw-mini-chip"
                                      >
                                        Explorer ↗
                                      </a>
                                    )}
                                  </div>
                                </div>
                              </div>
                            );
                          })
                        )}
                      </>
                    )}

                    {activitySubTab === "trades" && (
                      <div style={{ display: "grid", gap: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Open SDEX Orders ({openOffers.length})
                        </div>
                        {openOffers.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            No active SDEX limit offers on this account.
                          </div>
                        ) : (
                          openOffers.map((o) => (
                            <div key={o.id} className="aw-list-row" style={{ flexWrap: "wrap" }}>
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>
                                  Sell {o.amount} {o.sellingAssetCode} → {o.buyingAssetCode}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                  Price: {o.price} · Offer #{o.id} · Ledger #{o.lastModifiedLedger}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="aw-mini-chip"
                                onClick={() => setActiveDrawer("tools")}
                              >
                                Manage in SDEX
                              </button>
                            </div>
                          ))
                        )}

                        <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4 }}>
                          Executed Trades ({recentTrades.length})
                        </div>
                        {recentTrades.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            No executed SDEX/AMM trades recorded for this account.
                          </div>
                        ) : (
                          recentTrades.map((t) => (
                            <div key={t.id} className="aw-list-row" style={{ flexWrap: "wrap" }}>
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>
                                  {t.baseAmount} {t.baseAssetCode} ⇄ {t.counterAmount}{" "}
                                  {t.counterAssetCode}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                  Rate: {t.price} · {new Date(t.ledgerCloseTime).toLocaleString()}
                                </div>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}

                    {activitySubTab === "holdings" && (
                      <div style={{ display: "grid", gap: 10 }}>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Pending Claimable Balances ({claimableBalances.length})
                        </div>
                        {claimableBalances.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            No incoming claimable balances pending for this account.
                          </div>
                        ) : (
                          claimableBalances.map((cb) => (
                            <div key={cb.id} className="aw-list-row" style={{ flexWrap: "wrap" }}>
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>
                                  +{cb.amount} {cb.assetCode}
                                </div>
                                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                  {cb.sponsor
                                    ? `Sponsor: ${cb.sponsor.slice(0, 6)}…${cb.sponsor.slice(-4)}`
                                    : "Claimable balance"}{" "}
                                  · Ledger #{cb.lastModifiedLedger}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="aw-mini-chip"
                                disabled={actionBusy}
                                onClick={() => void claimBalanceById(cb.id)}
                              >
                                Claim
                              </button>
                            </div>
                          ))
                        )}

                        <div style={{ fontWeight: 700, fontSize: 13, marginTop: 4 }}>
                          All Holdings &amp; Trustline Details ({accountState?.balances.length ?? 0})
                        </div>
                        {!accountState || accountState.balances.length === 0 ? (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Account has no active balances yet.
                          </div>
                        ) : (
                          accountState.balances.map((b) => {
                            const key = `${b.assetCode}:${b.assetIssuer ?? "native"}`;
                            return (
                              <div key={key} className="aw-contract-seals" style={{ fontSize: 12 }}>
                                <div className="aw-seal-row">
                                  <strong>
                                    {b.assetCode} ({formatAssetBalance(b.balance)})
                                  </strong>
                                  <button
                                    type="button"
                                    className="aw-mini-chip"
                                    onClick={() =>
                                      openTokenExplorer({
                                        assetCode: b.assetCode,
                                        assetIssuer: b.assetIssuer,
                                      })
                                    }
                                  >
                                    Inspect Token ↗
                                  </button>
                                </div>
                                {b.assetIssuer && (
                                  <div className="aw-seal-row">
                                    <span>Issuer</span>
                                    <code>
                                      {b.assetIssuer.slice(0, 8)}…{b.assetIssuer.slice(-6)}
                                    </code>
                                  </div>
                                )}
                                <div className="aw-seal-row">
                                  <span>Liabilities (Sell / Buy)</span>
                                  <code className="tabular-nums">
                                    {b.sellingLiabilities ?? "0"} / {b.buyingLiabilities ?? "0"}
                                  </code>
                                </div>
                                {b.assetIssuer && (
                                  <div className="aw-seal-row">
                                    <span>Trustline Limit &amp; Flags</span>
                                    <code className="tabular-nums">
                                      Limit: {b.limit ? formatAssetBalance(b.limit) : "Max"} ·{" "}
                                      {b.isAuthorized === false ? "Frozen" : "Authorized"}
                                      {b.isClawbackEnabled ? " · Clawback" : ""}
                                    </code>
                                  </div>
                                )}
                                {b.sponsor && (
                                  <div className="aw-seal-row">
                                    <span>Reserve Sponsor</span>
                                    <code>
                                      {b.sponsor.slice(0, 6)}…{b.sponsor.slice(-4)}
                                    </code>
                                  </div>
                                )}
                              </div>
                            );
                          })
                        )}
                      </div>
                    )}

                    {activitySubTab === "ledger" && (
                      <div style={{ display: "grid", gap: 10 }}>
                        {!accountState?.funded ? (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Account is not yet activated on Stellar {config.network.toUpperCase()}.
                          </div>
                        ) : (
                          <>
                            <div className="aw-contract-seals" style={{ fontSize: 12 }}>
                              <div className="aw-seal-row">
                                <span>Sequence Number</span>
                                <code className="tabular-nums">{accountState.sequence ?? "—"}</code>
                              </div>
                              <div className="aw-seal-row">
                                <span>Reserves &amp; Subentries</span>
                                <code className="tabular-nums">
                                  Min {accountState.minReserveXlm} XLM · {accountState.subentryCount}{" "}
                                  subentries · Sponsoring {accountState.numSponsoring} / Sponsored{" "}
                                  {accountState.numSponsored}
                                </code>
                              </div>
                              <div className="aw-seal-row">
                                <span>Thresholds (Low / Med / High)</span>
                                <code className="tabular-nums">
                                  {accountState.thresholds
                                    ? `${accountState.thresholds.lowThreshold} / ${accountState.thresholds.medThreshold} / ${accountState.thresholds.highThreshold}`
                                    : "0 / 0 / 0"}
                                </code>
                              </div>
                              <div className="aw-seal-row">
                                <span>Home Domain</span>
                                <code>{accountState.homeDomain ?? "None"}</code>
                              </div>
                              <div className="aw-seal-row">
                                <span>Account Flags</span>
                                <code>
                                  {[
                                    accountState.flags?.authRequired ? "AUTH_REQ" : null,
                                    accountState.flags?.authRevocable ? "AUTH_REV" : null,
                                    accountState.flags?.authImmutable ? "IMMUTABLE" : null,
                                    accountState.flags?.authClawbackEnabled ? "CLAWBACK" : null,
                                  ]
                                    .filter(Boolean)
                                    .join(" · ") || "Standard (Permissionless)"}
                                </code>
                              </div>
                            </div>

                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                              Multi-Sig Signers ({accountState.signers?.length ?? 0})
                            </div>
                            {(accountState.signers ?? []).map((s) => (
                              <div key={s.key} className="aw-seal-row" style={{ fontSize: 12 }}>
                                <code>
                                  {s.key.slice(0, 8)}…{s.key.slice(-6)} ({s.type})
                                </code>
                                <span className="glass-pill tabular-nums">Weight {s.weight}</span>
                              </div>
                            ))}

                            <div style={{ fontWeight: 700, fontSize: 13 }}>
                              On-Chain Data Entries ({accountState.dataEntries?.length ?? 0})
                            </div>
                            {!accountState.dataEntries || accountState.dataEntries.length === 0 ? (
                              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                                No ManageData key/value entries stored on this account.
                              </div>
                            ) : (
                              accountState.dataEntries.map((d) => (
                                <div key={d.key} className="aw-seal-row" style={{ fontSize: 12 }}>
                                  <strong>{d.key}</strong>
                                  <code>{d.value}</code>
                                </div>
                              ))
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </section>
                )}

                {activeTab === "accounts" && (
                  <div style={{ display: "grid", gap: 14 }}>
                    {/* Telegram Mini App Identity & Wallet Sync */}
                    <section className="glass-card" style={{ display: "grid", gap: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <AstroNavigatorAvatar
                            seedKey={activeAccount.address}
                            kind="classic"
                            state="comms"
                            size={44}
                          />
                          <div>
                            <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
                              <IconTelegram size={16} />
                              <span>Telegram Mini App Sync</span>
                            </div>
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              {tgUser?.username
                                ? `@${tgUser.username}`
                                : tgUser
                                  ? `Telegram ID ${tgUser.id}`
                                  : "Outside Telegram (Dev Mode)"}{" "}
                              · {linkedAccounts.length} linked address(es) on @{config.tgBotUsername}
                            </div>
                          </div>
                        </div>

                        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                          <span
                            className={`glass-pill ${
                              linkedAccounts.length > 0 ? "glass-pill--trust" : "glass-pill--gold"
                            }`}
                          >
                            {linkedAccounts.length > 0 ? "Auto-Linked ✓" : "Sync Pending"}
                          </span>
                          <button
                            type="button"
                            className="aw-btn-primary"
                            disabled={tgSyncBusy || !sessionToken || accounts.length === 0}
                            onClick={() => void handleSyncWalletWithTelegram()}
                          >
                            <IconTelegram size={15} />
                            <span>{tgSyncBusy ? "Signing & Syncing..." : "Re-Sync Addresses"}</span>
                          </button>
                        </div>
                      </div>

                      {!sessionToken && (
                        <div className="aw-banner aw-banner--warn" style={{ fontSize: 12 }}>
                          Open inside Telegram (<code>@{config.tgBotUsername}</code>) to sign and
                          sync accounts automatically via verified <code>initData</code>.
                        </div>
                      )}
                      {tgSyncError && (
                        <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
                          {tgSyncError}
                        </div>
                      )}
                    </section>

                    {/* Derived Accounts + Rename */}
                    <section className="glass-card" style={{ display: "grid", gap: 14 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 16 }}>
                            SEP-0005 Multi-Account Vault &amp; Biometrics
                          </div>
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Deterministic keys encrypted locally in IndexedDB
                          </div>
                        </div>
                        <span className="glass-pill glass-pill--trust">
                          {accounts.length} Derived
                        </span>
                      </div>

                      <div style={{ display: "grid", gap: 8 }}>
                        {accounts.map((acc) => {
                          const idx = acc.derivationIndex ?? 0;
                          return (
                            <div key={acc.id} style={{ display: "grid", gap: 8 }}>
                              <div className="aw-list-row">
                                <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, flex: "1 1 160px" }}>
                                  <AstroNavigatorAvatar
                                    seedKey={acc.address}
                                    kind={acc.kind}
                                    state="float"
                                    size={36}
                                  />
                                  <div style={{ minWidth: 0 }}>
                                    <div style={{ fontWeight: 700, fontSize: 13, overflowWrap: "anywhere" }}>{acc.label}</div>
                                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                      <code>
                                        {acc.address.slice(0, 10)}…{acc.address.slice(-8)}
                                      </code>
                                    </div>
                                  </div>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                                  <span className="glass-pill">m/44&apos;/148&apos;/{idx}&apos;</span>
                                  <button
                                    type="button"
                                    className="aw-mini-chip"
                                    onClick={() => {
                                      setRenamingIndex(idx);
                                      setRenameLabel(acc.label);
                                      setRenamePin("");
                                      setRenameError(null);
                                    }}
                                  >
                                    <IconEdit size={12} />
                                    <span>Rename</span>
                                  </button>
                                </div>
                              </div>

                              {renamingIndex === idx && (
                                <form
                                  onSubmit={(e) => void handleRenameSubmit(e)}
                                  className="aw-banner"
                                  style={{ display: "grid", gap: 8 }}
                                >
                                  <div className="aw-two-col-inputs">
                                    <input
                                      type="text"
                                      className="aw-input"
                                      placeholder="New Account Label"
                                      maxLength={32}
                                      value={renameLabel}
                                      onChange={(e) => setRenameLabel(e.target.value)}
                                    />
                                    <input
                                      type="password"
                                      className="aw-input"
                                      placeholder="Vault PIN"
                                      value={renamePin}
                                      onChange={(e) => setRenamePin(e.target.value)}
                                    />
                                  </div>
                                  {renameError && (
                                    <div style={{ fontSize: 12, color: "var(--aw-danger-crimson)" }}>
                                      {renameError}
                                    </div>
                                  )}
                                  <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                    <button
                                      type="submit"
                                      className="aw-btn-primary"
                                      disabled={
                                        renameBusy || !renameLabel.trim() || renamePin.length < 6
                                      }
                                    >
                                      {renameBusy ? "Saving..." : "Save Label"}
                                    </button>
                                    <button
                                      type="button"
                                      className="aw-btn-secondary"
                                      disabled={renameBusy}
                                      onClick={() => setRenamingIndex(null)}
                                    >
                                      Cancel
                                    </button>
                                  </div>
                                </form>
                              )}
                            </div>
                          );
                        })}
                      </div>

                      {/* Optional Fingerprint Convenience */}
                      <div className="aw-vault-divider">
                        <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                          <IconFingerprint size={16} />
                          <span>Optional Fingerprint Quick-Unlock (Zero FaceID Required)</span>
                        </div>
                        {!fingerprintSupported ? (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Platform biometric authenticator not detected in this browser. Your PIN
                            protects your vault universally.
                          </div>
                        ) : fingerprintEnrolled ? (
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                            <span style={{ fontSize: 12, color: "var(--aw-safe-emerald)" }}>
                              Fingerprint enrolled on this device
                            </span>
                            <button
                              type="button"
                              className="aw-chip-btn"
                              onClick={() => void disableFingerprint()}
                            >
                              Disable
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <input
                              type="password"
                              className="aw-input"
                              style={{ flex: "1 1 180px", minWidth: 0 }}
                              placeholder="Enter PIN to enroll Fingerprint"
                              value={fpPin}
                              onChange={(e) => setFpPin(e.target.value)}
                            />
                            <button
                              type="button"
                              className="aw-btn-secondary"
                              disabled={fpBusy || fpPin.length < 6}
                              onClick={() => void handleEnrollFingerprint()}
                            >
                              {fpBusy ? "Enrolling..." : "Enroll"}
                            </button>
                          </div>
                        )}
                        {fpStatusMsg && <div className="aw-banner">{fpStatusMsg}</div>}
                      </div>

                      {/* Reveal Recovery Seed & Export AGVAULT */}
                      <div className="aw-vault-divider">
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Seed Sovereignty &amp; Encrypted Backups
                        </div>
                        <div className="aw-two-col-inputs">
                          <button
                            type="button"
                            className="aw-btn-secondary"
                            onClick={() => setActiveDrawer("revealSeed")}
                          >
                            <IconEye size={15} />
                            <span>Reveal Recovery Phrase</span>
                          </button>
                          <button
                            type="button"
                            className="aw-btn-secondary"
                            onClick={() => void handleExportVault()}
                          >
                            <IconKey size={15} />
                            <span>Export .agvault Backup</span>
                          </button>
                        </div>
                        {exportError && (
                          <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
                            {exportError}
                          </div>
                        )}
                        {exportedVault && (
                          <div style={{ display: "grid", gap: 8 }}>
                            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="aw-chip-btn"
                                onClick={() => void handleCopyExportedVault()}
                              >
                                {copiedVaultExport ? <IconCheck size={13} /> : <IconCopy size={13} />}
                                <span>{copiedVaultExport ? "Copied JSON" : "Copy JSON"}</span>
                              </button>
                              <button
                                type="button"
                                className="aw-chip-btn"
                                onClick={handleDownloadExportedVault}
                              >
                                <IconKey size={13} />
                                <span>Download .agvault.json</span>
                              </button>
                              <button
                                type="button"
                                className="aw-chip-btn"
                                onClick={() => setExportedVault(null)}
                              >
                                Hide
                              </button>
                            </div>
                            <textarea
                              readOnly
                              className="aw-textarea"
                              rows={4}
                              value={exportedVault}
                            />
                          </div>
                        )}
                      </div>

                      {/* Telegram Zero-Knowledge Cloud Recovery Sync */}
                      <div className="aw-vault-divider">
                        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                          <div style={{ fontWeight: 700, fontSize: 13, display: "flex", alignItems: "center", gap: 6 }}>
                            <IconTelegram size={15} />
                            <span>Telegram Zero-Knowledge Recovery Sync</span>
                          </div>
                          <span
                            className={`glass-pill ${
                              hasEncryptedBackup ? "glass-pill--trust" : "glass-pill--gold"
                            }`}
                          >
                            {hasEncryptedBackup ? "✓ Synced to Telegram" : "Device-Only Vault"}
                          </span>
                        </div>

                        {hasEncryptedBackup ? (
                          <div style={{ display: "grid", gap: 8 }}>
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              Your encrypted <code>AGVAULT</code> ciphertext is linked to your
                              Telegram account so switching phones or clearing cache restores
                              smoothly with your Recovery Password.
                              {backupUpdatedAt
                                ? ` Last synced: ${new Date(backupUpdatedAt * 1000).toLocaleString()}.`
                                : ""}
                            </div>

                            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                              <button
                                type="button"
                                className="aw-btn-secondary"
                                disabled={cloudSyncBusy}
                                onClick={() => void handleReSyncCloudBackup()}
                              >
                                <IconRefresh size={14} />
                                <span>{cloudSyncBusy ? "Syncing..." : "Re-Sync Cloud Copy"}</span>
                              </button>

                              {!cloudDeleteArmed ? (
                                <button
                                  type="button"
                                  className="aw-chip-btn"
                                  disabled={cloudSyncBusy}
                                  onClick={() => setCloudDeleteArmed(true)}
                                >
                                  <IconTrash size={13} />
                                  <span>Remove Cloud Copy</span>
                                </button>
                              ) : (
                                <>
                                  <button
                                    type="button"
                                    className="aw-btn-danger"
                                    disabled={cloudSyncBusy}
                                    onClick={() => void handleDeleteCloudBackup()}
                                  >
                                    Confirm Delete Cloud Copy
                                  </button>
                                  <button
                                    type="button"
                                    className="aw-btn-secondary"
                                    onClick={() => setCloudDeleteArmed(false)}
                                  >
                                    Cancel
                                  </button>
                                </>
                              )}
                            </div>
                          </div>
                        ) : (
                          <div style={{ display: "grid", gap: 8 }}>
                            <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                              Currently stored only on this device. Protect with a ≥10 char Recovery
                              Password to sync an Argon2id ciphertext copy under your Telegram ID.
                            </div>
                            <button
                              type="button"
                              className="aw-btn-secondary"
                              style={{ width: "fit-content" }}
                              onClick={() => {
                                setCloudUpgradeOpen((v) => !v);
                                setCloudSyncError(null);
                              }}
                            >
                              <IconTelegram size={15} />
                              <span>
                                {cloudUpgradeOpen ? "Hide Sync Setup" : "Enable Telegram Encrypted Sync"}
                              </span>
                            </button>

                            {cloudUpgradeOpen && (
                              <form
                                onSubmit={(e) => void handleEnableCloudSyncSubmit(e)}
                                className="aw-banner"
                                style={{ display: "grid", gap: 8 }}
                              >
                                <input
                                  type="password"
                                  className="aw-input"
                                  autoComplete="current-password"
                                  placeholder="Current device PIN / password"
                                  value={cloudCurrentPin}
                                  onChange={(e) => setCloudCurrentPin(e.target.value)}
                                />
                                <div className="aw-two-col-inputs">
                                  <input
                                    type="password"
                                    className="aw-input"
                                    autoComplete="new-password"
                                    placeholder="New Recovery Password (min 10 chars)"
                                    value={cloudNewPassword}
                                    onChange={(e) => {
                                      setCloudNewPassword(e.target.value);
                                      setPendingSyncEnvelopeJson(null);
                                    }}
                                  />
                                  <input
                                    type="password"
                                    className="aw-input"
                                    autoComplete="new-password"
                                    placeholder="Confirm Recovery Password"
                                    value={cloudConfirmPassword}
                                    onChange={(e) => setCloudConfirmPassword(e.target.value)}
                                  />
                                </div>
                                {cloudNewPassword.length > 0 && !cloudPasswordStrength.acceptable && (
                                  <div style={{ fontSize: 11, color: "var(--aw-stellar-gold)" }}>
                                    {cloudPasswordStrength.reasons[0]}
                                  </div>
                                )}
                                {cloudConfirmPassword.length > 0 &&
                                  cloudNewPassword !== cloudConfirmPassword && (
                                    <div style={{ fontSize: 11, color: "var(--aw-stellar-gold)" }}>
                                      Recovery Password confirmation does not match yet.
                                    </div>
                                  )}
                                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                                  {pendingSyncEnvelopeJson ? (
                                    <button
                                      type="button"
                                      className="aw-btn-primary"
                                      disabled={cloudSyncBusy}
                                      onClick={() => void handleRetryPendingCloudUpload()}
                                    >
                                      <IconRefresh size={15} />
                                      <span>
                                        {cloudSyncBusy ? "Retrying Upload..." : "Retry Upload to Telegram"}
                                      </span>
                                    </button>
                                  ) : (
                                    <button
                                      type="submit"
                                      className="aw-btn-primary"
                                      disabled={
                                        cloudSyncBusy ||
                                        cloudCurrentPin.length < 6 ||
                                        !cloudPasswordStrength.acceptable ||
                                        cloudNewPassword !== cloudConfirmPassword
                                      }
                                    >
                                      <IconLock size={15} />
                                      <span>
                                        {cloudSyncBusy
                                          ? "Encrypting & Uploading..."
                                          : "Encrypt & Sync Now"}
                                      </span>
                                    </button>
                                  )}
                                </div>
                              </form>
                            )}
                          </div>
                        )}

                        {cloudSyncError && (
                          <div className="aw-banner aw-banner--danger" style={{ fontSize: 12 }}>
                            {cloudSyncError}
                          </div>
                        )}
                      </div>

                      {/* Paired Counterfactual Soroban Smart Account (C...) */}
                      <div className="aw-vault-divider">
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Counterfactual Soroban Smart Account (C...) &amp; Recovery Guardian
                        </div>
                        {pairedSmartAccount ? (
                          <div style={{ display: "grid", gap: 8 }}>
                            <div className="aw-list-row">
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>
                                  Smart Account (Guardian: {activeAccount.label})
                                </div>
                                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                  <code>
                                    {pairedSmartAccount.contractAddress.slice(0, 10)}…
                                    {pairedSmartAccount.contractAddress.slice(-8)}
                                  </code>
                                </div>
                              </div>
                              <span className="glass-pill glass-pill--gold">CAP-46 Counterfactual</span>
                            </div>
                            <div className="aw-banner aw-banner--warn" style={{ fontSize: 11 }}>
                              Counterfactual — Deploy on Soroban before sending funds. Sending
                              assets to an undeployed C... contract requires deploying with your
                              linked G... Guardian first.
                            </div>
                          </div>
                        ) : (
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Counterfactual <code>C...</code> Smart Account pairing is staged for an
                            upcoming release. Your Classic <code>G...</code> Guardian and TON vaults
                            are active on {config.network.toUpperCase()}.
                          </div>
                        )}
                      </div>
                    </section>

                    {/* Address Book / Contacts Manager */}
                    <section className="glass-card" style={{ display: "grid", gap: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>
                            Local Address Book ({contacts.length})
                          </div>
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Quick recipients saved encrypted-device locally in IndexedDB
                          </div>
                        </div>
                        <button
                          type="button"
                          className="aw-chip-btn"
                          onClick={() => setContactAdding((v) => !v)}
                        >
                          <IconUserPlus size={13} />
                          <span>{contactAdding ? "Cancel" : "Add Contact"}</span>
                        </button>
                      </div>

                      {contactAdding && (
                        <form onSubmit={(e) => void handleSaveContactSubmit(e)} style={{ display: "grid", gap: 8 }}>
                          <div className="aw-two-col-inputs">
                            <input
                              type="text"
                              className="aw-input"
                              placeholder="Contact Name"
                              maxLength={40}
                              value={newContactLabel}
                              onChange={(e) => setNewContactLabel(e.target.value)}
                            />
                            <input
                              type="text"
                              className="aw-input"
                              placeholder="Default Memo (Optional)"
                              maxLength={28}
                              value={newContactMemo}
                              onChange={(e) => setNewContactMemo(e.target.value)}
                            />
                          </div>
                          <input
                            type="text"
                            className="aw-input"
                            placeholder="G..., M..., or C... Stellar Address"
                            value={newContactAddr}
                            onChange={(e) => setNewContactAddr(e.target.value)}
                          />
                          {contactError && <div className="aw-banner aw-banner--danger">{contactError}</div>}
                          <button type="submit" className="aw-btn-primary">
                            Save Contact
                          </button>
                        </form>
                      )}

                      {contacts.length === 0 ? (
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                          No saved contacts yet. Add frequent Stellar recipients above or directly when
                          sending a payment.
                        </div>
                      ) : (
                        <div style={{ display: "grid", gap: 8 }}>
                          {contacts.map((c) => (
                            <div key={c.id} className="aw-list-row">
                              <div style={{ minWidth: 0, flex: "1 1 160px" }}>
                                <div style={{ fontWeight: 700, fontSize: 13, overflowWrap: "anywhere" }}>{c.label}</div>
                                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                  <code>
                                    {c.address.slice(0, 8)}…{c.address.slice(-6)}
                                  </code>
                                  {c.defaultMemo ? ` · Memo: ${c.defaultMemo}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                                <button
                                  type="button"
                                  className="aw-mini-chip"
                                  onClick={() =>
                                    openSendWith({
                                      destination: c.address,
                                      memo: c.defaultMemo,
                                    })
                                  }
                                >
                                  Send
                                </button>
                                <button
                                  type="button"
                                  className="aw-mini-chip"
                                  aria-label={`Delete ${c.label}`}
                                  onClick={() => void deleteContact(c.id)}
                                >
                                  <IconTrash size={12} />
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </section>

                    {/* TON Connect v2 Launcher Card */}
                    <section className="glass-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                          <IconPlug size={17} />
                          <span>TON Connect v2 ({tonConnectSessions.length} Active)</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                          {tonAccount
                            ? `TON Wallet ${tonAccount.friendlyAddress.slice(0, 6)}…${tonAccount.friendlyAddress.slice(-6)} · Encrypted NaCl bridge (§7.3)`
                            : "Connect Telegram Mini Apps & TON dApps cleanly via encrypted bridge"}
                        </div>
                      </div>
                      <button
                        type="button"
                        className="aw-btn-primary"
                        onClick={() => setActiveDrawer("tonConnect")}
                      >
                        <span>Open TON Connect</span>
                        <IconChevronRight size={16} />
                      </button>
                    </section>

                    {/* Developer Workbench Launcher Card */}
                    <section className="glass-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                          <IconCode size={17} />
                          <span>Developer Workbench (Dev Lab)</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                          Soroban RPC Telemetry, Contracts, Raw XDR Signer &amp; SEP-53 Tools
                        </div>
                      </div>
                      <button
                        type="button"
                        className="aw-btn-secondary"
                        onClick={() => setActiveDrawer("dev")}
                      >
                        <span>Open Dev Lab</span>
                        <IconChevronRight size={16} />
                      </button>
                    </section>

                    {/* Danger Zone: Local Vault Wipe */}
                    <section className="glass-card aw-danger-card" style={{ display: "grid", gap: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 14, color: "#FCA5A5" }}>
                        Danger Zone · Local Device Reset
                      </div>
                      <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                        Removes the local encrypted vault and biometric wrapping keys from this
                        device&apos;s IndexedDB (leaves any Telegram Encrypted Backup intact). Make
                        sure you backed up your 12/24-word recovery phrase or Recovery Password
                        first.
                      </div>
                      {!wipeConfirmArmed ? (
                        <button
                          type="button"
                          className="aw-chip-btn"
                          style={{ width: "fit-content", borderColor: "rgba(239, 68, 68, 0.5)", color: "#FCA5A5" }}
                          onClick={() => setWipeConfirmArmed(true)}
                        >
                          <IconTrash size={13} />
                          <span>Wipe Local Vault from Device</span>
                        </button>
                      ) : (
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="aw-btn-danger"
                            onClick={() => {
                              setWipeConfirmArmed(false);
                              void wipeLocalVault();
                            }}
                          >
                            Confirm Permanent Local Wipe
                          </button>
                          <button
                            type="button"
                            className="aw-btn-secondary"
                            onClick={() => setWipeConfirmArmed(false)}
                          >
                            Cancel
                          </button>
                        </div>
                      )}
                    </section>
                  </div>
                )}

              </>
            )}
          </div>
        </main>
      </div>

      {/* Bottom Floating Apple Liquid Glass Dock (Unlocked Wallet Only) */}
      {isWalletUnlocked && (
        <nav className="glass-dock" aria-label="Primary Mini App navigation">
          {MOBILE_DOCK_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              className="dock-btn"
              aria-current={activeTab === item.id ? "page" : undefined}
              onClick={() => selectTab(item.id)}
            >
              <span className="aw-dock-icon">{renderDockIcon(item.id)}</span>
              <span className="aw-dock-label">{item.label}</span>
            </button>
          ))}
        </nav>
      )}

      {/* Global Liquid Glass Toast Notification */}
      {toast && (
        <div
          className={`aw-toast aw-toast--${toast.kind}`}
          role="status"
          aria-live="polite"
        >
          <span>{toast.message}</span>
          <button
            type="button"
            className="aw-toast-close"
            aria-label="Dismiss notification"
            onClick={dismissToast}
          >
            <IconClose size={14} />
          </button>
        </div>
      )}

      {/* Unified Liquid Glass Modal Drawer */}
      <ModalDrawer
        open={activeDrawer !== null && currentDrawerMeta !== null}
        title={currentDrawerMeta?.title ?? ""}
        subtitle={currentDrawerMeta?.subtitle}
        onClose={() => setActiveDrawer(null)}
      >
        <Suspense
          fallback={
            <section className="glass-card" style={{ padding: 20, textAlign: "center" }}>
              Loading tool...
            </section>
          }
        >
          {activeDrawer === "send" && (
            <SendSheet
              embedded
              initialAssetCode={sendPrefill.assetCode}
              initialAssetIssuer={sendPrefill.assetIssuer}
              initialDestination={sendPrefill.destination}
              initialMemo={sendPrefill.memo}
              onClose={() => setActiveDrawer(null)}
            />
          )}
          {activeDrawer === "receive" && (
            <ReceiveSheet embedded onClose={() => setActiveDrawer(null)} />
          )}
          {activeDrawer === "swap" && (
            <SwapSheet
              initialFromAsset={swapFromPrefill}
              initialToAsset={swapToPrefill}
              onInspectToken={(target) => openTokenExplorer(target)}
            />
          )}
          {activeDrawer === "scan" && <ScanShieldSheet />}
          {activeDrawer === "tokens" && (
            <TokenExplorerSheet
              initialToken={selectedTokenTarget}
              onOpenSend={(prefill) => openSendWith(prefill)}
              onOpenSwap={({ assetId, mode }) =>
                openSwapWith(
                  mode === "from"
                    ? { fromAsset: assetId }
                    : { fromAsset: "XLM", toAsset: assetId },
                )
              }
            />
          )}
          {activeDrawer === "tools" && <ClassicToolsSheet />}
          {activeDrawer === "ramp" && <RampSheet />}
          {activeDrawer === "tonConnect" && <TonConnectSheet />}
          {activeDrawer === "dev" && <DevLabSheet />}
          {activeDrawer === "revealSeed" && (
            <RevealSeedModalContent onDone={() => setActiveDrawer(null)} />
          )}
        </Suspense>
      </ModalDrawer>

      {/* TON Connect v2 Transaction Approval Modal */}
      <ModalDrawer
        open={pendingTonConnectTx !== null}
        title="TON Connect Transaction Request"
        subtitle={
          pendingTonConnectTx
            ? `${pendingTonConnectTx.dappName} · ${pendingTonConnectTx.dappUrl}`
            : undefined
        }
        onClose={() => {
          if (!tcApproveBusy) {
            void resolvePendingTonConnectTx(false);
          }
        }}
      >
        {pendingTonConnectTx && (
          <div style={{ display: "grid", gap: 12 }}>
            <div className="aw-list-row">
              <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>TON Network</span>
              <span className="glass-pill glass-pill--trust">
                {config.tonNetwork.toUpperCase()}
              </span>
            </div>
            <div className="aw-list-row">
              <span style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>Valid Until</span>
              <code className="tabular-nums">
                {new Date(pendingTonConnectTx.validUntil * 1000).toLocaleTimeString()}
              </code>
            </div>
            <div style={{ display: "grid", gap: 8 }}>
              <span className="aw-label" style={{ marginBottom: 0 }}>
                Transfer Messages ({pendingTonConnectTx.messages.length})
              </span>
              {pendingTonConnectTx.messages.map((m, idx) => (
                <div key={`${m.address}-${idx}`} className="aw-list-row" style={{ flexWrap: "wrap" }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontWeight: 700, fontSize: 13 }} className="tabular-nums">
                      {formatNanoTonDisplay(m.amountNano)} TON
                    </div>
                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)", wordBreak: "break-all" }}>
                      To: <code>{m.address}</code>
                    </div>
                  </div>
                  {(m.payload || m.stateInit) && (
                    <span className="glass-pill glass-pill--gold">
                      {m.stateInit ? "StateInit + Payload" : "Payload Cell"}
                    </span>
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                type="button"
                className="aw-btn-secondary"
                style={{ flex: 1 }}
                disabled={tcApproveBusy}
                onClick={() => void resolvePendingTonConnectTx(false)}
              >
                Reject
              </button>
              <button
                type="button"
                className="aw-btn-primary"
                style={{ flex: 1 }}
                disabled={tcApproveBusy}
                onClick={() => void handleApproveTonConnectTx()}
              >
                <IconCheck size={14} />
                <span>{tcApproveBusy ? "Signing & Broadcasting..." : "Approve & Sign BOC"}</span>
              </button>
            </div>
          </div>
        )}
      </ModalDrawer>
    </div>
  );
}

function RoutedExperience({
  onSwitchNetwork,
  canSwitchNetwork,
}: {
  onSwitchNetwork?: ((next: StellarNetwork) => void) | undefined;
  canSwitchNetwork?: boolean | undefined;
}) {
  const { startParamRoute } = useTelegram();
  const [route, setRoute] = useState(() => readLocationRoute());
  const [requestedTab, setRequestedTab] = useState<AppDockTab>(
    () => readLocationRoute().tab ?? "wallet",
  );
  const [requestedDrawer, setRequestedDrawer] = useState<ActiveDrawer>(null);
  const [dismissedStartParamKey, setDismissedStartParamKey] = useState<string | null>(null);

  useEffect(() => {
    const handlePopState = () => {
      const next = readLocationRoute();
      setRoute(next);
      if (next.tab) {
        setRequestedTab(next.tab);
      }
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    if (startParamRoute?.kind !== "tab") return;
    const rawTab = startParamRoute.tab;
    if ((VALID_TABS as readonly string[]).includes(rawTab)) {
      setRequestedTab(rawTab as AppDockTab);
    } else if (rawTab === "dev") {
      setRequestedTab("accounts");
      setRequestedDrawer("dev");
    } else if (rawTab === "tonconnect") {
      setRequestedTab("ton");
      setRequestedDrawer("tonConnect");
    }
  }, [startParamRoute]);

  const startParamIntentKey =
    startParamRoute?.kind === "intent"
      ? `${startParamRoute.intentId}:${startParamRoute.sig}`
      : startParamRoute?.kind === "connect"
        ? `connect:${startParamRoute.requestId}:${startParamRoute.sig}`
        : null;

  const effectiveIntent: ActiveIntentRoute | null =
    route.intent ??
    (startParamRoute?.kind === "intent" && startParamIntentKey !== dismissedStartParamKey
      ? { intentId: startParamRoute.intentId, sig: startParamRoute.sig }
      : null);

  const effectiveConnect: ActiveConnectRoute | null =
    route.connect ??
    (startParamRoute?.kind === "connect" && startParamIntentKey !== dismissedStartParamKey
      ? { requestId: startParamRoute.requestId, sig: startParamRoute.sig }
      : null);

  const handleDismissIntent = useCallback(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/intent/")) {
      window.history.replaceState({}, "", "/app");
    }
    if (startParamIntentKey) {
      setDismissedStartParamKey(startParamIntentKey);
    }
    setRoute((prev) => ({ ...prev, intent: null }));
  }, [startParamIntentKey]);

  const handleDismissConnect = useCallback(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/connect/")) {
      window.history.replaceState({}, "", "/app");
    }
    if (startParamIntentKey) {
      setDismissedStartParamKey(startParamIntentKey);
    }
    setRoute((prev) => ({ ...prev, connect: null }));
  }, [startParamIntentKey]);

  const clearRequestedDrawer = useCallback(() => {
    setRequestedDrawer(null);
  }, []);

  return (
    <WalletShell
      initialTab={requestedTab}
      initialDrawer={requestedDrawer}
      onClearInitialDrawer={clearRequestedDrawer}
      intentRoute={effectiveIntent}
      onClearIntent={handleDismissIntent}
      connectRoute={effectiveConnect}
      onClearConnect={handleDismissConnect}
      onSwitchNetwork={onSwitchNetwork}
      canSwitchNetwork={canSwitchNetwork}
    />
  );
}

function MiniAppGate({
  config,
  onSwitchNetwork,
  canSwitchNetwork,
}: {
  config: PwaConfig;
  onSwitchNetwork?: ((next: StellarNetwork) => void) | undefined;
  canSwitchNetwork?: boolean | undefined;
}) {
  const { allowed, authStatus, authError, tgUser, refreshTelegramAuth } = useTelegram();

  if (!allowed) {
    return (
      <TelegramOnlyGate
        config={config}
        authStatus={authStatus}
        authError={authError}
        onRetry={() => void refreshTelegramAuth()}
      />
    );
  }

  return (
    <WalletProvider key={tgUser?.id ?? "dev"} storageScopeId={tgUser?.id} config={config}>
      <RoutedExperience
        onSwitchNetwork={onSwitchNetwork}
        canSwitchNetwork={canSwitchNetwork}
      />
    </WalletProvider>
  );
}

export function App() {
  const env = loadPwaEnv();
  const [selectedNetwork, setSelectedNetwork] = useState<StellarNetwork | null>(() => {
    if (typeof window === "undefined") return null;
    try {
      const saved = window.localStorage.getItem("aw_selected_network");
      return saved === "mainnet" || saved === "testnet" ? saved : null;
    } catch {
      return null;
    }
  });

  if (!env.ok) {
    return (
      <main className="glass-canvas">
        <div className="aw-shell">
          <section className="glass-sheet" aria-label="Environment configuration required">
            <div style={{ fontWeight: 700, marginBottom: 6, color: "var(--aw-stellar-gold)" }}>
              Zero-Hardcoding Config Check
            </div>
            <p style={{ margin: 0, fontSize: 13, color: "var(--aw-ink-secondary)" }}>
              Copy <code>apps/pwa/.env.example</code> to <code>apps/pwa/.env.local</code> and
              provide validated Stellar Testnet/Mainnet variables:
            </p>
            <pre
              style={{
                marginTop: 10,
                marginBottom: 0,
                padding: 10,
                borderRadius: 12,
                background: "rgba(11, 20, 51, 0.75)",
                fontSize: 11,
                overflowX: "auto",
                color: "var(--aw-nebula-lavender)",
              }}
            >
              {env.error}
            </pre>
          </section>
        </div>
      </main>
    );
  }

  const effectiveConfig = selectedNetwork
    ? applyPwaNetworkProfile(env.config, selectedNetwork)
    : env.config;

  const handleSwitchNetwork = (next: StellarNetwork) => {
    setSelectedNetwork(next);
    if (typeof window !== "undefined") {
      try {
        window.localStorage.setItem("aw_selected_network", next);
      } catch {
        // Ignore storage quota errors
      }
    }
  };

  return (
    <TelegramProvider config={effectiveConfig}>
      <MiniAppGate
        config={effectiveConfig}
        onSwitchNetwork={handleSwitchNetwork}
        canSwitchNetwork={Boolean(env.config.altNetworkProfile)}
      />
    </TelegramProvider>
  );
}
