# AstroWallet — Master Vertical-Slice Roadmap & SCF 7.0 Plan

> **Goal:** Deliver a modular, audited, phone-first Stellar & Soroban wallet with genuine Telegram Super-Bot social connectivity, Apple Liquid Glass UI, universal Fingerprint/PIN security, and zero-hardcoding Testnet-to-Mainnet parity in 16 weeks—positioned for **SCF 7.0 Integration Track** (~$60K–$95K USD Medium tier) and **Soroban Security Audit Bank**.

---

## Phase 0: Workspace, Design Tokens & Zero-Hardcoding Foundations (Week 1)
- [x] Initialize Git repository (`git init`) with MIT License, `SECURITY.md`, `CONTRIBUTING.md`, and aligned engineering docs (`AGENTS.md`, `ARCHITECTURE.md`, `docs/DESIGN_SYSTEM.md`).
- [x] Configure `pnpm` + Turborepo monorepo (`packages/domain`, `packages/stellar-core`, `packages/security-shield`, `packages/defi`, `packages/tg-protocol`, `apps/pwa`, `apps/server`, `contracts/`).
- [x] Enforce strict TypeScript (`strict: true`, `noUncheckedIndexedAccess: true`), ESLint hexagonal import boundaries (`no-restricted-imports`), Vitest, Gitleaks secret scanning, and `cargo fmt`/`clippy`.
- [x] Implement `@astrowallet/domain` Zod `NetworkConfig` + `ServerEnv` schemas ensuring zero hardcoded URLs, passphrases, or contract IDs—and an explicit **Mainnet Friendbot hard-block**.
- [x] Configure `apps/server` Cloudflare Wrangler (`D1`, `KV`, `CHAIN_WATCHER` Durable Object) + strict PWA CSP headers (`_headers`) + CSS custom properties for the 5-color Liquid Glass palette (`#F15A24`, `#F5C928`, `#8050C8`, `#A58BE0`, `#172C69`).

---

## Phase 1: Vertical Slice E2E on Real Testnet (Weeks 2–4)
*Outcome: A working, phone-ready Testnet wallet + live Telegram Super-Bot connected end-to-end.*

- [x] **`@astrowallet/stellar-core` (Custody & Classic Core):**
  - Implement **SEP-0005** BIP-39 (12/24-word) + SLIP-0010 (`m/44'/148'/i'`) Ed25519 multi-account derivation verified 1:1 against reference vectors.
  - Implement Web Worker **Argon2id (`hash-wasm` primary + `@noble/hashes/argon2` fallback)** + **AES-GCM-256** encrypted **IndexedDB** vault (`navigator.storage.persist()`), RAM zeroization, and encrypted `AGVAULT` backup export/import.
  - Implement **Universal Auth**: mandatory PIN/Passphrase baseline + optional standard WebAuthn **Fingerprint** (`userVerification: "preferred"` — zero FaceID requirement).
- [x] **`apps/pwa` (Apple Liquid Glass MVP + Astro Navigators):**
  - Build Liquid Glass UI (`glass-canvas`, `glass-card`, `glass-sheet`, `glass-dock`), Multi-Account Switcher (`Primary`, `Savings`, `Trading`), real Testnet XLM/USDC balances & payments, iOS "Add to Home Screen First" guidance, and deterministic SVG **Astro Navigators** (`float` static/subtle state).
  - Handle Telegram → PWA Intent URLs cleanly, including the non-blocking iOS in-app browser banner ("Confirm with PIN now" / "Open in Safari or Chrome for Fingerprint").
- [x] **`apps/server` & `@astrowallet/tg-protocol` (Telegram Super-Bot Core):**
  - Implement `grammY` bot + Hono Worker + D1 schema (`tg_users` keyed by immutable `telegram_user_id`, `linked_addresses`, `signed_intents`).
  - Ship `/start`, `/connect` (signed cryptographic multi-address verification), `/accounts`, `/balance`, `/pay`, `/request`, `/split`, Inline Mode (`@bot pay ...`), HMAC-signed 5-min Intent Tokens, live chat card editing (`⏳ Pending` → `✅ Confirmed`), and `CHAIN_WATCHER` Durable Object Testnet RPC poller for real-time incoming payment alerts.

---

## Phase 2: Scan & Shield, Optional Smart Accounts (`C...`), Swaps & Claim Links (Weeks 5–8)
*Outcome: Industry-leading pre-sign protection, optional gasless Soroban Smart Accounts, Soroswap DEX aggregation, and viral Telegram Claim Links.*

- [x] **`@astrowallet/security-shield` (PWA + Telegram `/scan`):**
  - Zero-WASM decoding via `@stellar/stellar-sdk` (`contract.Spec` SEP-46/47/48, `SorobanAuthorizationEntry`) + Stellar RPC `simulateTransaction` (`xdrFormat: "json"`, balance diffs, Protocol 23 auto-restore).
  - Edge-proxy & KV-cache **StellarExpert Open Directory** (`#malicious`, `#unsafe`, `#exchange`, `/blocked-domains`) and **SEP-1 `stellar.toml`** + **SDF SEP-42** Asset Lists + **SEP-29** (`config.memo_required`) + local drainer AST rules + Claimable Balance spam shield.
  - Lazy-load `@stellar/stellar-xdr-json` (~3 MB WASM) inside a Web Worker strictly for the on-demand Raw XDR Inspector.
  - Expose in PWA **Clear-Sign Glass Sheet** (Navigator `shield` state) and public Telegram **`/scan`** command.
- [x] **Optional Soroban Smart Account (`C...`) + Fee Sponsorship:**
  - Integrate **`smart-account-kit` (`v0.10.x`)** + **`smart-account-kit-bindings` (`v0.5.x`)** + audited **OpenZeppelin `stellar-contracts` (`packages/accounts`)** for counterfactual `C...` accounts (lazy deploy on first outgoing tx `< 0.05 XLM`), Fingerprint `secp256r1` signing, 24h spending limits, and linking the user's SEP-0005 `G...` key as the on-chain **Recovery Guardian**.
  - Proxy `/v1/relay` via **`@openzeppelin/relayer-plugin-channels`** (`channels.openzeppelin.com`) with rate limits for gasless Soroban/FeeBump execution (distinct from Classic `G...` reserves).
  - Build clear **1-tap `SAC` transfer** bridge between linked `G...` and `C...` accounts.
- [x] **`@astrowallet/defi` (v1 Swaps):**
  - Worker-proxied **Soroswap Aggregator (`@soroswap/sdk`)** + zero-key **Horizon Path Payments** fallback + Telegram **`/swap`** quote-to-intent command.
- [x] **Viral Telegram Claim Links (`contracts/`):**
  - Deploy minimal audited-pattern Soroban **Claim-Link Escrow** contract on Testnet so users can send USDC/XLM to any unregistered `@username` in Telegram; recipients create a non-custodial wallet in seconds and claim on-chain (with sender refund after expiry).

---

## Phase 3: Classic Completeness, Animated Navigator States & dApp Connectivity (Weeks 9–12)
*Outcome: Power-user Stellar feature parity, polished visual states, production webhook indexing, and open dApp connectivity.*

- [x] **Classic Stellar Completeness (`@astrowallet/stellar-core`):**
  - Full **`M...` Muxed** address encoding/decoding, typed Memos, `changeTrust` + reserve calculator (`(2 + subentries + sponsoring - sponsored) * 0.5 XLM`), Claimable Balances, SDEX offers, and **`@lumenwipe/sdk`** Reserve Reclaimer + Telegram **`/reserve`** command.
- [x] **Animated Visual Polish & Real-Time Indexer Ingestion:**
  - Ship full **Astro Navigators** state suite (`float`, `shield`, `warp`, `vault`, `comms`, `zenith` `< 40 KB` SVG/dotLottie with automatic `prefers-reduced-motion` static fallback).
  - Connect `POST /webhooks/indexer` to **Goldsky Turbo Pipelines / Mercury** real-time transfer & Soroban event streams (keeping `CHAIN_WATCHER` DO as self-hosted/Testnet fallback) + `/alerts` preferences + iOS 18.4+ Declarative Web Push option.
- [x] **Ecosystem dApp Interoperability:**
  - Integrate **Reown AppKit (`@reown/appkit-adapter-stellar`)** WalletConnect v2 responder (`stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signAuthEntry`, `stellar_signMessage`), **Stellar Wallets Kit v2** module (`@creit-tech/stellar-wallets-kit`), and **SEP-43 / SEP-60** web interface.

---

## Phase 4: Self-Serve Ramp, Adversarial Hardening & SCF 7.0 Mainnet Launch (Weeks 13–16)
*Outcome: Production-ready Mainnet parity, full security verification, and SCF 7.0 + Audit Bank readiness.*

- [x] **v1 Self-Serve Fiat / Cross-Chain Ramp (`@astrowallet/defi`):**
  - Integrate **Circle CCTP (`CctpForwarder`, 0 KYB, 6→7 decimal guard)** and self-serve **MoonPay / Transak** widget behind `RampPort`.
- [x] **Adversarial & Failover Verification Suite:**
  - End-to-end Testnet suite: XDR spoofing, fake `USDC` issuer, CEX missing-memo block, expired/tampered Telegram Intents, `G...` Guardian recovery rotation, and primary→secondary RPC/Horizon failover.
- [x] **Zero-Hardcoding Mainnet Parity Dry-Run:**
  - Boot both `apps/pwa` and `apps/server` under a `mainnet` Zod env profile (read-only verification + Friendbot hard-block check).
- [x] **SCF 7.0 Integration Track & Audit Bank Submission:**
  - Apply to **SCF 7.0 Integration Track** (`https://communityfund.stellar.org/`, Medium Tier ~$60K–$95K across 10/20/30/40% tranches, 100% engineering budget) composing **OpenZeppelin Smart Accounts & Channels + Soroswap + StellarExpert/SEP-42 + CCTP/Ramps**.
  - Submit **STRIDE threat model** and live Testnet demo; enroll in **Soroban Security Audit Bank** (5% refundable deposit) prior to Mainnet activation and define verifiable Tranche #3 on-chain KPIs (active funded accounts, Soroswap swap volume, Claim Link conversions).

---

## Explicitly Deferred to v2 (Out of Scope for v1)

Keep v1 focused and shippable—**do not implement these in v1** (preserve clean `Port` interfaces for drop-in v2 plugins):

| Feature / Integration | Why Deferred to v2 | Target Interface Ready in v1 |
| :--- | :--- | :--- |
| **MoneyGram Access (`SEP-24` Cash) & BlindPay Live** | Requires corporate KYB, commercial agreements & `stellar.toml` whitelisting | `RampPort` (`packages/defi`) |
| **Blend v2 & DeFindex Yield Vaults** | Secondary to core wallet, Telegram payments, swaps & security | `YieldPort` (`packages/defi`) |
| **Blockaid Commercial Threat API (`@blockaid/client`)** | Enterprise-gated pricing; funded post-SCF award | `ThreatScannerPort` (`packages/security-shield`) |
| **Ledger WebHID / Trezor Signing** | Desktop/Android-only USB scope; v1 prioritizes zero-PC mobile custody | `SignerPort` (`packages/domain`) |
| **Capacitor Native Shell + Tangem NFC** | iOS Web NFC doesn't exist; requires native App Store / Play Store pipeline | `apps/pwa` shell wrapper |
| **SEP-50 On-Chain Collectible Badges** | Nice-to-have progression layer after core Navigator SVG states ship | Optional `contracts/` extension |
