# AstroWallet

> **100% Phone-First, Zero-PC Stellar & Soroban Wallet** — Unifying non-custodial multi-account SEP-0005 seed custody (`G...`), optional gasless Soroban Smart Accounts (`C...`), zero-WASM pre-sign threat scanning, Apple Liquid Glass UI, and genuine Telegram Super-Bot social payments.

---

## Vision & Problem Statement

Every major Stellar wallet today solves only part of the mobile-first experience:
- **LOBSTR (+ Vault)** leads Classic retail adoption, but relies on extension/app-switching friction for Soroban dApps and uses WebAuthn PRF only as a local keystore wrapper.
- **Varial (formerly Freighter)** leads Soroban security (`signAuthEntry`, Blockaid) and **xBull** leads Classic/SDEX power-user tooling, yet neither provides Telegram chat-native social P2P, Claim Links for onboarding non-wallet friends, or seed-backed gasless Soroban Smart Accounts.
- **Beans, Decaf & Meru** deliver consumer UX and fiat rails, but operate as closed silos without open dApp/WalletConnect parity or MIT open-source portability.

**AstroWallet** bridges this gap with a modular, env-driven, zero-hardcoding architecture engineered from day one for Testnet-to-Mainnet production:

1. **One Master Seed Phrase → Multiple Linked Accounts (`G...`) + Counterfactual Smart Account (`C...`):**
   - Portable **SEP-0005** BIP-39 / SLIP-0010 (`m/44'/148'/i'`) seed custody deriving multiple labeled Classic accounts (`Primary`, `Savings`, `Trading`) compatible 1:1 with LOBSTR, Varial, Ledger, and MetaMask Stellar.
   - Real CAP-46 (`HashIdPreimage::envelopeTypeContractId`) counterfactual **Soroban Smart Account (`C...`)** derivation + deployment ops ready to pair with audited OpenZeppelin `stellar-contracts`, policy-gated **OpenZeppelin Channels** fee sponsorship (`/v1/relay/submit`), and SAC `transfer` routing between linked `G...` and `C...` accounts.
2. **Universal Mobile Auth (No FaceID Required) & Hardened PWA Shell:**
   - **Mandatory PIN / Passphrase (min 6 chars)** (Web Worker Argon2id + AES-GCM-256 in IndexedDB, 5-min inactivity & 60s background auto-lock, progressive cooldown backoff) + optional **Fingerprint (`Touch ID` / Android BiometricPrompt / screen lock)** via WebAuthn PRF + HKDF-SHA256.
   - Installable PWA shell (`manifest.webmanifest`, brand PNG icons, offline shell `sw.js`, global `ErrorBoundary`, lazy code-split routes/sheets, strict HSTS/COOP/CSP `_headers`).
3. **Genuine Telegram Super-Bot Connectivity (`@AstroWalletAppBot` — 2025 ToS-Compliant):**
   - Pure standard Telegram Bot (`grammY` + Inline Mode + HMAC-signed Intent Links)—zero Mini App WebView, zero TON dependency, and zero private keys on Telegram or backend servers.
   - Cryptographic `/connect` binding (`telegram_user_id` + `@username` ↔ Classic `G...` & Guardian-signed Smart `C...` accounts), `/accounts`, `/balance`, `/pay`, `/request`, `/split` (multi-payer `intent_payments`), `/scan`, `/swap` (Soroswap + Horizon Path), `/alerts`, `/reserve`, **real-time live card editing** (`⏳ Pending` → `✅ Confirmed` verified op-by-op on Horizon/RPC with anti-replay `tx_hash`), deduplicated real-time alerts, and **Telegram Claim Links V2** (ephemeral Ed25519 recipient-bound escrow).
4. **Built-In "Scan & Shield" Clear-Signing:**
   - Zero-WASM decoding (`@stellar/stellar-sdk` + recursive `subInvocations` inspection), Stellar RPC `simulateTransaction` (`xdrFormat: "json"`, `balanceDiffs`), edge-proxied & rate-limited **StellarExpert Open Directory** (`M...` → base `G...` unwrap), live **SDF SEP-42** asset list validation, **SEP-29** CEX memo guards, Claimable Balance spam shield + memo sanitization, explicit `window.stellar` SEP-43 consent modal, and lazy Web Worker Raw XDR inspection (`inspectRawXdrInWorker`).
5. **Apple Liquid Glass UI, Banking-Trust Color Psychology & Pixel "Astro Navigators" + Sorobits (SEP-50):**
   - Calibrated 60/30/10 Sovereign Navy / Frosted Amethyst / Vault Gold palette with deterministic `32×32` crisp-pixel **Astro Navigator** guardians across 6 behavioral states (`float`, `shield`, `warp`, `vault`, `comms`, `zenith`) plus live on-chain **NunaLabs Sorobits (SEP-50)** inspection via Soroban RPC.
6. **Full Consumer Execution + Built-In Stellar & Soroban Developer Workbench (`/app?tab=dev`):**
   - Multi-asset sends with `25%/50%/MAX`, SEP-0002 Federation (`user*domain`), SEP-0007 QR/URIs, Contacts book, live Horizon Path / Soroswap execution, Spendable vs Reserved breakdown, plus an integrated **Dev Lab** with live Soroban RPC telemetry, Contract Read/Write caller, XDR Lab (templates, Scan & Shield, Sign-Only, Broadcast), SEP-53 sign/verify, HD derivation inspector, on-chain `ManageData`, and Reown / SEP-43 dApp Bridge.

---

## Official Brand Palette

| Color | Role | HEX | RGB |
| :--- | :--- | :--- | :--- |
| **Solar Blaze** *(Orange)* | Primary CTAs, send/claim actions, active energy | `#F15A24` | `rgb(241, 90, 36)` |
| **Stellar Gold** *(Gold)* | Rewards, verified seals, claimable highlights *(with dark ink `#101D47`)* | `#F5C928` | `rgb(245, 201, 40)` |
| **Cosmic Purple** *(Purple)* | Soroban / Smart Account (`C...`), swaps, active states | `#8050C8` | `rgb(128, 80, 200)` |
| **Nebula Lavender** *(Light Violet)* | Glass rim highlights, focus rings, secondary tags | `#A58BE0` | `rgb(165, 139, 224)` |
| **Deep Space Navy** *(Dark Blue)* | Root canvas anchor, Classic (`G...`) depth, high-contrast surfaces | `#172C69` | `rgb(23, 44, 105)` |

---

## Modular Architecture Snapshot

- **5 Hexagonal Packages:** `@astrowallet/domain`, `@astrowallet/stellar-core`, `@astrowallet/security-shield`, `@astrowallet/defi`, `@astrowallet/tg-protocol`.
- **2 Unified Apps:** `apps/pwa` (Apple Liquid Glass mobile PWA) and `apps/server` (Cloudflare Worker running Hono + `grammY` + D1 + KV + Durable Objects), plus minimal `contracts/` (Phase 2 Claim-Link Escrow).
- **Zero Hardcoding:** Switching `STELLAR_NETWORK=testnet` ↔ `mainnet` is strictly environment-driven via Zod schemas with an enforced Mainnet Friendbot hard-block.

---

## Documentation Map

- [`AGENTS.md`](AGENTS.md) — Engineering contract for AI models & contributors: non-negotiable rules, env/secret matrix, hexagonal import boundaries, and Definition of Done.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Consolidated hexagonal monorepo design, custody & auth boundaries, honest `G...`/`C...` model, Scan & Shield pipeline, real-time alert ingestion, and Telegram Super-Bot architecture.
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — Apple Liquid Glass tokens, official 5-color palette, mobile GPU rules, Fingerprint/PIN UX, and **Astro Navigators** collectible visual system.
- [`PLAN.md`](PLAN.md) — 16-week vertical-slice roadmap from Phase 0 to Mainnet parity, SCF 7.0 Integration Track readiness, and explicit v2 deferrals.
- [`docs/AUDIT_2026-11.md`](docs/AUDIT_2026-11.md) — Full architecture/security/UX/Stellar audit (P0/P1 findings and roadmap). Static review; unverified items are marked.
- [`docs/PROPOSAL_TELEGRAM_MINI_APP.md`](docs/PROPOSAL_TELEGRAM_MINI_APP.md) — **Undecided proposal** to run the wallet fully inside Telegram as a Mini App. Not implemented; Rule 7 of `AGENTS.md` still applies until approved.
- [`docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) — SCF 7.0 Integration Track dossier, STRIDE threat model, Soroban Security Audit Bank invariants, and Tranche #3 KPIs.
- [`docs/FEASIBILITY_OPTIMIZATION_AND_TOOLING.md`](docs/FEASIBILITY_OPTIMIZATION_AND_TOOLING.md) — Engineering feasibility audit, iOS/Android storage & WebAuthn constraints, API/ramp reality checks, and verified 2026 SDK/tooling stack.
- [`docs/STELLAR_ECOSYSTEM_BENCHMARK.md`](docs/STELLAR_ECOSYSTEM_BENCHMARK.md) — Historical-to-2026 inventory of Stellar wallets, explorers/indexers, protocols, and SCF positioning.
- [`docs/PAST_AND_CURRENT_CASE_STUDIES.md`](docs/PAST_AND_CURRENT_CASE_STUDIES.md) — Deep post-mortem and live operational status of past & current Stellar Telegram, mobile, and keyless wallets (2017–2026).

---

## Live Testnet Deployment & Contracts

> Deployed on **Stellar Testnet** (`Test SDF Network ; September 2015`) with Cloudflare Pages Functions + Worker Service Binding (`ASTROWALLET_SERVER` -> `astrowallet-server`, zero `workers.dev` exposure).

| Component | Live Testnet Identifier |
| :--- | :--- |
| **Official Website (`/`)** | `https://astrowallet-b1o.pages.dev/` |
| **Fintech Wallet App (`/app`)** | `https://astrowallet-b1o.pages.dev/app` |
| **Stellar & Soroban Dev Lab** | `https://astrowallet-b1o.pages.dev/app?tab=dev` |
| **Health Check** | `https://astrowallet-b1o.pages.dev/health` |
| **Telegram Super-Bot** | [`@AstroWalletAppBot`](https://t.me/AstroWalletAppBot) (`https://astrowallet-b1o.pages.dev/tg/webhook`) |
| **Claim-Link Escrow V2 Contract (Testnet Live)** | `CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ` *(D1 `0002` applied remotely + Worker/Pages live)* |
| **Claim-Link Escrow V2 WASM Hash** | `33ecebddb590eedcf1059a969122c4edf3a9fe092912356d19bd827ce17f61fb` *(superseded V1: `CBZBB5ZAGB...72635`)* |
| **Sorobits SEP-50 Contract (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` |
| **SEP-42 Asset List (Testnet Live)** | `https://api.stellar.expert/explorer/testnet/asset-list/top50` |
