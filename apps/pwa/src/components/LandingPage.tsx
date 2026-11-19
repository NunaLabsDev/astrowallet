import { useEffect, useState } from "react";
import type { AccountKind, ContractAddress } from "@astrowallet/domain";
import { fetchSorobitShowcase, type SorobitCollectible } from "@astrowallet/stellar-core";
import { useWallet } from "../state/wallet-context.js";
import {
  AstroNavigatorAvatar,
  deriveNavigatorTraits,
  type NavigatorState,
} from "./AstroNavigatorAvatar.js";
import { AstroWalletLogo } from "./AstroWalletLogo.js";
import {
  IconArrowUpRight,
  IconCheck,
  IconExternalLink,
  IconFingerprint,
  IconGlobe,
  IconKey,
  IconLayers,
  IconNft,
  IconShield,
  IconSparkles,
  IconTelegram,
  IconWallet,
  IconZap,
} from "./Icons.js";

export type AppDockTab =
  | "wallet"
  | "nfts"
  | "activity"
  | "dev"
  | "accounts"
  | "telegram";

interface LandingPageProps {
  onLaunchApp: (tab?: AppDockTab) => void;
}

const NAVIGATOR_STATES: ReadonlyArray<{
  id: NavigatorState;
  label: string;
  caption: string;
}> = [
  { id: "float", label: "Float", caption: "Idle vault telemetry steady" },
  { id: "shield", label: "Shield", caption: "Scan & Shield inspecting XDR" },
  { id: "warp", label: "Warp", caption: "Settling transaction in 5s" },
  { id: "vault", label: "Vault", caption: "Argon2id custody seal locked" },
  { id: "comms", label: "Comms", caption: "Signed Telegram intent active" },
  { id: "zenith", label: "Zenith", caption: "Ledger settlement confirmed" },
];

const GUARDIAN_ARCHETYPES: ReadonlyArray<{
  seedKey: string;
  kind: AccountKind;
  state: NavigatorState;
  title: string;
  role: string;
}> = [
  {
    seedKey: "classic-vanguard-pilot",
    kind: "classic",
    state: "float",
    title: "Classic Vanguard",
    role: "SEP-0005 G... Primary Custody",
  },
  {
    seedKey: "smart-sentinel-pilot",
    kind: "smart",
    state: "shield",
    title: "Smart Sentinel",
    role: "Soroban C... Gasless Signer",
  },
  {
    seedKey: "vault-arbiter-pilot",
    kind: "classic",
    state: "vault",
    title: "Vault Arbiter",
    role: "Recovery Guardian & Reserves",
  },
  {
    seedKey: "orbital-courier-pilot",
    kind: "smart",
    state: "comms",
    title: "Orbital Courier",
    role: "Telegram Signed Intent Relay",
  },
];

interface HealthTelemetry {
  state: "checking" | "online" | "degraded";
  networkLabel: string;
}

function shortenContract(id: string): string {
  return `${id.slice(0, 6)}…${id.slice(-6)}`;
}

export function LandingPage({ onLaunchApp }: LandingPageProps) {
  const { config, vaultStatus, accountState } = useWallet();

  const [previewState, setPreviewState] = useState<NavigatorState>("shield");
  const [health, setHealth] = useState<HealthTelemetry>({
    state: "checking",
    networkLabel: config.network.toUpperCase(),
  });
  const [sorobits, setSorobits] = useState<SorobitCollectible[]>([]);
  const [sorobitsTotal, setSorobitsTotal] = useState<number>(0);
  const [loadingSorobits, setLoadingSorobits] = useState<boolean>(
    Boolean(config.sorobitsContractId),
  );

  const hasExistingVault = vaultStatus === "locked" || vaultStatus === "unlocked";
  const primaryActionLabel = hasExistingVault ? "Open Vault" : "Launch Wallet App";

  useEffect(() => {
    let cancelled = false;
    const base = config.apiBaseUrl.replace(/\/+$/, "");

    fetch(`${base}/health`, { method: "GET" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as { status?: string; network?: string };
        if (!cancelled) {
          setHealth({
            state: data.status === "ok" ? "online" : "degraded",
            networkLabel: (data.network ?? config.network).toUpperCase(),
          });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setHealth({
            state: "degraded",
            networkLabel: config.network.toUpperCase(),
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config.apiBaseUrl, config.network]);

  useEffect(() => {
    let cancelled = false;
    if (!config.sorobitsContractId) {
      setLoadingSorobits(false);
      setSorobits([]);
      return;
    }

    setLoadingSorobits(true);
    fetchSorobitShowcase({
      rpcUrls: config.rpcUrls,
      networkPassphrase: config.networkPassphrase,
      contractId: config.sorobitsContractId as ContractAddress,
      maxTokens: 3,
    })
      .then((res) => {
        if (!cancelled) {
          setSorobitsTotal(res.totalSupply);
          setSorobits(res.tokens);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSorobits([]);
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingSorobits(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [config.sorobitsContractId, config.rpcUrls, config.networkPassphrase]);

  const activeStateInfo =
    NAVIGATOR_STATES.find((item) => item.id === previewState) ?? NAVIGATOR_STATES[0];

  return (
    <div className="aw-landing-canvas">
      {/* Sticky Apple Liquid Glass Navbar */}
      <header className="aw-navbar-wrap">
        <nav className="aw-navbar" aria-label="Primary website navigation">
          <a href="#top" className="aw-brand-link">
            <AstroWalletLogo size={34} />
            <div>
              <div className="aw-brand-title">AstroWallet</div>
              <div className="aw-brand-sub">Stellar &amp; Soroban Vault</div>
            </div>
            <span
              className={
                config.network === "testnet"
                  ? "glass-pill glass-pill--gold"
                  : "glass-pill glass-pill--trust"
              }
            >
              {config.network.toUpperCase()}
            </span>
          </a>

          <div className="aw-nav-links">
            <a href="#security" className="aw-nav-link">
              Security
            </a>
            <a href="#architecture" className="aw-nav-link">
              G... vs C...
            </a>
            <a href="#telegram" className="aw-nav-link">
              Telegram Bot
            </a>
            <a href="#sorobits" className="aw-nav-link">
              Sorobits
            </a>
          </div>

          <div className="aw-nav-actions">
            <a
              href={`https://t.me/${config.tgBotUsername}`}
              target="_blank"
              rel="noreferrer"
              className="aw-chip-btn aw-nav-tg-btn"
            >
              <IconTelegram size={15} />
              <span>@{config.tgBotUsername}</span>
            </a>
            <button
              type="button"
              className="aw-btn-primary aw-nav-cta"
              onClick={() => onLaunchApp("wallet")}
            >
              <IconWallet size={16} />
              <span>{primaryActionLabel}</span>
            </button>
          </div>
        </nav>
      </header>

      <main id="top" className="aw-landing-container">
        {/* Hero Split */}
        <section className="aw-hero">
          <div className="aw-hero-copy">
            <div className="aw-hero-badges">
              <span className="glass-pill glass-pill--trust">
                <span className="aw-trust-dot" />
                Self-Custodial SEP-0005 · 0 Server Keys
              </span>
              <span className="glass-pill">Live on {config.network.toUpperCase()}</span>
            </div>

            <h1 className="aw-hero-title">
              Bank-Grade Non-Custodial Custody for{" "}
              <span className="aw-text-gold">Stellar</span> &amp;{" "}
              <span className="aw-text-lavender">Soroban</span>.
            </h1>

            <p className="aw-hero-lead">
              Your SEP-0005 seed phrase stays encrypted on your phone with Argon2id and
              AES-GCM-256. Inspect every XDR operation with Scan &amp; Shield before signing, move
              funds via @{config.tgBotUsername} in Telegram, and hold live on-chain Sorobits SEP-50
              collectibles.
            </p>

            <div className="aw-hero-ctas">
              <button
                type="button"
                className="aw-btn-primary aw-cta-lg"
                onClick={() => onLaunchApp("wallet")}
              >
                <IconWallet size={18} />
                <span>{primaryActionLabel}</span>
                <IconArrowUpRight size={17} />
              </button>

              <a
                href={`https://t.me/${config.tgBotUsername}`}
                target="_blank"
                rel="noreferrer"
                className="aw-btn-secondary aw-cta-lg"
              >
                <IconTelegram size={18} />
                <span>Open @{config.tgBotUsername}</span>
                <IconExternalLink size={15} />
              </a>
            </div>

            <div className="aw-proof-bar">
              <div className="aw-proof-item">
                <IconKey size={15} />
                <span>Argon2id + AES-GCM-256 Vault</span>
              </div>
              <div className="aw-proof-item">
                <IconFingerprint size={15} />
                <span>Optional Fingerprint · Zero FaceID Lock-in</span>
              </div>
              <div className="aw-proof-item">
                <IconShield size={15} />
                <span>Pre-Sign Scan &amp; Shield Firewall</span>
              </div>
            </div>
          </div>

          {/* Right Interactive Guardian & Telemetry Phone Frame */}
          <div className="aw-hero-visual">
            <div className="glass-card glass-card--vault aw-preview-phone">
              <div className="aw-preview-topbar">
                <div className="aw-preview-status">
                  <span
                    className={
                      health.state === "online" ? "aw-trust-dot" : "aw-status-dot-warn"
                    }
                  />
                  <span>
                    {health.state === "checking"
                      ? "Verifying API & D1..."
                      : health.state === "online"
                        ? `API & D1 Online · ${health.networkLabel}`
                        : `Edge Health Degraded · ${health.networkLabel}`}
                  </span>
                </div>
                <span className="glass-pill glass-pill--trust">0 Server Keys</span>
              </div>

              <div className="aw-preview-stage">
                <div className="aw-pixel-frame aw-preview-avatar-box">
                  <AstroNavigatorAvatar
                    seedKey={`hero-guardian-${previewState}`}
                    kind={previewState === "shield" || previewState === "warp" ? "smart" : "classic"}
                    state={previewState}
                    size={108}
                  />
                </div>
                <div className="aw-preview-meta">
                  <div className="glass-pill glass-pill--gold" style={{ width: "fit-content" }}>
                    <IconSparkles size={13} />
                    <span>Astro Navigator Telemetry</span>
                  </div>
                  <div className="aw-preview-balance tabular-nums">
                    {vaultStatus === "unlocked" && accountState
                      ? `${Number(
                          accountState.balances.find((b) => b.assetCode === "XLM")?.balance ?? "0",
                        ).toFixed(2)} XLM`
                      : `${activeStateInfo?.label ?? "Shield"} Posture`}
                  </div>
                  <div className="aw-preview-caption">
                    {activeStateInfo?.caption ?? "Interactive guardian posture"}
                  </div>
                </div>
              </div>

              <div className="aw-state-switcher" role="group" aria-label="Guardian animations">
                {NAVIGATOR_STATES.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    className="aw-chip-btn"
                    aria-pressed={previewState === item.id}
                    onClick={() => setPreviewState(item.id)}
                  >
                    {item.label}
                  </button>
                ))}
              </div>

              <div className="aw-contract-seals">
                <div className="aw-seal-row">
                  <span>SEP-0005 HD Custody</span>
                  <code>m/44&apos;/148&apos;/i&apos;</code>
                </div>
                {config.claimEscrowContractId && (
                  <div className="aw-seal-row">
                    <span>Claim Escrow Contract</span>
                    <code>{shortenContract(config.claimEscrowContractId)}</code>
                  </div>
                )}
                {config.sorobitsContractId && (
                  <div className="aw-seal-row">
                    <span>Sorobits SEP-50 Live</span>
                    <code>{shortenContract(config.sorobitsContractId)}</code>
                  </div>
                )}
              </div>

              <button
                type="button"
                className="aw-btn-gold"
                style={{ width: "100%" }}
                onClick={() => onLaunchApp("wallet")}
              >
                {hasExistingVault
                  ? "Enter Your Vault & Run Live Transactions"
                  : "Create Vault & Test on Stellar"}
              </button>
            </div>
          </div>
        </section>

        {/* Section 1: Institutional Security & Custody */}
        <section id="security" className="aw-section">
          <div className="aw-section-head">
            <span className="glass-pill">Security &amp; Self-Custody</span>
            <h2 className="aw-section-title">
              Psychology of Trust, Backed by Verifiable Cryptography
            </h2>
            <p className="aw-section-sub">
              No custodial databases, no cloud key sync, and zero opaque transaction prompts.
              Every operation runs through deterministic local encryption and pre-sign firewall rules.
            </p>
          </div>

          <div className="aw-bento-grid">
            <article className="glass-card aw-feature-card">
              <div className="aw-feature-icon aw-feature-icon--gold">
                <IconKey size={22} />
              </div>
              <h3>SEP-0005 Sovereign Seed Vault</h3>
              <p>
                Derive unlimited Stellar accounts (<code>m/44&apos;/148&apos;/i&apos;</code>) from a
                single 12/24-word mnemonic. Secrets are sealed locally in IndexedDB with Argon2id
                (Web Worker) and AES-GCM-256 — never stored in localStorage or Cloudflare D1.
              </p>
              <div className="aw-feature-foot">
                <IconCheck size={14} />
                <span>Exportable .agvault encrypted backups</span>
              </div>
            </article>

            <article className="glass-card aw-feature-card">
              <div className="aw-feature-icon aw-feature-icon--purple">
                <IconShield size={22} />
              </div>
              <h3>Scan &amp; Shield Firewall</h3>
              <p>
                Inspects raw XDR and destination addresses before your key signs. Blocks malicious
                <code>setOptions</code> signer takeovers, <code>accountMerge</code> drainers,
                unverified fake USDC assets, and missing SEP-29 CEX memos.
              </p>
              <div className="aw-feature-foot">
                <IconCheck size={14} />
                <span>Lazy-loaded XDR decoder worker</span>
              </div>
            </article>

            <article className="glass-card aw-feature-card">
              <div className="aw-feature-icon aw-feature-icon--emerald">
                <IconFingerprint size={22} />
              </div>
              <h3>Universal PIN + Fingerprint Auth</h3>
              <p>
                Guaranteed access on every Android and iOS device via a 6+ digit PIN or
                passphrase. WebAuthn Fingerprint unlock and secp256r1 Smart Account passkeys are
                purely optional — never gated on FaceID hardware.
              </p>
              <div className="aw-feature-foot">
                <IconCheck size={14} />
                <span>Works in Safari, Chrome &amp; PWA standalone</span>
              </div>
            </article>
          </div>
        </section>

        {/* Section 2: Honest Classic G... vs Soroban C... Architecture */}
        <section id="architecture" className="aw-section">
          <div className="aw-section-head">
            <span className="glass-pill">Dual-Account Architecture</span>
            <h2 className="aw-section-title">
              Honest Stellar Classic (G...) + Soroban Smart Accounts (C...)
            </h2>
            <p className="aw-section-sub">
              Stellar protocols differ intentionally. AstroWallet exposes each account type
              honestly and pairs your <code>G...</code> vault as the Recovery Guardian for your{" "}
              <code>C...</code> Smart Account.
            </p>
          </div>

          <div className="aw-compare-grid">
            <article className="glass-card glass-card--vault aw-compare-card">
              <div className="aw-compare-head">
                <span className="glass-pill glass-pill--gold">Classic Account · G...</span>
                <IconGlobe size={20} />
              </div>
              <h3>Full Ledger &amp; SDEX Compatibility</h3>
              <ul className="aw-check-list">
                <li>
                  <IconCheck size={16} />
                  <span>Direct Classic SDEX orderbook offers &amp; Horizon Path payments</span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>
                    Typed Memos (<code>Text</code>, <code>ID</code>, <code>Hash</code>,{" "}
                    <code>Return</code>) + CAP-27 <code>M...</code> muxed
                  </span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>Claimable Balances, Trustlines &amp; LumenWipe 0.5 XLM reserve reclaim</span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>Acts as Recovery Guardian for your paired Soroban Smart Account</span>
                </li>
              </ul>
            </article>

            <article className="glass-card aw-compare-card">
              <div className="aw-compare-head">
                <span className="glass-pill">Smart Account · C...</span>
                <IconZap size={20} />
              </div>
              <h3>Gasless Programmable Soroban Vault</h3>
              <ul className="aw-check-list">
                <li>
                  <IconCheck size={16} />
                  <span>Counterfactual address derivation via audited OpenZeppelin WASM hash</span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>Sponsored Soroban transactions via OpenZeppelin Channels relayer</span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>
                    Hardware Fingerprint <code>secp256r1</code> passkey signer &amp; guardian
                    rotation
                  </span>
                </li>
                <li>
                  <IconCheck size={16} />
                  <span>
                    1-tap SAC bridge between Classic <code>G...</code> &amp; Smart <code>C...</code>{" "}
                    balances
                  </span>
                </li>
              </ul>
            </article>
          </div>
        </section>

        {/* Section 3: Telegram Super-Bot Showcase */}
        <section id="telegram" className="aw-section">
          <div className="aw-tg-showcase glass-card">
            <div className="aw-tg-copy">
              <span className="glass-pill glass-pill--trust">
                Pure Bot + Inline Mode · Zero Mini App Lock-in
              </span>
              <h2 className="aw-section-title" style={{ marginTop: 10 }}>
                Real Social Banking Inside Any Telegram Chat
              </h2>
              <p className="aw-section-sub" style={{ textAlign: "left", margin: "10px 0 18px" }}>
                Instead of trapping private keys in a WebView, @{config.tgBotUsername} issues
                short-lived HMAC-signed Intent links that open cleanly in AstroWallet for PIN or
                Fingerprint signing. Live indexer &amp; RPC alerts update cards in place.
              </p>

              <div className="aw-tg-steps">
                <div className="aw-seal-row">
                  <span>1. Bind addresses cryptographically</span>
                  <code>/connect</code>
                </div>
                <div className="aw-seal-row">
                  <span>2. Pay friends by @username or G...</span>
                  <code>/pay 10 XLM @friend</code>
                </div>
                <div className="aw-seal-row">
                  <span>3. Inspect any XDR or reclaim 0.5 XLM</span>
                  <code>/scan · /reserve</code>
                </div>
              </div>

              <div className="aw-hero-ctas" style={{ marginTop: 18 }}>
                <a
                  href={`https://t.me/${config.tgBotUsername}`}
                  target="_blank"
                  rel="noreferrer"
                  className="aw-btn-primary"
                >
                  <IconTelegram size={17} />
                  <span>Start @{config.tgBotUsername}</span>
                  <IconExternalLink size={14} />
                </a>
                <button
                  type="button"
                  className="aw-btn-secondary"
                  onClick={() => onLaunchApp("telegram")}
                >
                  <span>Telegram Guide in App</span>
                </button>
              </div>
            </div>

            <div className="aw-tg-mockup">
              <div className="aw-tg-mockup-head">
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <AstroNavigatorAvatar
                    seedKey="telegram-relay-bot"
                    kind="classic"
                    state="comms"
                    size={38}
                  />
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>@{config.tgBotUsername}</div>
                    <div style={{ fontSize: 11, color: "var(--aw-trust-emerald)" }}>
                      bot · {config.network} verified
                    </div>
                  </div>
                </div>
                <span className="glass-pill">HMAC ≤ 5 min</span>
              </div>

              <div className="aw-tg-bubble">
                <div className="aw-tg-bubble-title">
                  Signed Intent Flow · /pay XLM
                </div>
                <div className="aw-tg-bubble-meta">
                  <div>Network: {config.network.toUpperCase()}</div>
                  <div>Firewall: Scan &amp; Shield Verified</div>
                  <div>TTL: 300s · Single-use signature</div>
                </div>
                <div className="aw-tg-inline-btn">
                  <IconShield size={14} />
                  <span>Review &amp; Sign in AstroWallet</span>
                </div>
              </div>

              <div className="aw-tg-cmd-row">
                <code>/balance</code>
                <code>/swap 50 XLM USDC</code>
                <code>/split 100 XLM 4</code>
              </div>
            </div>
          </div>
        </section>

        {/* Section 4: Live On-Chain Sorobits SEP-50 & Astro Navigators */}
        <section id="sorobits" className="aw-section">
          <div className="aw-section-head">
            <span className="glass-pill glass-pill--gold">
              NunaLabs SEP-50 · 100% On-Chain Pixel Art
            </span>
            <h2 className="aw-section-title">
              Live Sorobits &amp; Astro Navigator Guardians
            </h2>
            <p className="aw-section-sub">
              Inspecting real SVG DNA stored directly on Stellar Soroban{" "}
              {config.sorobitsContractId ? (
                <code>{shortenContract(config.sorobitsContractId)}</code>
              ) : (
                "smart contracts"
              )}
              , paired with deterministic Astro Navigator shields for every vault account.
            </p>
          </div>

          {config.sorobitsContractId && (
            <div className="aw-sorobit-showcase-wrap">
              <div className="aw-showcase-bar">
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <IconNft size={18} />
                  <span style={{ fontWeight: 700, fontSize: 14 }}>
                    Live On-Chain Sorobits ({config.network.toUpperCase()})
                  </span>
                </div>
                <span className="glass-pill glass-pill--trust">
                  {loadingSorobits
                    ? "Querying Soroban RPC..."
                    : `${sorobitsTotal || sorobits.length} Minted On-Chain`}
                </span>
              </div>

              {loadingSorobits ? (
                <div className="aw-sorobit-grid">
                  {[0, 1, 2].map((idx) => (
                    <div key={idx} className="glass-card aw-sorobit-skeleton">
                      <div className="aw-skeleton-art" />
                      <div className="aw-skeleton-line" />
                      <div className="aw-skeleton-line aw-skeleton-line--short" />
                    </div>
                  ))}
                </div>
              ) : sorobits.length > 0 ? (
                <div className="aw-sorobit-grid">
                  {sorobits.map((nft) => (
                    <article key={nft.tokenId} className="glass-card glass-card--vault aw-sorobit-card">
                      <div className="aw-sorobit-media">
                        <img
                          src={nft.animatedDataUrl}
                          alt={nft.name}
                          width={160}
                          height={160}
                          className="aw-pixel-img"
                        />
                        {nft.soulbound && (
                          <span className="glass-pill glass-pill--gold aw-sorobit-badge">
                            Soulbound #{nft.tokenId}
                          </span>
                        )}
                      </div>

                      <div className="aw-sorobit-info">
                        <div className="aw-sorobit-title">{nft.name}</div>
                        <div className="aw-sorobit-meta">
                          <span>{nft.realmName}</span>
                          <span>Ledger #{nft.bornLedger.toLocaleString()}</span>
                        </div>
                        <div className="aw-sorobit-traits">
                          <span className="glass-pill">Gen {nft.generation}</span>
                          <span className="glass-pill">Tier {nft.rankTier}</span>
                          <span className="glass-pill">XP {nft.xpScore}</span>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="glass-card aw-banner">
                  Unable to reach Soroban RPC showcase right now. Open the NFTs tab inside the App
                  to inspect your account&apos;s Sorobits live.
                </div>
              )}
            </div>
          )}

          {/* Deterministic Astro Navigator Archetypes */}
          <div className="aw-archetypes-grid">
            {GUARDIAN_ARCHETYPES.map((arch) => {
              const traits = deriveNavigatorTraits(arch.seedKey, arch.kind);
              return (
                <article key={arch.seedKey} className="glass-card aw-archetype-card">
                  <div className="aw-pixel-frame">
                    <AstroNavigatorAvatar
                      seedKey={arch.seedKey}
                      kind={arch.kind}
                      state={arch.state}
                      size={74}
                    />
                  </div>
                  <div style={{ fontWeight: 700, fontSize: 14, marginTop: 10 }}>{arch.title}</div>
                  <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)", marginTop: 2 }}>
                    {arch.role}
                  </div>
                  <div className="aw-sorobit-traits" style={{ marginTop: 8 }}>
                    <span className="glass-pill">{traits.armorName}</span>
                    <span className="glass-pill">{traits.visorName}</span>
                  </div>
                </article>
              );
            })}
          </div>

          <div style={{ display: "flex", justifyContent: "center", marginTop: 24 }}>
            <button
              type="button"
              className="aw-btn-primary aw-cta-lg"
              onClick={() => onLaunchApp("nfts")}
            >
              <IconLayers size={18} />
              <span>Open NFTs Gallery in App</span>
            </button>
          </div>
        </section>
      </main>

      {/* Footer */}
      <footer className="aw-footer">
        <div className="aw-footer-inner">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <AstroWalletLogo size={32} />
            <div>
              <div style={{ fontWeight: 700, fontSize: 14 }}>
                AstroWallet · Non-Custodial Stellar &amp; Soroban Vault
              </div>
              <div style={{ fontSize: 12, color: "var(--aw-ink-secondary)" }}>
                Active Network: {config.network.toUpperCase()} · Zero Server Keys · SEP-0005 &amp;
                SEP-50
              </div>
            </div>
          </div>

          <div className="aw-footer-links">
            <button
              type="button"
              className="aw-chip-btn"
              onClick={() => onLaunchApp("wallet")}
            >
              Launch App
            </button>
            <button
              type="button"
              className="aw-chip-btn"
              onClick={() => onLaunchApp("dev")}
            >
              Dev Lab
            </button>
            <button
              type="button"
              className="aw-chip-btn"
              onClick={() => onLaunchApp("nfts")}
            >
              NFTs Gallery
            </button>
            <a
              href={`https://t.me/${config.tgBotUsername}`}
              target="_blank"
              rel="noreferrer"
              className="aw-chip-btn"
            >
              Telegram Bot
            </a>
          </div>
        </div>
      </footer>
    </div>
  );
}
