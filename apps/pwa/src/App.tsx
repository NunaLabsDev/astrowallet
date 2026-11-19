import { useCallback, useEffect, useMemo, useState } from "react";
import { deriveCounterfactualSmartAccount } from "@astrowallet/stellar-core";
import { AccountSwitcher } from "./components/AccountSwitcher.js";
import { AstroNavigatorAvatar } from "./components/AstroNavigatorAvatar.js";
import { AstroWalletLogo } from "./components/AstroWalletLogo.js";
import { ClassicToolsSheet } from "./components/ClassicToolsSheet.js";
import { CollectiblesSheet } from "./components/CollectiblesSheet.js";
import { DappConnectSheet } from "./components/DappConnectSheet.js";
import {
  IconAccounts,
  IconActivity,
  IconArrowDownLeft,
  IconArrowUpRight,
  IconBridge,
  IconCheck,
  IconChevronRight,
  IconCopy,
  IconExternalLink,
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
  | null;

type RouteView = "landing" | "app";

const VALID_TABS: readonly AppDockTab[] = [
  "wallet",
  "nfts",
  "activity",
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
        subtitle: `Stellar ${network.toUpperCase()} · Supports G..., M... muxed & typed Memos`,
      };
    case "receive":
      return {
        title: "Receive Stellar Assets",
        subtitle: `Non-custodial G... address · ${network.toUpperCase()}`,
      };
    case "swap":
      return {
        title: "Swap & Path Router",
        subtitle: "Soroswap Soroban AMM + Classic Horizon Path",
      };
    case "scan":
      return {
        title: "Scan & Shield Firewall",
        subtitle: "Pre-sign XDR simulator & anti-drainer analysis",
      };
    case "tools":
      return {
        title: "Classic Tools & Reserves",
        subtitle: "SDEX offers, Trustlines, CAP-27 M..., LumenWipe reclaim",
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
    case "accounts":
      return <IconAccounts size={19} />;
    case "telegram":
      return <IconTelegram size={19} />;
  }
}

const DOCK_ITEMS: ReadonlyArray<{ id: AppDockTab; label: string }> = [
  { id: "wallet", label: "Wallet" },
  { id: "nfts", label: "NFTs" },
  { id: "activity", label: "Activity" },
  { id: "accounts", label: "Vault" },
  { id: "telegram", label: "Telegram" },
];

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
    loadingChain,
    chainError,
    fingerprintSupported,
    fingerprintEnrolled,
    enableFingerprint,
    disableFingerprint,
    exportAgVaultJson,
    lockVault,
    refreshChainState,
    fundActiveTestnetAccount,
  } = useWallet();

  const [activeTab, setActiveTab] = useState<AppDockTab>(initialTab);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
  const [copiedAddr, setCopiedAddr] = useState(false);
  const [fpPin, setFpPin] = useState("");
  const [fpStatusMsg, setFpStatusMsg] = useState<string | null>(null);
  const [exportedVault, setExportedVault] = useState<string | null>(null);
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
            {DOCK_ITEMS.map((item) => (
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
              <section className="glass-card aw-center-card" style={{ textAlign: "center", padding: 32 }}>
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
                    {/* Hero Balance & Quick Actions Card */}
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
                            {Number(primaryXlmBalance).toFixed(2)}{" "}
                            <span style={{ fontSize: 16, fontWeight: 600, color: "var(--aw-stellar-gold)" }}>
                              XLM
                            </span>
                          </div>

                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            {accountState?.funded
                              ? `Min reserve: ${accountState.minReserveXlm} XLM · ${accountState.subentryCount} subentries`
                              : `Unfunded account on ${config.network.toUpperCase()} ledger`}
                          </div>
                        </div>
                      </div>

                      {chainError && (
                        <div className="aw-banner aw-banner--danger" style={{ marginTop: 12 }}>
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
                            style={{ width: "100%", marginTop: 14 }}
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

                      {/* 4 Quick Actions */}
                      <div className="aw-quick-actions">
                        <button
                          type="button"
                          className="aw-action-tile aw-action-tile--primary"
                          onClick={() => setActiveDrawer("send")}
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
                          onClick={() => setActiveDrawer("swap")}
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
                      {/* Left: Asset Balances Card */}
                      <section className="glass-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
                        <div
                          style={{
                            display: "flex",
                            justifyContent: "space-between",
                            alignItems: "center",
                          }}
                        >
                          <span style={{ fontWeight: 700, fontSize: 15 }}>On-Chain Balances</span>
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
                                        ? `Issuer ${b.assetIssuer.slice(0, 6)}…${b.assetIssuer.slice(-4)}`
                                        : "Native Stellar Lumen"}
                                    </div>
                                  </div>
                                </div>
                                <div className="tabular-nums" style={{ fontWeight: 700, fontSize: 15 }}>
                                  {b.balance}
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

                      {/* Right: Stellar Suite Tools 2x2 Launcher */}
                      <section className="glass-card" style={{ display: "grid", gap: 12, alignContent: "start" }}>
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 15 }}>Stellar Suite &amp; Tools</div>
                          <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                            Launch swaps, security firewall, SDEX reserves &amp; bridges
                          </div>
                        </div>

                        <div className="aw-tool-grid">
                          <button
                            type="button"
                            className="aw-tool-card"
                            onClick={() => setActiveDrawer("swap")}
                          >
                            <div className="aw-tool-card-top">
                              <span className="aw-tool-icon aw-tool-icon--purple">
                                <IconSwap size={18} />
                              </span>
                              <IconChevronRight size={16} />
                            </div>
                            <div className="aw-tool-title">Swap &amp; Path Router</div>
                            <div className="aw-tool-sub">Soroswap AMM + Horizon</div>
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

                    {recentPayments.length === 0 ? (
                      <div className="aw-empty-state">
                        <div style={{ fontWeight: 600, fontSize: 14 }}>
                          No recent transactions on {config.network.toUpperCase()}
                        </div>
                        <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                          Receive XLM or test a transfer to inspect live ledger telemetry here.
                        </div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 6 }}>
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
                      recentPayments.map((p) => {
                        const inbound = p.to === activeAccount.address;
                        return (
                          <div key={p.id} className="aw-list-row">
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
                                    : `To ${p.to.slice(0, 6)}…${p.to.slice(-4)}`}
                                </div>
                              </div>
                            </div>
                            <div style={{ textAlign: "right" }}>
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
                              <span className="glass-pill" style={{ fontSize: 10, padding: "2px 8px" }}>
                                Settled
                              </span>
                            </div>
                          </div>
                        );
                      })
                    )}
                  </section>
                )}

                {activeTab === "accounts" && (
                  <div style={{ display: "grid", gap: 14 }}>
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
                        {accounts.map((acc) => (
                          <div key={acc.id} className="aw-list-row">
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
                            <span className="glass-pill">
                              m/44&apos;/148&apos;/{acc.derivationIndex ?? 0}&apos;
                            </span>
                          </div>
                        ))}
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

                      {/* Encrypted AGVAULT Export */}
                      <div className="aw-vault-divider">
                        <button
                          type="button"
                          className="aw-btn-secondary"
                          onClick={() => void handleExportVault()}
                        >
                          <IconKey size={15} />
                          <span>Export Encrypted .agvault Backup</span>
                        </button>
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
        {DOCK_ITEMS.map((item) => (
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

      {/* Unified Liquid Glass Modal Drawer */}
      <ModalDrawer
        open={activeDrawer !== null && currentDrawerMeta !== null}
        title={currentDrawerMeta?.title ?? ""}
        subtitle={currentDrawerMeta?.subtitle}
        onClose={() => setActiveDrawer(null)}
      >
        {activeDrawer === "send" && (
          <SendSheet embedded onClose={() => setActiveDrawer(null)} />
        )}
        {activeDrawer === "receive" && (
          <ReceiveSheet embedded onClose={() => setActiveDrawer(null)} />
        )}
        {activeDrawer === "swap" && <SwapSheet />}
        {activeDrawer === "scan" && <ScanShieldSheet />}
        {activeDrawer === "tools" && <ClassicToolsSheet />}
        {activeDrawer === "ramp" && <RampSheet />}
        {activeDrawer === "dapp" && <DappConnectSheet />}
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
