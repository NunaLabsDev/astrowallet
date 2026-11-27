# Astro Wallet (Astro Soroban)

> **100% Phone-First, Telegram-Exclusive Multichain Mini App (Stellar + TON)** — Unifying non-custodial multi-account SEP-0005 Stellar (`G...` + optional `C...`) and SLIP-0010 TON (`WalletContractV4` / `WalletContractV5R1`) custody, zero-WASM pre-sign threat scanning, Apple Liquid Glass UI, TON Connect v2, and genuine Telegram Super-Bot social payments inside `@AstroWalletAppBot` (Telegram ToS Clause 7.3 compliant).

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
   - **Mandatory PIN / Passphrase (min 6 chars)** (Web Worker Argon2id `64 MiB` + AES-GCM-256 in IndexedDB, 4-hour sliding unlock lease via `SecureStorage`, progressive lockout) + optional **Biometric / Fingerprint (`Touch ID` / Android BiometricPrompt / screen lock)** via Telegram `BiometricManager` or WebAuthn PRF + HKDF-SHA256.
   - Installable PWA shell (`manifest.webmanifest`, brand PNG icons, offline shell `sw.js`, global `ErrorBoundary`, lazy code-split routes/sheets, strict HSTS/COOP/CSP `_headers`).
3. **Telegram-Exclusive Multichain Mini App & Super-Bot (`@AstroWalletAppBot` — ToS Clause 7.3 Compliant):**
   - Runs **100% inside Telegram** as a Mini App (`web_app` in private chats and `https://t.me/<bot>[/<short_name>]?startapp=...` in groups/inline) with **no standalone public marketing site** and strict `TelegramOnlyGate` verification (`POST /v1/tg/auth` HMAC-SHA256 `initData`, `auth_date <= 300s`, short-lived 15m session token).
   - Native **Stellar (`G...`/`C...`) + TON (`WalletContractV4`/`V5R1`, SLIP-0010 `m/44'/607'/i'`)** non-custodial asset management in one unified interface; external app connections run **exclusively via TON Connect v2** (zero `window.stellar`, zero WalletConnect/Reown non-TON external dApp connectors under Telegram ToS §7.3–7.4).
   - Cryptographic `/connect` + in-app one-tap Telegram Mini App Sync (`/v1/tg/link-challenge` → `/v1/tg/link-confirm`), `/accounts`, `/balance`, `/buy`, `/sell`, `/swap` (AstroDex 5-Way Aggregator + Soroswap + Horizon Path), `/nft` + `/nft send`, `/pay`, `/request`, `/split` (multi-payer `intent_payments`), `/scan`, `/alerts`, `/reserve`, **real-time live card editing** (`⏳ Pending` → `✅ Confirmed` verified op-by-op on Horizon/RPC with anti-replay `tx_hash`), deduplicated real-time alerts, and **Telegram Claim Links V2** (ephemeral Ed25519 recipient-bound escrow).
   - **Express Sign (`?express=1`)**: Minimalist one-tap approval overlay with inline PIN/biometric unlock, configurable session lease (`Always Ask` / `15m` / `30m` / `60m` via `aw_express_session_ttl_min`), `window.opener.postMessage({ type: "ASTRO_SIGN_COMPLETE" })`, and automatic return/popup close.
   - **SEP-10 Client Domain (`/.well-known/stellar.toml`)**: Serves `SIGNING_KEY` (`GBFRJ6WMZJ37EQBA34RUEZBDSGZBKRY5T2JIVPG7EHJXZZUSKKQD6YRT`) with `text/plain` + CORS and strict sequence-0 `manageData`-only server cosigning in `GET /v1/proxy/sep10/challenge` for MoneyGram SEP-24 ramps.
   - Optional `Telegram.WebApp.BiometricManager` + Bot API 9.0 device `SecureStorage` complements mandatory client-side Argon2id + AES-GCM-256 IndexedDB custody and `.agvault.json` export (secrets never touch `CloudStorage`, `localStorage`, `sessionStorage`, or D1/KV).
4. **Built-In "Scan & Shield" Clear-Signing:**
   - Zero-WASM decoding (`@stellar/stellar-sdk` + recursive `subInvocations` inspection), Stellar RPC `simulateTransaction` (`xdrFormat: "json"`, `balanceDiffs`), edge-proxied & rate-limited **StellarExpert Open Directory** (`M...` → base `G...` unwrap), live **SDF SEP-42** asset list validation, **SEP-29** CEX memo guards, Claimable Balance spam shield + memo sanitization, 2-step explicit transaction review screens & **TON Connect v2** consent modal (Telegram ToS Clause 7.3 compliant), and lazy Web Worker Raw XDR inspection (`inspectRawXdrInWorker`).
5. **Apple Liquid Glass UI, Banking-Trust Color Psychology & Pixel "Astro Navigators":**
   - Calibrated 60/30/10 Sovereign Navy / Frosted Amethyst / Vault Gold palette with deterministic `32×32` crisp-pixel **Astro Navigator** guardians across 6 behavioral states (`float`, `shield`, `warp`, `vault`, `comms`, `zenith`) plus a Classic Stellar NFT gallery (`/nft`).
6. **Full Consumer Execution, TON Connect v2 & Built-In Stellar/Soroban Developer Workbench:**
   - Multi-asset Stellar sends with `25%/50%/MAX`, SEP-0002 Federation (`user*domain`), SEP-0007 QR/URIs, Contacts book, live Horizon Path / Soroswap execution, Spendable vs Reserved breakdown, native TON transfers & **TON Connect v2** encrypted NaCl bridge (`@astrowallet/ton-core`), plus an integrated **Dev Lab** drawer with live Soroban RPC telemetry, Contract Read/Write caller, XDR Lab (templates, Scan & Shield, Sign-Only, Broadcast), SEP-53 sign/verify, HD derivation inspector, and on-chain `ManageData`.

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

- **7 Hexagonal Packages:** `@astrowallet/domain`, `@astrowallet/stellar-core`, `@astrowallet/ton-core`, `@astrowallet/security-shield`, `@astrowallet/defi`, `@astrowallet/tg-protocol`, `@astrowallet/connect` (open AstroConnect v1 developer SDK).
- **2 Unified Apps:** `apps/pwa` (Telegram-Exclusive Apple Liquid Glass Mini App) and `apps/server` (Cloudflare Worker running Hono + `grammY` + D1 + KV + Durable Objects), plus minimal `contracts/` (Phase 2 Claim-Link Escrow).
- **Zero Hardcoding:** Switching `STELLAR_NETWORK=testnet` ↔ `mainnet` is strictly environment-driven via Zod schemas with an enforced Mainnet Friendbot hard-block.

---

## Open Standard for Third-Party Developers (`AstroConnect v1`)

Any Stellar or Soroban Telegram Mini App can use **AstroWallet** as its permissionless login & Clear-Sign wallet layer:
- [`docs/DEVELOPER_QUICKSTART.md`](docs/DEVELOPER_QUICKSTART.md) — 5-minute TypeScript guide (`@astrowallet/connect`, SEP-53 login verification, Soroban XDR execution, and `@creit.tech/stellar-wallets-kit` bridge).
- [`docs/ASTRO_CONNECT_SPEC.md`](docs/ASTRO_CONNECT_SPEC.md) — Formal AstroConnect v1 cryptographic & Telegram ToS §7.3–7.4 protocol specification (`/v1/connect/*`, `/openapi.json`, `/llms.txt`).

---

## Documentation Map

- [`docs/INDEX.md`](docs/INDEX.md) — Authoritative lookup index of all active docs.
- [`AGENTS.md`](AGENTS.md) — Engineering contract for AI models & contributors: non-negotiable rules, hexagonal import boundaries, and Definition of Done.
- [`ARCHITECTURE.md`](ARCHITECTURE.md) — Consolidated hexagonal monorepo design, custody & auth boundaries, honest `G...`/`C...` model, Scan & Shield pipeline, real-time alert ingestion, and Telegram Super-Bot architecture.
- [`docs/ENV_MATRIX.md`](docs/ENV_MATRIX.md) — Client (`VITE_*`) and Server (`wrangler.toml`/secrets) Zod configuration matrix.
- [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — Apple Liquid Glass tokens, official 5-color palette, mobile GPU rules, Fingerprint/PIN UX, and **Astro Navigators** collectible visual system.
- [`docs/AUDIT_2026-11.md`](docs/AUDIT_2026-11.md) — Consolidated security audit status (Audits `#1–#5` + Carbon Block 1) and remaining Pre-Mainnet GA gates.
- [`docs/NEXT_SESSION_HANDOFF.md`](docs/NEXT_SESSION_HANDOFF.md) — Live Cloudflare/Stellar inventory, verification/deploy commands, and next priorities.
- [`docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) — SCF 7.0 Integration Track dossier, STRIDE threat model, and Soroban Security Audit Bank invariants.

---

## Live Deployment & Contracts

> Deployed live on Cloudflare **Mainnet** (`astro-wallet-server-mainnet`), **Testnet** (`astro-wallet-server`), and Pages (`https://astro-wallet.pages.dev`, zero `workers.dev` exposure). Do **not** deploy new Mainnet contracts until external audit completes.

| Component | Live Identifier |
| :--- | :--- |
| **Telegram Mini App Link** | [`t.me/AstroWalletAppBot/wallet`](https://t.me/AstroWalletAppBot/wallet) (`https://astro-wallet.pages.dev/app`) |
| **Health Check (Mainnet / Testnet)** | `https://astro-wallet.pages.dev/health` (add `X-Astro-Network: testnet` for Testnet) |
| **Telegram Super-Bot** | [`@AstroWalletAppBot`](https://t.me/AstroWalletAppBot) (`https://astro-wallet.pages.dev/tg/webhook`) |
| **Mainnet Worker / D1 / KV** | `astro-wallet-server-mainnet` · D1 `b67e7931-e091-418b-84ad-5c8003d2c421` (`0001..0009`) · KV `a21e4dfbbc9e45d1bdb7a6e3bf9606b3` |
| **RedStone SEP-40 Oracle (Mainnet)** | `CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF` |
| **Claim-Link Escrow (Testnet)** | `CCWVGVBSHAFS73HCDRJ5MEFJPYKKG4WQFJ2LJPNIO2PU3U4X6PTDA4TA` *(latest built WASM hash `944f9bfccd17f2e95942525dd7e050c40cbc5b6616950fc5287afbb9c37123de`)* |
| **Sorobits SEP-50 Contract (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` |
| **SEP-42 Asset List (Testnet)** | `https://api.stellar.expert/explorer/testnet/asset-list/top50` |
