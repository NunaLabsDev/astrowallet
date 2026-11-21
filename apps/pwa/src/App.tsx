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
import { StellarAddressSchema, type PwaConfig } from "@astrowallet/domain";
import { deriveCounterfactualSmartAccount } from "@astrowallet/stellar-core";
import { formatNanoTon } from "@astrowallet/ton-core";
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
import {
  IntentSheet,
  parseIntentRouteFromLocation,
  type ActiveIntentRoute,
} from "./components/IntentSheet.js";
import { IosBrowserGuard } from "./components/IosBrowserGuard.js";
import { ModalDrawer } from "./components/ModalDrawer.js";
import { OnboardingSheet } from "./components/OnboardingSheet.js";
import { formatSeedBackupFilename } from "./components/onboarding-helpers.js";
import { UnlockSheet } from "./components/UnlockSheet.js";
import { loadPwaEnv } from "./config/env.js";
import { TelegramProvider, useTelegram } from "./state/telegram-context.js";
import { WalletProvider, useWallet } from "./state/wallet-context.js";
import {
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

export type AppDockTab = "wallet" | "ton" | "activity" | "nfts" | "accounts";

type ActiveDrawer =
  | "send"
  | "receive"
  | "swap"
  | "scan"
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
} {
  if (typeof window === "undefined") {
    return { tab: null, intent: null };
  }
  const intent = parseIntentRouteFromLocation();
  if (intent) {
    return { tab: "wallet", intent };
  }
  return {
    tab: parseTabFromSearch(window.location.search),
    intent: null,
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
  { id: "wallet", label: "Stellar" },
  { id: "ton", label: "TON" },
  { id: "activity", label: "Activity" },
  { id: "nfts", label: "NFTs" },
  { id: "accounts", label: "Vault" },
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
    try {
      await navigator.clipboard.writeText(revealed);
      showToast("Recovery phrase copied — clear clipboard after storing", "info");
    } catch {
      // Clipboard unavailable
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
}: {
  initialTab: AppDockTab;
  initialDrawer?: ActiveDrawer;
  onClearInitialDrawer?: () => void;
  intentRoute: ActiveIntentRoute | null;
  onClearIntent: () => void;
}) {
  const { tgUser, sessionToken, linkedAccounts, refreshLinkedAccounts } = useTelegram();
  const {
    config,
    vaultStatus,
    accounts,
    activeAccount,
    accountState,
    recentPayments,
    claimableBalances,
    contacts,
    toast,
    dismissToast,
    loadingChain,
    chainError,
    fingerprintSupported,
    fingerprintEnrolled,
    tonAccount,
    tonConnectSessions,
    pendingTonConnectTx,
    resolvePendingTonConnectTx,
    signConnectChallenge,
    enableFingerprint,
    disableFingerprint,
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
  const [fpStatusMsg, setFpStatusMsg] = useState<string | null>(null);
  const [exportedVault, setExportedVault] = useState<string | null>(null);
  const [copiedVaultExport, setCopiedVaultExport] = useState(false);

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
      setActiveDrawer(null);
    }
  }, [vaultStatus]);

  const [renamingIndex, setRenamingIndex] = useState<number | null>(null);
  const [renameLabel, setRenameLabel] = useState("");
  const [renamePin, setRenamePin] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);

  const [contactAdding, setContactAdding] = useState(false);
  const [newContactLabel, setNewContactLabel] = useState("");
  const [newContactAddr, setNewContactAddr] = useState("");
  const [newContactMemo, setNewContactMemo] = useState("");
  const [contactError, setContactError] = useState<string | null>(null);

  const [wipeConfirmArmed, setWipeConfirmArmed] = useState(false);

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

  const openSwapWith = (fromAsset?: string) => {
    setSwapFromPrefill(fromAsset);
    setActiveDrawer("swap");
  };

  const handleCopyAddress = async () => {
    if (!activeAccount) return;
    try {
      await navigator.clipboard.writeText(activeAccount.address);
      setCopiedAddr(true);
      setTimeout(() => setCopiedAddr(false), 1800);
    } catch {
      // Clipboard unavailable
    }
  };

  const handleCopyTxHash = async (txHash: string) => {
    try {
      await navigator.clipboard.writeText(txHash);
      setCopiedTxId(txHash);
      setTimeout(() => setCopiedTxId(null), 1600);
    } catch {
      // Clipboard unavailable
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
    if (!fpPin) return;
    setFpStatusMsg(null);
    try {
      const res = await enableFingerprint(fpPin);
      setFpStatusMsg(res.message);
      setFpPin("");
    } catch (err) {
      setFpStatusMsg(err instanceof Error ? err.message : "Failed to enroll Fingerprint");
    }
  };

  const handleExportVault = async () => {
    try {
      const json = await exportAgVaultJson();
      setExportedVault(json);
      setCopiedVaultExport(false);
    } catch (err) {
      setFpStatusMsg(err instanceof Error ? err.message : "Export failed");
    }
  };

  const handleCopyExportedVault = async () => {
    if (!exportedVault) return;
    try {
      await navigator.clipboard.writeText(exportedVault);
      setCopiedVaultExport(true);
      triggerTelegramHaptic("selection");
      showToast("Encrypted .agvault JSON copied");
      setTimeout(() => setCopiedVaultExport(false), 1800);
    } catch {
      // Clipboard unavailable
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
    if (renamingIndex === null) return;
    setRenameError(null);
    try {
      await renameDerivedAccount(renamingIndex, renameLabel, renamePin);
      setRenamingIndex(null);
      setRenameLabel("");
      setRenamePin("");
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : "Rename failed");
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

  const handleSyncWalletWithTelegram = async () => {
    if (!sessionToken || accounts.length === 0) return;
    setTgSyncBusy(true);
    setTgSyncError(null);
    try {
      const base = config.apiBaseUrl.replace(/\/+$/, "");
      const chRes = await fetch(`${base}/v1/tg/link-challenge`, {
        method: "POST",
        headers: { Authorization: `Bearer ${sessionToken}` },
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
        accounts.map((a) => a.derivationIndex ?? 0),
        Boolean(config.smartAccountWasmHash),
      );
      const cfRes = await fetch(`${base}/v1/tg/link-confirm`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${sessionToken}`,
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
      await refreshLinkedAccounts();
      triggerTelegramHaptic("success");
      showToast(
        `Synced ${cfData.linkedCount ?? proofs.length} address(es) with @${config.tgBotUsername}`,
      );
    } catch (err) {
      triggerTelegramHaptic("error");
      setTgSyncError(
        err instanceof Error ? err.message : "Failed to sync wallet with Telegram",
      );
    } finally {
      setTgSyncBusy(false);
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
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                    AstroWallet
                  </div>
                  <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                    {tgUser?.username ? `@${tgUser.username} · Stellar & TON` : "Stellar & TON Mini App"}
                  </div>
                </div>
              </button>

              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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
                <span
                  className={
                    config.network === "testnet"
                      ? "glass-pill glass-pill--gold"
                      : "glass-pill glass-pill--trust"
                  }
                >
                  {config.network.toUpperCase()}
                </span>
                {isWalletUnlocked && (
                  <button type="button" className="aw-chip-btn" onClick={lockVault}>
                    <IconLock size={13} />
                    <span>Lock</span>
                  </button>
                )}
              </div>
            </header>

            {/* Banking-Trust Custody Posture Strip */}
            {isWalletUnlocked && (
              <div className="aw-trust-strip" role="status" aria-label="Security posture">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span className="aw-trust-dot" />
                  <span>
                    <strong>Self-Custodial Stellar &amp; TON</strong> · Argon2id IndexedDB · Scan &amp;
                    Shield Active
                  </span>
                </div>
                <span className="glass-pill glass-pill--trust">0 Server Keys</span>
              </div>
            )}

            {intentRoute !== null && vaultStatus === "uninitialized" && (
              <IosBrowserGuard
                isIntentRoute={intentRoute !== null}
                uninitialized={vaultStatus === "uninitialized"}
              />
            )}

            {intentRoute && (
              <IntentSheet route={intentRoute} onDismiss={onClearIntent} />
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
                            <span className="glass-pill">
                              m/44&apos;/148&apos;/{activeAccount.derivationIndex ?? 0}&apos;
                            </span>
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
                          <span className="aw-action-label">Scan &amp; Shield</span>
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
                          <div style={{ display: "flex", gap: 6 }}>
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
                            {accountState.balances.map((b) => (
                              <div
                                key={`${b.assetCode}:${b.assetIssuer ?? "native"}`}
                                className="aw-list-row"
                              >
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <span className="aw-asset-badge">
                                    {b.assetCode.slice(0, 3)}
                                  </span>
                                  <div>
                                    <div style={{ fontWeight: 700, fontSize: 14 }}>{b.assetCode}</div>
                                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                      {b.assetIssuer
                                        ? `${b.assetIssuer.slice(0, 6)}…${b.assetIssuer.slice(-4)}`
                                        : "Native Stellar Lumen"}
                                    </div>
                                  </div>
                                </div>

                                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <div style={{ textAlign: "right" }}>
                                    <div className="tabular-nums" style={{ fontWeight: 700, fontSize: 14 }}>
                                      {Number(b.balance).toFixed(4)}
                                    </div>
                                    <div style={{ display: "flex", gap: 4, justifyContent: "flex-end", marginTop: 4 }}>
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
                                </div>
                              </div>
                            ))}
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
                      </section>

                      {/* Right: Stellar Suite Tools 2x2 Launcher + Dev/Telegram Shortcuts */}
                      <section className="glass-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>Stellar Suite &amp; Tools</div>
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Execute swaps, security scans, SDEX offers &amp; bridges
                          </div>
                        </div>

                        <div className="aw-tool-grid">
                          <button
                            type="button"
                            className="aw-tool-card"
                            onClick={() => openSwapWith()}
                          >
                            <div className="aw-tool-card-top">
                              <span className="aw-tool-icon aw-tool-icon--purple">
                                <IconSwap size={18} />
                              </span>
                              <IconChevronRight size={16} />
                            </div>
                            <div className="aw-tool-title">Swap &amp; Path Router</div>
                            <div className="aw-tool-sub">Soroswap + Horizon Path</div>
                          </button>

                          <button
                            type="button"
                            className="aw-tool-card"
                            onClick={() => setActiveDrawer("scan")}
                          >
                            <div className="aw-tool-card-top">
                              <span className="aw-tool-icon aw-tool-icon--emerald">
                                <IconShield size={18} />
                              </span>
                              <IconChevronRight size={16} />
                            </div>
                            <div className="aw-tool-title">Scan &amp; Shield</div>
                            <div className="aw-tool-sub">Pre-sign XDR firewall</div>
                          </button>

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
                            <div className="aw-tool-title">CCTP Precision</div>
                            <div className="aw-tool-sub">Circle CCTP 6&harr;7 Guard</div>
                          </button>
                        </div>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="aw-chip-btn"
                            style={{ flex: 1 }}
                            onClick={() => setActiveDrawer("dev")}
                          >
                            <IconCode size={13} />
                            <span>Open Dev Lab</span>
                          </button>
                          <button
                            type="button"
                            className="aw-chip-btn"
                            style={{ flex: 1 }}
                            onClick={() => setActiveDrawer("tonConnect")}
                          >
                            <IconPlug size={13} />
                            <span>TON Connect</span>
                          </button>
                        </div>
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
                    <TonWalletSheet />
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

                            <div style={{ display: "grid", justifyItems: "end", gap: 4 }}>
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
                              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
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

                        <button
                          type="button"
                          className="aw-btn-primary"
                          disabled={tgSyncBusy || !sessionToken || accounts.length === 0}
                          onClick={() => void handleSyncWalletWithTelegram()}
                        >
                          <IconTelegram size={15} />
                          <span>{tgSyncBusy ? "Signing & Syncing..." : "Sync Wallet with Telegram"}</span>
                        </button>
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
                                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                                  <AstroNavigatorAvatar
                                    seedKey={acc.address}
                                    kind={acc.kind}
                                    state="float"
                                    size={36}
                                  />
                                  <div>
                                    <div style={{ fontWeight: 700, fontSize: 13 }}>{acc.label}</div>
                                    <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                      <code>
                                        {acc.address.slice(0, 10)}…{acc.address.slice(-8)}
                                      </code>
                                    </div>
                                  </div>
                                </div>
                                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
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
                                  <div style={{ display: "flex", gap: 8 }}>
                                    <button type="submit" className="aw-btn-primary">
                                      Save Label
                                    </button>
                                    <button
                                      type="button"
                                      className="aw-btn-secondary"
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
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
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
                          <div style={{ display: "flex", gap: 8 }}>
                            <input
                              type="password"
                              className="aw-input"
                              placeholder="Enter PIN to enroll Fingerprint"
                              value={fpPin}
                              onChange={(e) => setFpPin(e.target.value)}
                            />
                            <button
                              type="button"
                              className="aw-btn-secondary"
                              onClick={() => void handleEnrollFingerprint()}
                            >
                              Enroll
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
                            Set <code>VITE_SMART_ACCOUNT_WASM_HASH</code> to enable counterfactual{" "}
                            <code>C...</code> Smart Account pairing with your <code>G...</code>{" "}
                            Recovery Guardian.
                          </div>
                        )}
                      </div>
                    </section>

                    {/* Address Book / Contacts Manager */}
                    <section className="glass-card" style={{ display: "grid", gap: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
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
                              <div>
                                <div style={{ fontWeight: 700, fontSize: 13 }}>{c.label}</div>
                                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                                  <code>
                                    {c.address.slice(0, 8)}…{c.address.slice(-6)}
                                  </code>
                                  {c.defaultMemo ? ` · Memo: ${c.defaultMemo}` : ""}
                                </div>
                              </div>
                              <div style={{ display: "flex", gap: 6 }}>
                                <button
                                  type="button"
                                  className="aw-mini-chip"
                                  onClick={() => openSendWith({ destination: c.address })}
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
                        Removes encrypted vault and biometric wrapping keys from this browser&apos;s
                        IndexedDB. Make sure you backed up your 12-word recovery phrase first.
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
              onClose={() => setActiveDrawer(null)}
            />
          )}
          {activeDrawer === "receive" && (
            <ReceiveSheet embedded onClose={() => setActiveDrawer(null)} />
          )}
          {activeDrawer === "swap" && <SwapSheet initialFromAsset={swapFromPrefill} />}
          {activeDrawer === "scan" && <ScanShieldSheet />}
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
                      {formatNanoTon(m.amountNano)} TON
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

function RoutedExperience() {
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
      : null;

  const effectiveIntent: ActiveIntentRoute | null =
    route.intent ??
    (startParamRoute?.kind === "intent" && startParamIntentKey !== dismissedStartParamKey
      ? { intentId: startParamRoute.intentId, sig: startParamRoute.sig }
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
    />
  );
}

function MiniAppGate({ config }: { config: PwaConfig }) {
  const { allowed, authStatus, authError, refreshTelegramAuth } = useTelegram();

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
    <WalletProvider config={config}>
      <RoutedExperience />
    </WalletProvider>
  );
}

export function App() {
  const env = loadPwaEnv();

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

  return (
    <TelegramProvider config={env.config}>
      <MiniAppGate config={env.config} />
    </TelegramProvider>
  );
}
