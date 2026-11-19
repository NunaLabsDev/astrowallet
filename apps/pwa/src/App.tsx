import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { StellarAddressSchema } from "@astrowallet/domain";
import { deriveCounterfactualSmartAccount } from "@astrowallet/stellar-core";
import { AccountSwitcher } from "./components/AccountSwitcher.js";
import { AstroNavigatorAvatar } from "./components/AstroNavigatorAvatar.js";
import { AstroWalletLogo } from "./components/AstroWalletLogo.js";
import { ClassicToolsSheet } from "./components/ClassicToolsSheet.js";
import { CollectiblesSheet } from "./components/CollectiblesSheet.js";
import { DappConnectSheet } from "./components/DappConnectSheet.js";
import { DevLabSheet } from "./components/DevLabSheet.js";
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
  IconExternalLink,
  IconEye,
  IconFingerprint,
  IconGlobe,
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
import { LandingPage, type AppDockTab } from "./components/LandingPage.js";
import { ModalDrawer } from "./components/ModalDrawer.js";
import { OnboardingSheet } from "./components/OnboardingSheet.js";
import { RampSheet } from "./components/RampSheet.js";
import { ReceiveSheet } from "./components/ReceiveSheet.js";
import { ScanShieldSheet } from "./components/ScanShieldSheet.js";
import { SendSheet } from "./components/SendSheet.js";
import { SwapSheet } from "./components/SwapSheet.js";
import { UnlockSheet } from "./components/UnlockSheet.js";
import { loadPwaEnv } from "./config/env.js";
import { WalletProvider, useWallet } from "./state/wallet-context.js";

type ActiveDrawer =
  | "send"
  | "receive"
  | "swap"
  | "scan"
  | "tools"
  | "ramp"
  | "dapp"
  | "revealSeed"
  | null;

type RouteView = "landing" | "app";
type ActivityFilter = "all" | "received" | "sent";

interface SendPrefill {
  assetCode?: string | undefined;
  assetIssuer?: string | undefined;
  destination?: string | undefined;
}

const VALID_TABS: readonly AppDockTab[] = [
  "wallet",
  "nfts",
  "activity",
  "dev",
  "accounts",
  "telegram",
];

function parseTabFromSearch(search: string): AppDockTab | null {
  const raw = new URLSearchParams(search).get("tab");
  if (raw && (VALID_TABS as readonly string[]).includes(raw)) {
    return raw as AppDockTab;
  }
  return null;
}

function readLocationRoute(): {
  view: RouteView;
  tab: AppDockTab | null;
  intent: ActiveIntentRoute | null;
} {
  if (typeof window === "undefined") {
    return { view: "landing", tab: null, intent: null };
  }
  const intent = parseIntentRouteFromLocation();
  if (intent) {
    return { view: "app", tab: "wallet", intent };
  }
  if (window.location.pathname.startsWith("/app")) {
    return {
      view: "app",
      tab: parseTabFromSearch(window.location.search),
      intent: null,
    };
  }
  return { view: "landing", tab: null, intent: null };
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
        title: "USDC Bridge & On/Off Ramps",
        subtitle: "Circle CCTP (6↔7 decimals guard), MoonPay & Transak",
      };
    case "dapp":
      return {
        title: "Connect dApp",
        subtitle: "WalletConnect v2 / Reown & SEP-43 Provider",
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
    case "nfts":
      return <IconNft size={19} />;
    case "activity":
      return <IconActivity size={19} />;
    case "dev":
      return <IconCode size={19} />;
    case "accounts":
      return <IconAccounts size={19} />;
    case "telegram":
      return <IconTelegram size={19} />;
  }
}

const SIDEBAR_ITEMS: ReadonlyArray<{ id: AppDockTab; label: string }> = [
  { id: "wallet", label: "Wallet" },
  { id: "nfts", label: "NFTs" },
  { id: "activity", label: "Activity" },
  { id: "dev", label: "Dev Lab" },
  { id: "accounts", label: "Vault" },
  { id: "telegram", label: "Telegram" },
];

const MOBILE_DOCK_ITEMS: ReadonlyArray<{ id: AppDockTab; label: string }> = [
  { id: "wallet", label: "Wallet" },
  { id: "nfts", label: "NFTs" },
  { id: "activity", label: "Activity" },
  { id: "dev", label: "Dev Lab" },
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
        <button type="submit" className="aw-btn-primary" disabled={busy || pin.length < 4}>
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
  intentRoute,
  onClearIntent,
  onNavigateLanding,
}: {
  initialTab: AppDockTab;
  intentRoute: ActiveIntentRoute | null;
  onClearIntent: () => void;
  onNavigateLanding: () => void;
}) {
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
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
  const [sendPrefill, setSendPrefill] = useState<SendPrefill>({});
  const [swapFromPrefill, setSwapFromPrefill] = useState<string | undefined>(undefined);

  const [copiedAddr, setCopiedAddr] = useState(false);
  const [copiedTxId, setCopiedTxId] = useState<string | null>(null);
  const [activityFilter, setActivityFilter] = useState<ActivityFilter>("all");
  const [actionBusy, setActionBusy] = useState(false);

  // Vault controls state
  const [fpPin, setFpPin] = useState("");
  const [fpStatusMsg, setFpStatusMsg] = useState<string | null>(null);
  const [exportedVault, setExportedVault] = useState<string | null>(null);

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

  const [webPushStatus, setWebPushStatus] = useState<string>(() => {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  });

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  const selectTab = useCallback((tab: AppDockTab) => {
    setActiveTab(tab);
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/app")) {
      const targetUrl = tab === "wallet" ? "/app" : `/app?tab=${tab}`;
      window.history.replaceState({}, "", targetUrl);
    }
  }, []);

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
    } catch (err) {
      setFpStatusMsg(err instanceof Error ? err.message : "Export failed");
    }
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

  const handleToggleDeclarativePush = async () => {
    if (typeof Notification === "undefined") {
      setWebPushStatus("unsupported");
      return;
    }
    try {
      const perm = await Notification.requestPermission();
      setWebPushStatus(perm);
    } catch {
      setWebPushStatus("denied");
    }
  };

  const currentDrawerMeta = activeDrawer
    ? drawerMetadata(activeDrawer, config.network)
    : null;

  return (
    <div className="aw-app-canvas">
      <div className="aw-app-frame">
        {/* Desktop Persistent Left Glass Sidebar */}
        <aside className="aw-sidebar" aria-label="Desktop workspace navigation">
          <div className="aw-sidebar-top">
            <button
              type="button"
              className="aw-sidebar-brand"
              onClick={onNavigateLanding}
              title="Back to AstroWallet Website"
            >
              <AstroWalletLogo size={36} />
              <div style={{ textAlign: "left" }}>
                <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                  AstroWallet
                </div>
                <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                  Stellar &amp; Soroban Vault
                </div>
              </div>
            </button>

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 12 }}>
              <span
                className={
                  config.network === "testnet"
                    ? "glass-pill glass-pill--gold"
                    : "glass-pill glass-pill--trust"
                }
              >
                {config.network.toUpperCase()}
              </span>
              <span className="glass-pill glass-pill--trust">0 Server Keys</span>
            </div>
          </div>

          <nav className="aw-sidebar-nav" aria-label="App sections">
            {SIDEBAR_ITEMS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="aw-sidebar-btn"
                aria-current={activeTab === item.id ? "page" : undefined}
                onClick={() => selectTab(item.id)}
              >
                {renderDockIcon(item.id)}
                <span>{item.label}</span>
              </button>
            ))}
          </nav>

          <div className="aw-sidebar-foot">
            <div className="aw-sidebar-posture">
              <span className="aw-trust-dot" />
              <span>SEP-0005 · Argon2id Local</span>
            </div>

            {vaultStatus === "unlocked" && (
              <button
                type="button"
                className="aw-btn-secondary"
                style={{ width: "100%", justifyContent: "center" }}
                onClick={lockVault}
              >
                <IconLock size={15} />
                <span>Lock Vault</span>
              </button>
            )}

            <button
              type="button"
              className="aw-chip-btn"
              style={{ width: "100%", justifyContent: "center" }}
              onClick={onNavigateLanding}
            >
              <IconGlobe size={14} />
              <span>Back to Website</span>
            </button>
          </div>
        </aside>

        {/* Main Workspace Stage */}
        <main className="aw-app-main">
          <div className="aw-main-inner">
            {/* Mobile Compact Header */}
            <header className="aw-mobile-header">
              <button
                type="button"
                className="aw-sidebar-brand"
                onClick={onNavigateLanding}
                title="Back to AstroWallet Website"
              >
                <AstroWalletLogo size={34} />
                <div style={{ textAlign: "left" }}>
                  <div style={{ fontSize: 16, fontWeight: 700, letterSpacing: "-0.02em" }}>
                    AstroWallet
                  </div>
                  <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                    Non-Custodial Stellar Vault
                  </div>
                </div>
              </button>

              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button
                  type="button"
                  className="aw-chip-btn"
                  aria-label="Open Telegram Bot Tab"
                  onClick={() => selectTab("telegram")}
                >
                  <IconTelegram size={14} />
                </button>
                <span
                  className={
                    config.network === "testnet"
                      ? "glass-pill glass-pill--gold"
                      : "glass-pill glass-pill--trust"
                  }
                >
                  {config.network.toUpperCase()}
                </span>
                {vaultStatus === "unlocked" && (
                  <button type="button" className="aw-chip-btn" onClick={lockVault}>
                    <IconLock size={13} />
                    <span>Lock</span>
                  </button>
                )}
              </div>
            </header>

            {/* Banking-Trust Custody Posture Strip */}
            <div className="aw-trust-strip" role="status" aria-label="Security posture">
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span className="aw-trust-dot" />
                <span>
                  <strong>Self-Custodial SEP-0005</strong> · Argon2id IndexedDB · Scan &amp; Shield
                  Active
                </span>
              </div>
              <span className="glass-pill glass-pill--trust">0 Server Keys</span>
            </div>

            <IosBrowserGuard
              isIntentRoute={intentRoute !== null}
              uninitialized={vaultStatus === "uninitialized"}
            />

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
                <OnboardingSheet />
              </div>
            )}

            {vaultStatus === "locked" && (
              <div className="aw-center-stage">
                <UnlockSheet onExploreSite={onNavigateLanding} />
              </div>
            )}

            {vaultStatus === "unlocked" && activeAccount && (
              <>
                <AccountSwitcher />

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
                            <div className="aw-tool-title">Bridge &amp; Ramps</div>
                            <div className="aw-tool-sub">Circle CCTP &amp; Fiat</div>
                          </button>
                        </div>

                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          <button
                            type="button"
                            className="aw-chip-btn"
                            style={{ flex: 1 }}
                            onClick={() => selectTab("dev")}
                          >
                            <IconCode size={13} />
                            <span>Open Dev Lab</span>
                          </button>
                          <button
                            type="button"
                            className="aw-chip-btn"
                            style={{ flex: 1 }}
                            onClick={() => selectTab("telegram")}
                          >
                            <IconTelegram size={13} />
                            <span>Telegram Bot</span>
                          </button>
                        </div>
                      </section>
                    </div>
                  </div>
                )}

                {activeTab === "nfts" && <CollectiblesSheet />}

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

                {activeTab === "dev" && <DevLabSheet />}

                {activeTab === "accounts" && (
                  <div style={{ display: "grid", gap: 14 }}>
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
                          <textarea
                            readOnly
                            className="aw-textarea"
                            rows={4}
                            value={exportedVault}
                          />
                        )}
                      </div>

                      {/* Paired Counterfactual Soroban Smart Account (C...) */}
                      <div className="aw-vault-divider">
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          Counterfactual Soroban Smart Account (C...) &amp; Recovery Guardian
                        </div>
                        {pairedSmartAccount ? (
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
                            <span className="glass-pill glass-pill--gold">Gasless C...</span>
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

                    {/* dApp Connection Launcher Card */}
                    <section className="glass-card" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15, display: "flex", alignItems: "center", gap: 8 }}>
                          <IconPlug size={17} />
                          <span>Connect dApp (WalletConnect v2 / SEP-43)</span>
                        </div>
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                          Sign Reown requests or test injected window.stellar SEP-43 methods
                        </div>
                      </div>
                      <button
                        type="button"
                        className="aw-btn-primary"
                        onClick={() => setActiveDrawer("dapp")}
                      >
                        <span>Open dApp Signer</span>
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

                {activeTab === "telegram" && (
                  <section className="glass-card" style={{ display: "grid", gap: 14 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
                      <div className="aw-pixel-frame">
                        <AstroNavigatorAvatar
                          seedKey={activeAccount.address}
                          kind="classic"
                          state="comms"
                          size={58}
                        />
                      </div>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 16 }}>
                          Telegram Super-Bot (@{config.tgBotUsername})
                        </div>
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                          Non-custodial social payments, live card edits &amp; real-time alerts
                        </div>
                      </div>
                    </div>

                    <div className="aw-tg-steps">
                      <div className="aw-seal-row">
                        <span>1. Link 1 or all {accounts.length} SEP-0005 accounts</span>
                        <code>/connect</code>
                      </div>
                      <div className="aw-seal-row">
                        <span>2. Sign short-lived Intent URLs (HMAC ≤ 5 min)</span>
                        <code>/pay 10 XLM @friend</code>
                      </div>
                      <div className="aw-seal-row">
                        <span>3. Inline mode inside any Telegram chat</span>
                        <code>@{config.tgBotUsername} pay 10 XLM @friend</code>
                      </div>
                    </div>

                    <a
                      href={`https://t.me/${config.tgBotUsername}`}
                      target="_blank"
                      rel="noreferrer"
                      className="aw-btn-primary"
                    >
                      <IconTelegram size={17} />
                      <span>Open @{config.tgBotUsername} in Telegram</span>
                      <IconExternalLink size={14} />
                    </a>

                    <div className="aw-list-row">
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 13 }}>
                          iOS 18.4+ Declarative Web Push
                        </div>
                        <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                          Optional browser alerts alongside Goldsky / Mercury Telegram push (status:{" "}
                          <code>{webPushStatus}</code>)
                        </div>
                      </div>
                      <button
                        type="button"
                        className="aw-chip-btn"
                        disabled={webPushStatus === "granted" || webPushStatus === "unsupported"}
                        onClick={() => void handleToggleDeclarativePush()}
                      >
                        {webPushStatus === "granted"
                          ? "Enabled"
                          : webPushStatus === "unsupported"
                            ? "Unavailable"
                            : "Enable Push"}
                      </button>
                    </div>
                  </section>
                )}
              </>
            )}
          </div>
        </main>
      </div>

      {/* Bottom Floating Apple Liquid Glass Dock (Mobile) */}
      <nav className="glass-dock" aria-label="Primary mobile navigation">
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
        {activeDrawer === "dapp" && <DappConnectSheet />}
        {activeDrawer === "revealSeed" && (
          <RevealSeedModalContent onDone={() => setActiveDrawer(null)} />
        )}
      </ModalDrawer>
    </div>
  );
}

function RoutedExperience() {
  const [route, setRoute] = useState(() => readLocationRoute());
  const [requestedTab, setRequestedTab] = useState<AppDockTab>(
    () => readLocationRoute().tab ?? "wallet",
  );

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

  const navigateToApp = useCallback((tab: AppDockTab = "wallet") => {
    setRequestedTab(tab);
    const targetUrl = tab === "wallet" ? "/app" : `/app?tab=${tab}`;
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", targetUrl);
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    setRoute({ view: "app", tab, intent: null });
  }, []);

  const navigateToLanding = useCallback(() => {
    if (typeof window !== "undefined") {
      window.history.pushState({}, "", "/");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    setRoute({ view: "landing", tab: null, intent: null });
  }, []);

  const handleDismissIntent = useCallback(() => {
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/intent/")) {
      window.history.replaceState({}, "", "/app");
    }
    setRoute((prev) => ({ ...prev, view: "app", intent: null }));
  }, []);

  if (route.view === "landing" && !route.intent) {
    return <LandingPage onLaunchApp={navigateToApp} />;
  }

  return (
    <WalletShell
      initialTab={requestedTab}
      intentRoute={route.intent}
      onClearIntent={handleDismissIntent}
      onNavigateLanding={navigateToLanding}
    />
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
    <WalletProvider config={env.config}>
      <RoutedExperience />
    </WalletProvider>
  );
}
