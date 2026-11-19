import { useMemo, useState } from "react";
import { deriveCounterfactualSmartAccount } from "@astrowallet/stellar-core";
import { AccountSwitcher } from "./components/AccountSwitcher.js";
import { AstroNavigatorAvatar } from "./components/AstroNavigatorAvatar.js";
import { AstroWalletLogo } from "./components/AstroWalletLogo.js";
import { ClassicToolsSheet } from "./components/ClassicToolsSheet.js";
import { CollectiblesSheet } from "./components/CollectiblesSheet.js";
import { DappConnectSheet } from "./components/DappConnectSheet.js";
import {
  IntentSheet,
  parseIntentRouteFromLocation,
  type ActiveIntentRoute,
} from "./components/IntentSheet.js";
import { IosBrowserGuard } from "./components/IosBrowserGuard.js";
import { OnboardingSheet } from "./components/OnboardingSheet.js";
import { RampSheet } from "./components/RampSheet.js";
import { ReceiveSheet } from "./components/ReceiveSheet.js";
import { ScanShieldSheet } from "./components/ScanShieldSheet.js";
import { SendSheet } from "./components/SendSheet.js";
import { SwapSheet } from "./components/SwapSheet.js";
import { UnlockSheet } from "./components/UnlockSheet.js";
import { loadPwaEnv } from "./config/env.js";
import { WalletProvider, useWallet } from "./state/wallet-context.js";

type DockTab = "wallet" | "nfts" | "activity" | "accounts" | "telegram";

function WalletShell() {
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

  const [activeTab, setActiveTab] = useState<DockTab>("wallet");
  const [modal, setModal] = useState<"send" | "receive" | null>(null);
  const [intentRoute, setIntentRoute] = useState<ActiveIntentRoute | null>(() =>
    parseIntentRouteFromLocation(),
  );
  const [fpPin, setFpPin] = useState("");
  const [fpStatusMsg, setFpStatusMsg] = useState<string | null>(null);
  const [exportedVault, setExportedVault] = useState<string | null>(null);
  const [webPushStatus, setWebPushStatus] = useState<string>(() => {
    if (typeof Notification === "undefined") return "unsupported";
    return Notification.permission;
  });

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

  const handleDismissIntent = () => {
    setIntentRoute(null);
    if (typeof window !== "undefined" && window.location.pathname.startsWith("/intent/")) {
      window.history.replaceState({}, "", "/");
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

  return (
    <main className="glass-canvas">
      <div className="aw-shell">
        {/* Top bar */}
        <header
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <AstroWalletLogo size={36} />
            <div>
              <div style={{ fontSize: 18, fontWeight: 700, letterSpacing: "-0.02em" }}>
                AstroWallet
              </div>
              <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                Non-Custodial Stellar &amp; Soroban Vault
              </div>
            </div>
          </div>

          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <span
              className={
                config.network === "testnet" ? "glass-pill glass-pill--gold" : "glass-pill glass-pill--trust"
              }
            >
              {config.network.toUpperCase()}
            </span>
            {vaultStatus === "unlocked" && (
              <button type="button" className="aw-chip-btn" onClick={lockVault}>
                Lock
              </button>
            )}
          </div>
        </header>

        {/* Banking-Trust Custody Posture Strip */}
        <div className="aw-trust-strip" role="status" aria-label="Security posture">
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span className="aw-trust-dot" />
            <span>
              <strong>Self-Custodial SEP-0005</strong> · Argon2id IndexedDB · Scan &amp; Shield Active
            </span>
          </div>
          <span className="glass-pill glass-pill--trust">0 Server Keys</span>
        </div>

        <IosBrowserGuard
          isIntentRoute={intentRoute !== null}
          uninitialized={vaultStatus === "uninitialized"}
        />

        {intentRoute && (
          <IntentSheet route={intentRoute} onDismiss={handleDismissIntent} />
        )}

        {vaultStatus === "loading" && (
          <section className="glass-card" style={{ textAlign: "center", padding: 28 }}>
            Opening encrypted IndexedDB vault...
          </section>
        )}

        {vaultStatus === "uninitialized" && <OnboardingSheet />}

        {vaultStatus === "locked" && <UnlockSheet />}

        {vaultStatus === "unlocked" && activeAccount && (
          <>
            <AccountSwitcher />

            {modal === "send" && <SendSheet onClose={() => setModal(null)} />}
            {modal === "receive" && <ReceiveSheet onClose={() => setModal(null)} />}

            {activeTab === "wallet" && (
              <>
                <section className="glass-card glass-card--vault">
                  <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
                    <div className="aw-pixel-frame">
                      <AstroNavigatorAvatar
                        seedKey={activeAccount.address}
                        kind={activeAccount.kind}
                        state={loadingChain ? "warp" : "float"}
                        size={76}
                      />
                    </div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}>
                        <span className="glass-pill">{activeAccount.label}</span>
                        <span className="glass-pill">
                          m/44&apos;/148&apos;/{activeAccount.derivationIndex ?? 0}&apos;
                        </span>
                      </div>
                      <div
                        className="tabular-nums"
                        style={{ fontSize: 26, fontWeight: 700, letterSpacing: "-0.02em" }}
                      >
                        {Number(primaryXlmBalance).toFixed(2)} XLM
                      </div>
                      <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                        {accountState?.funded
                          ? `Min reserve: ${accountState.minReserveXlm} XLM (${accountState.subentryCount} subentries)`
                          : `Unfunded on ${config.network.toUpperCase()}`}
                      </div>
                    </div>
                  </div>

                  {chainError && (
                    <div className="aw-banner aw-banner--danger" style={{ marginTop: 12 }}>
                      {chainError}
                    </div>
                  )}

                  <div
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1fr 1fr",
                      gap: 10,
                      marginTop: 16,
                    }}
                  >
                    <button
                      type="button"
                      className="aw-btn-primary"
                      onClick={() => setModal("send")}
                    >
                      Send
                    </button>
                    <button
                      type="button"
                      className="aw-btn-secondary"
                      onClick={() => setModal("receive")}
                    >
                      Receive / QR
                    </button>
                  </div>

                  {config.network === "testnet" &&
                    config.friendbotUrl &&
                    accountState &&
                    !accountState.funded && (
                      <button
                        type="button"
                        className="aw-btn-gold"
                        style={{ width: "100%", marginTop: 10 }}
                        disabled={loadingChain}
                        onClick={() => void fundActiveTestnetAccount()}
                      >
                        {loadingChain
                          ? "Funding via Testnet Friendbot..."
                          : "Fund 10,000 Testnet XLM (Friendbot)"}
                      </button>
                    )}
                </section>

                {/* Asset Balances List */}
                <section className="glass-card" style={{ display: "grid", gap: 10 }}>
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ fontWeight: 700, fontSize: 14 }}>On-Chain Balances</span>
                    <button
                      type="button"
                      className="aw-chip-btn"
                      disabled={loadingChain}
                      onClick={() => void refreshChainState()}
                    >
                      {loadingChain ? "Syncing..." : "Refresh"}
                    </button>
                  </div>

                  {accountState?.balances && accountState.balances.length > 0 ? (
                    accountState.balances.map((b) => (
                      <div
                        key={`${b.assetCode}:${b.assetIssuer ?? "native"}`}
                        className="aw-list-row"
                      >
                        <div>
                          <div style={{ fontWeight: 700, fontSize: 14 }}>{b.assetCode}</div>
                          <div style={{ fontSize: 11, color: "var(--aw-ink-secondary)" }}>
                            {b.assetIssuer
                              ? `Issuer ${b.assetIssuer.slice(0, 6)}…${b.assetIssuer.slice(-4)}`
                              : "Native Stellar Lumen"}
                          </div>
                        </div>
                        <div className="tabular-nums" style={{ fontWeight: 700 }}>
                          {b.balance}
                        </div>
                      </div>
                    ))
                  ) : (
                    <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
                      No active balances yet. Fund this account with at least 1 XLM to activate on
                      ledger.
                    </div>
                  )}
                </section>

                <SwapSheet />
                <RampSheet />
                <ScanShieldSheet />
                <ClassicToolsSheet />
              </>
            )}

            {activeTab === "nfts" && <CollectiblesSheet />}

            {activeTab === "activity" && (
              <section className="glass-card" style={{ display: "grid", gap: 10 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  Recent Horizon Activity ({activeAccount.label})
                </div>
                {recentPayments.length === 0 ? (
                  <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)" }}>
                    No recent transactions found for this account on {config.network.toUpperCase()}.
                  </div>
                ) : (
                  recentPayments.map((p) => {
                    const inbound = p.to === activeAccount.address;
                    return (
                      <div key={p.id} className="aw-list-row">
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
                        <div
                          className="tabular-nums"
                          style={{
                            fontWeight: 700,
                            color: inbound ? "var(--aw-safe-emerald)" : "var(--aw-ink-primary)",
                          }}
                        >
                          {inbound ? "+" : "-"}
                          {p.amount} {p.assetCode}
                        </div>
                      </div>
                    );
                  })
                )}
              </section>
            )}

            {activeTab === "accounts" && (
              <>
                <section className="glass-card" style={{ display: "grid", gap: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>
                  Multi-Account SEP-0005 Vault &amp; Biometrics
                </div>
                <div style={{ display: "grid", gap: 8 }}>
                  {accounts.map((acc) => (
                    <div key={acc.id} className="aw-list-row">
                      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                        <AstroNavigatorAvatar
                          seedKey={acc.address}
                          kind={acc.kind}
                          state="float"
                          size={34}
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
                <div
                  style={{
                    paddingTop: 10,
                    borderTop: "1px solid rgba(165, 139, 224, 0.2)",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    Optional Fingerprint Quick-Unlock (Zero FaceID Required)
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
                <div
                  style={{
                    paddingTop: 10,
                    borderTop: "1px solid rgba(165, 139, 224, 0.2)",
                    display: "grid",
                    gap: 8,
                  }}
                >
                  <button
                    type="button"
                    className="aw-btn-secondary"
                    onClick={() => void handleExportVault()}
                  >
                    Export Encrypted .agvault Backup
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
                <div
                  style={{
                    paddingTop: 10,
                    borderTop: "1px solid rgba(165, 139, 224, 0.2)",
                    display: "grid",
                    gap: 6,
                  }}
                >
                  <div style={{ fontWeight: 700, fontSize: 13 }}>
                    Optional Counterfactual Smart Account (C...) &amp; 1-Tap SAC Bridge
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
                      <span className="glass-pill">Gasless C...</span>
                    </div>
                  ) : (
                    <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Set <code>VITE_SMART_ACCOUNT_WASM_HASH</code> to enable counterfactual{" "}
                      <code>C...</code> Smart Account pairing with your <code>G...</code> Recovery
                      Guardian.
                    </div>
                  )}
                </div>
                </section>

                <DappConnectSheet />
              </>
            )}

            {activeTab === "telegram" && (
              <section className="glass-card" style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <AstroNavigatorAvatar
                    seedKey={activeAccount.address}
                    kind="classic"
                    state="comms"
                    size={56}
                  />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 15 }}>
                      Telegram Super-Bot (@{config.tgBotUsername})
                    </div>
                    <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                      Non-custodial social payments, live card edits &amp; real-time alerts
                    </div>
                  </div>
                </div>

                <div style={{ fontSize: 13, color: "var(--aw-ink-secondary)", lineHeight: 1.55 }}>
                  1. Open <strong>@{config.tgBotUsername}</strong> and run <code>/connect</code>.
                  <br />
                  2. Tap the signed link to cryptographically bind 1 or all {accounts.length} of
                  your derived accounts.
                  <br />
                  3. Send payments in any chat with <code>/pay 10 XLM @friend</code> or inline{" "}
                  <code>@{config.tgBotUsername} pay 10 XLM @friend</code>.
                </div>

                <a
                  href={`https://t.me/${config.tgBotUsername}`}
                  target="_blank"
                  rel="noreferrer"
                  className="aw-btn-primary"
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    textDecoration: "none",
                  }}
                >
                  Open @{config.tgBotUsername} in Telegram
                </a>

                <div
                  className="aw-list-row"
                  style={{ marginTop: 4 }}
                >
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

      {/* Bottom Floating Apple Liquid Glass Dock */}
      <nav className="glass-dock" aria-label="Primary navigation">
        {(
          [
            ["wallet", "Wallet"],
            ["nfts", "NFTs"],
            ["activity", "Activity"],
            ["accounts", "Accounts"],
            ["telegram", "Telegram"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className="dock-btn"
            aria-current={activeTab === id ? "page" : undefined}
            onClick={() => setActiveTab(id)}
          >
            {label}
          </button>
        ))}
      </nav>
    </main>
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
      <WalletShell />
    </WalletProvider>
  );
}
