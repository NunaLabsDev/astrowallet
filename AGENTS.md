# AstroWallet — Engineering Contract for AI Models & Contributors

> **Purpose:** Authoritative implementation rules for every engineer and coding model working in `/Users/munay/dev/astrowallet`. Follow this contract strictly before generating code, configs, or tests.

---

## 1. Canonical Reading Order

Before editing or bootstrapping any package, read in this order:
1. [`README.md`](README.md) — Product scope, pillars, and v1 boundaries.
2. [`AGENTS.md`](AGENTS.md) — Non-negotiable constraints, env config matrix, and Definition of Done (this file).
3. [`ARCHITECTURE.md`](ARCHITECTURE.md) — Hexagonal package boundaries, dual `G...` / `C...` mechanics, Telegram protocol, and security pipeline.
4. [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md) — Apple Liquid Glass tokens, 5-color palette, Fingerprint/PIN UX, and **Astro Navigators** visuals.
5. [`PLAN.md`](PLAN.md) — Vertical-slice execution milestones and explicit v2 deferrals.
6. [`docs/FEASIBILITY_OPTIMIZATION_AND_TOOLING.md`](docs/FEASIBILITY_OPTIMIZATION_AND_TOOLING.md) — Verified 2026 SDK packages, iOS storage traps, and API limits.
7. **Official Stellar AI Resources:** [`developers.stellar.org/llms.txt`](https://developers.stellar.org/llms.txt) and workspace plugin [`.agents/plugins/stellar-dev/`](.agents/plugins/stellar-dev/plugin.json) (Stellar Official Skills + `stellar-docs` MCP server).

---

## 2. Non-Negotiable Engineering Rules

### Rule 1 — Zero Hardcoding (100% Env-Driven Configuration)
- **Never** hardcode network passphrases (`Test SDF Network ; September 2015`, `Public Global Stellar Network ; September 2015`), RPC URLs, Horizon URLs, contract IDs (`SAC`, `Smart Account WASM hash`, `Claim Escrow`), asset issuers, bot usernames, API keys, or domain origins in source files.
- **Every** environment variable must be parsed and validated at startup via **Zod schemas** exported by `@astrowallet/domain`. Missing required variables must **fail fast** with explicit error messages.
- Switching between `testnet` and `mainnet` must happen **exclusively** via environment configuration (`STELLAR_NETWORK=testnet|mainnet` and its corresponding endpoints/contract IDs)—zero code changes, zero `if (isProd) "hardcoded..."` branches.

### Rule 2 — Real Testnet-for-Production Parity (No Fake Runtime Mocks)
- Runtime application code (`apps/pwa`, `apps/server`, `packages/*`) must execute against **real Testnet endpoints** (Stellar RPC, Horizon, OpenZeppelin Channels Testnet, Soroswap Testnet/Mainnet proxy, D1/KV).
- **Never** ship stubbed balances, hardcoded prices, fake transaction hashes, or simulated success responses inside runtime code paths. (Mocks belong strictly inside `*.test.ts` unit test suites.)
- **Friendbot Mainnet Hard-Block:** Any Friendbot auto-funding helper must enforce `config.network === "testnet"` and throw a fatal error if `FRIENDBOT_URL` is configured or invoked when `STELLAR_NETWORK === "mainnet"`.

### Rule 3 — Universal Mobile Auth (No FaceID Requirement)
- **Never** require FaceID, assume FaceID hardware exists, or render FaceID-only copy/icons.
- **Mandatory Universal Baseline:** 6-digit PIN or passphrase derived via **Argon2id in a Web Worker** (`hash-wasm` primary + `@noble/hashes/argon2` fallback) + **AES-GCM-256** inside **IndexedDB** (`navigator.storage.persist()`).
- **Optional Biometric Convenience:** Standard WebAuthn (`userVerification: "preferred"`) supporting **Fingerprint (`Touch ID` / Android BiometricPrompt / device screen lock)** for local unlock or optional Soroban `secp256r1` Smart Account signing.

### Rule 4 — Non-Custodial Key Isolation & Seed Sovereignty
- One **SEP-0005** 12/24-word mnemonic (`m/44'/148'/i'`) controls multiple linked Stellar Classic accounts (`G...`) and optionally acts as the **Recovery Guardian** for paired Soroban Smart Accounts (`C...`).
- **Plaintext** private keys, mnemonics, decrypted seed material, PINs, and recovery passwords **never** touch:
  - `localStorage` or `sessionStorage`,
  - Telegram `CloudStorage`, bot webhook payloads, or D1/KV,
  - Cloudflare Worker logs, analytics, or error trackers.
- **Zero-Knowledge Encrypted Vault Sync (`AGVAULT` v1):** Clients may persist ONLY client-encrypted `AGVAULT` v1 ciphertext envelopes (`Argon2id >= 64 MiB` + `AES-GCM-256`, strictly schema-validated, protected by a strong Recovery Password `>= 10` chars) keyed by `telegram_user_id` + `network` in Cloudflare D1 (`encrypted_vault_backups`) and mirrored to `Telegram.WebApp.CloudStorage`, ensuring users never lose wallet access on cache clears or device changes while keeping decryption 100% client-side.
- Telegram `/connect` and in-app Telegram Sync (`/v1/tg/link-challenge` -> `/v1/tg/link-confirm`) bind `telegram_user_id` (immutable primary key) and `@username` (mutable index) **exclusively via cryptographic signature verification of public addresses (`G...` / `C...`)**—never by transmitting secrets.

### Rule 5 — Strict Hexagonal Package Dependency Matrix

Enforce this DAG in `tsconfig` / ESLint boundaries (`no-restricted-imports`):

| Package / App | May Import From | Strictly Forbidden From Importing |
| :--- | :--- | :--- |
| **`@astrowallet/domain`** | `zod` only (pure TS types, ports, schemas) | `@stellar/stellar-sdk`, `@ton/*`, DOM/Window/IndexedDB, React, `grammy`, Hono, Cloudflare APIs |
| **`@astrowallet/stellar-core`** | `@astrowallet/domain`, `@stellar/stellar-sdk`, `smart-account-kit`, `hash-wasm`, `@noble/hashes` | React, DOM UI components, `grammy`, Hono, `@astrowallet/ton-core`, `apps/*` |
| **`@astrowallet/ton-core`** | `@astrowallet/domain`, `@ton/core`, `@ton/ton`, `@noble/hashes`, `@scure/bip39`, `tweetnacl` | React, DOM UI components, `grammy`, Hono, `@stellar/*`, peer `@astrowallet/*`, `cloudflare:*` |
| **`@astrowallet/security-shield`** | `@astrowallet/domain`, `@stellar/stellar-sdk` (lazy worker `@stellar/stellar-xdr-json`) | React, `grammy`, `@astrowallet/ton-core`, Cloudflare bindings directly (use injected fetcher port) |
| **`@astrowallet/defi`** | `@astrowallet/domain`, `@stellar/stellar-sdk`, `@soroswap/sdk`, `@lumenwipe/sdk` | React, `grammy`, `@astrowallet/ton-core`, raw secret keys (`sk_` keys live in `apps/server` proxy only) |
| **`@astrowallet/tg-protocol`** | `@astrowallet/domain`, Web Crypto / `@noble/ed25519` | React, IndexedDB, DOM APIs, `@astrowallet/ton-core` |
| **`apps/pwa`** | All `@astrowallet/*` client packages (NEVER `sk_*` server secrets) | `grammy`, Cloudflare D1/KV, server signing secrets |
| **`apps/server`** | `@astrowallet/domain`, `@astrowallet/security-shield`, `@astrowallet/defi`, `@astrowallet/tg-protocol`, `hono`, `grammy` | React, DOM/IndexedDB, `@astrowallet/stellar-core`, `@astrowallet/ton-core`, user private keys |

### Rule 6 — Honest Classic (`G...`) vs Smart Account (`C...`) Boundaries
- Never hide Stellar protocol constraints behind fake abstractions:
  - **Classic (`G...`):** Supports Classic SDEX, `pathPayment`, Claimable Balances, raw CEX `Memo` deposits, `accountMerge`, and `0.5 XLM` subentry reserves.
  - **Smart Account (`C...`):** Supports gasless Soroban contract invocations (`OpenZeppelin Channels`), Fingerprint `secp256r1` auth, session keys, and spending limits—**cannot** directly place Classic SDEX orderbook offers or receive un-muxed raw memo CEX deposits (must use `M...` muxed encoding or transfer to linked `G...`).
- Expose 1-tap `SAC` transfers between the user's linked `G...` and `C...` accounts so both work seamlessly together.

### Rule 7 — Telegram Mini App Exclusivity & ToS Clause 7.3 (Multichain Wallets) Compliance
- **100% Telegram-Exclusive Mini App (Zero Website):** `apps/pwa` runs exclusively inside Telegram as a Mini App launched from `@AstroWalletAppBot` (`web_app` in private chats and `https://t.me/<bot>[/<short_name>]?startapp=...` in groups/inline). Standalone marketing landing pages are removed and access outside Telegram is blocked (unless `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM=true` on Testnet dev).
- **Clause 7.3 (Multichain Wallets) Compliance:**
  - Both Stellar (`G...`/`C...`) and TON (`WalletContractV4`/`WalletContractV5R1`, BIP-39 + SLIP-0010 `m/44'/607'/i'`) non-custodial asset management happen directly inside the Mini App UI.
  - External app/dApp connections inside the Mini App operate **exclusively via TON Connect v2**. Never inject `window.stellar`, ship WalletConnect/Reown non-TON external dApp connectors, or embed non-TON external app catalogs/promotions (ToS §7.3–7.4).
- **Cryptographic Identity & Sessions:** Server verifies `Telegram.WebApp.initData` via HMAC-SHA256 (`WebAppData` + `TG_BOT_TOKEN`, `auth_date <= 300s`) on `POST /v1/tg/auth` and mints short-lived (`15m`) Mini App session tokens. **Never** trust unverified `initDataUnsafe`. Every bot action link still carries a short-lived HMAC-signed Intent Token.
- **Key Storage Safety (Rule 4 Preserved):** **Plaintext** secrets, mnemonics, PINs, and recovery passwords **never** touch `Telegram.WebApp.CloudStorage`, `localStorage`, `sessionStorage`, server logs, or D1/KV. Only client-side `Argon2id >= 64 MiB` + `AES-GCM-256` encrypted `AGVAULT` v1 ciphertext envelopes (protected by a `>= 10` char strong Recovery Password) may sync per `telegram_user_id` (`encrypted_vault_backups` + `CloudStorage` mirror), alongside optional `BiometricManager` + `SecureStorage` (Bot API 9.0 local device Keychain/Keystore), local IndexedDB custody, and `.agvault.json` export.
- **Telegram-Scoped CSP Framing:** Security headers allow framing **only** by Telegram Web/clients (`frame-ancestors https://web.telegram.org https://*.telegram.org`) and `script-src 'self' https://telegram.org 'wasm-unsafe-eval'`.

---

## 3. Environment & Network Configuration Matrix

All configuration uses explicit Zod schemas in `@astrowallet/domain`. Nothing uses silent fallback URLs in production mode.

### A. Client Public Config (`apps/pwa` — `VITE_*` prefix only; zero secrets)

| Variable | Testnet Example Value | Mainnet Example Value | Notes |
| :--- | :--- | :--- | :--- |
| `VITE_STELLAR_NETWORK` | `testnet` | `mainnet` | Controls badge & network passphrase lookup |
| `VITE_STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` | Passed directly to `@stellar/stellar-sdk` |
| `VITE_STELLAR_RPC_URLS` | Comma-separated RPC endpoints | Comma-separated RPC endpoints | Primary + failover array |
| `VITE_HORIZON_URLS` | Comma-separated Horizon endpoints | Comma-separated Horizon endpoints | Failover array for Classic ops |
| `VITE_API_BASE_URL` | `https://api-testnet.astrowallet.example` | `https://api.astrowallet.example` | Points to `apps/server` Worker |
| `VITE_PWA_ORIGIN` | `https://testnet.astrowallet.example` | `https://app.astrowallet.example` | WebAuthn `rpId` origin anchor |
| `VITE_TG_BOT_USERNAME` | `AstroWalletTestBot` | `AstroWalletBot` | Deep-link builder only |
| `VITE_TG_MINI_APP_SHORT_NAME` | `wallet` | `wallet` | Optional BotFather Mini App short name (`t.me/<bot>/<short_name>`) |
| `VITE_TON_NETWORK` | `testnet` | `mainnet` | Defaults to `VITE_STELLAR_NETWORK` |
| `VITE_TON_RPC_URLS` | Comma-separated TON RPC URLs | Comma-separated TON RPC URLs | Toncenter JSON-RPC v2 endpoints (HTTPS on mainnet) |
| `VITE_TON_BRIDGE_URL` | TON Connect SSE bridge URL | TON Connect SSE bridge URL | TON Connect v2 encrypted bridge (`https://...`) |
| `VITE_TON_EXPLORER_BASE_URL` | Testnet TON explorer URL | Mainnet TON explorer URL | Optional transaction/address explorer link |
| `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM` | `false` (or `true` locally) | *(forbidden: must be `false`)* | Zod rejects if `true` when `mainnet` |
| `VITE_FRIENDBOT_URL` | `https://friendbot.stellar.org` | *(unset — forbidden on mainnet)* | Zod rejects if set when `mainnet` |
| `VITE_SMART_ACCOUNT_WASM_HASH` | Testnet OZ account WASM hash | Mainnet audited OZ WASM hash | Enables counterfactual `C...` |
| `VITE_CLAIM_ESCROW_CONTRACT_ID` | Testnet escrow `C...` *(Phase 2)* | Mainnet audited escrow `C...` | Optional until Phase 2 Claim Links |
| `VITE_SEP42_ASSET_LIST_URLS` | Verified testnet SAL JSON URLs | SDF `assets.stellar.org` SAL JSON URLs | Anti-spoof token registry |
| `VITE_REOWN_PROJECT_ID` | Optional legacy env key | *(unused in Mini App)* | Retained only for config compatibility; disabled under §7.3 |

### B. Server Worker Env & Secrets (`apps/server` — Cloudflare `wrangler.toml` + `wrangler secret`)

| Binding / Secret | Type | Purpose |
| :--- | :--- | :--- |
| `STELLAR_NETWORK` / `STELLAR_NETWORK_PASSPHRASE` | Env Var | Must match `apps/pwa` network (validated on every `/v1/intents` call) |
| `STELLAR_RPC_URLS` / `HORIZON_URLS` | Env Var | Comma-separated RPC & Horizon endpoints for simulation, poller, and `/scan` |
| `PWA_ORIGIN` / `ALLOWED_ORIGINS` | Env Var | Strict CORS allowlist + Mini App URL builder |
| `TG_BOT_USERNAME` / `TG_MINI_APP_SHORT_NAME` | Env Var | Group/inline `https://t.me/<bot>/<short_name>?startapp=...` link builder |
| `STELLAR_EXPERT_API_BASE` | Env Var | Base URL for Open Directory / blocked domains proxy |
| `OZ_CHANNELS_API_URL` | Env Var | `https://channels.openzeppelin.com/testnet` or `https://channels.openzeppelin.com` |
| `SOROSWAP_API_BASE` | Env Var | Soroswap aggregator API base URL |
| `DB` | Cloudflare D1 | Users (`telegram_user_id` PK), verified `G...`/`C...` addresses, intents, claim links, alert cursor |
| `CACHE` | Cloudflare KV | Edge-cached StellarExpert tags, `stellar.toml` fetches, SEP-42 lists, rate limits |
| `CHAIN_WATCHER` | Durable Object | Lightweight Stellar RPC cursor poller fallback for Testnet real-time Telegram alerts |
| `TG_BOT_TOKEN` | Secret | Telegram Bot API token (`grammY`) |
| `TG_WEBHOOK_SECRET` | Secret | Verifies `X-Telegram-Bot-Api-Secret-Token` header on `/tg/webhook` |
| `INTENT_HMAC_SECRET` | Secret | Signs & verifies short-lived Bot↔PWA Intent Tokens (`<= 5 min` TTL) |
| `OZ_CHANNELS_API_KEY` | Secret | Rate-limited OpenZeppelin Channels sponsorship key |
| `SOROSWAP_API_KEY` | Secret | Proxied `sk_` key (never exposed to browser) |
| `INDEXER_WEBHOOK_SECRET` | Secret | Verifies Goldsky Turbo Pipeline / Mercury webhook signatures on `/webhooks/indexer` |

---

## 4. Code Quality & Security Definition of Done

No PR or Milestone is marked complete until **all** checks pass after the final edit:

1. **Zero Lint & Type Errors:** `pnpm typecheck` (`strict: true`, `noUncheckedIndexedAccess: true`) and `pnpm lint` pass across every package and app.
2. **Unit & Protocol Vector Tests (`pnpm test`):**
   - **SEP-0005 Vectors:** `m/44'/148'/0'`, `'1'`, `'2'` exact match against Stellar SDK / LOBSTR / Ledger reference test vectors.
   - **Crypto Vault:** Argon2id Worker (`hash-wasm` + `@noble/hashes` fallback) + AES-GCM-256 round-trip, wrong-PIN rejection, buffer zeroization.
   - **Intent Security:** Expired, tampered, or cross-network Intent Tokens fail closed; `telegram_user_id` mismatch rejected.
   - **Scan & Shield Rules:** Malicious `setOptions`, `accountMerge`, fake `USDC`, and missing `SEP-29` exchange memo blocked deterministically.
3. **Zero-Hardcoding Audit:** Search diff for raw URLs, `Test SDF Network`, `Public Global`, `sk_`, or private keys—only allowed inside `.env.example` and test fixtures.
4. **Bundle & CSP Verification:**
   - Initial PWA load excludes `@stellar/stellar-xdr-json` (~3 MB WASM stays lazy-loaded in Worker).
   - CSP forbids `'unsafe-inline'`, `'unsafe-eval'`, and unrestricted framing (`frame-ancestors https://web.telegram.org https://*.telegram.org` only).
5. **Secret Scan:** Gitleaks / pre-commit secret scan clean.
