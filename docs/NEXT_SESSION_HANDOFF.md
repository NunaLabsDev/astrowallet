# AstroWallet — Next Session Handoff Guide

> **Current Status:** **Phases 0–4** + **Production Hardening (Security, Contract V2, Server Policy, PWA Shell & CI)** are complete, **deployed live to Testnet** (D1 `0002` applied, Claim Escrow V2 deployed, Worker + Pages updated with SEP-42 & relay contract allowlist, all live smoke tests passing), and verified locally (`89` Vitest tests across `18` suites + `6` Soroban Rust tests + `cargo fmt` & `cargo clippy -D warnings` + `pnpm build` + `pnpm secret-scan`).

---

## 1. Live Testnet Deployment & Provisioned Infrastructure

| Component | Live Value |
| :--- | :--- |
| **GitHub Repository** | `https://github.com/NunaLabsDev/astrowallet` (`main` branch) |
| **Official Website (Landing Showcase)** | `https://astrowallet-b1o.pages.dev/` |
| **Fintech Wallet App (PWA `/app` + Bot `/intent/*`)** | `https://astrowallet-b1o.pages.dev/app` |
| **Stellar & Soroban Dev Lab** | `https://astrowallet-b1o.pages.dev/app?tab=dev` |
| **Worker Service Name (`workers_dev = false`)** | `astrowallet-server` (bound via `ASTROWALLET_SERVER` to Pages Functions; deployed Version ID `de01e2a5-ee84-4cf5-b934-701f834212ea`) |
| **Health Check** | `https://astrowallet-b1o.pages.dev/health` (`HTTP 200`, `{"status":"ok","network":"testnet"}`) |
| **Explorer Base URL (`VITE_EXPLORER_BASE_URL`)** | `https://stellar.expert/explorer/testnet` |
| **Telegram Super-Bot** | `@AstroWalletAppBot` (`https://astrowallet-b1o.pages.dev/tg/webhook`) |
| **Cloudflare D1 Database** | `astrowallet` (`12b7f77d-5467-44a6-a4b3-11ccd63a315c`; `0001_init.sql` & **`0002_production_hardening.sql` applied remotely — 0 pending migrations**) |
| **Cloudflare KV Namespace** | `astrowallet-cache` (`3389ff9f05414c219d912e82a7a84baa`) |
| **Claim-Link Escrow V2 Contract (Testnet Live)** | `CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ` *(deployed via `testnet-deployer`, Ed25519 `AW_CLAIM_V2:`)* |
| **Claim-Link Escrow V2 WASM Hash (Testnet Live)** | `33ecebddb590eedcf1059a969122c4edf3a9fe092912356d19bd827ce17f61fb` *(superseded V1: `CBZBB5ZAGB...72635` / `988ac906...`; NEVER assign to `VITE_SMART_ACCOUNT_WASM_HASH`)* |
| **Sorobits SEP-50 Contract (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` |
| **SEP-42 Asset List URL (Testnet Live)** | `https://api.stellar.expert/explorer/testnet/asset-list/top50` |
| **Relay Allowlist (`RELAY_ALLOWED_CONTRACTS`)** | Claim Escrow V2 (`CDEOJ4...H36BQ`), Testnet XLM SAC (`CDLZFC...GCYSC`), Testnet USDC SAC (`CBIELT...QDAMA`), Sorobits SEP-50 (`CBVETC...7G3I3`) |
| **Smart Account WASM (`VITE_SMART_ACCOUNT_WASM_HASH`)** | Intentionally unset until an audited OpenZeppelin Smart Account contract matching our SDK constructor is integrated & uploaded |
| **Local Secrets Directory (git-ignored)** | `~/.secrets/astrowallet/` (`telegram-bot.env`, `contracts.env` — mode `600`) |

---

## 2. Completed & Verified Milestones

- **Phases 0–4 Complete:** Zero-hardcoding Zod env config (`PwaConfig` + `ServerConfig` with Mainnet Friendbot hard-block), SEP-0005 multi-account Argon2id/AES-GCM-256 IndexedDB vault, mandatory PIN + optional Fingerprint, Scan & Shield zero-WASM pre-sign pipeline, Soroswap + Horizon Path Payments, `M...` muxed/typed Memos/LumenWipe/SDEX, Reown/SEP-43 sandbox, Goldsky/Mercury `POST /webhooks/indexer`, and Circle CCTP (6↔7 decimal guard) + MoonPay/Transak `RampPort`.
- **Production Hardening (Phases 1–7) + Testnet Cutover Complete:**
  - **Contract V2 (`contracts/claim-escrow/src/lib.rs`):** Front-run-resistant ephemeral Ed25519 `claim()` (`AW_CLAIM_V2:` domain-separated payload verified cross-language with `@astrowallet/stellar-core`), Checks-Effects-Interactions ordering, dynamic persistent + instance TTL extension, 30-day max duration, `cancel_claim`, Soroban events, and `6` Rust unit tests (including non-mocked auth checks). **Compiled/optimized (`6,837` bytes), uploaded, deployed, and ABI smoke-checked on Stellar Testnet.**
  - **CAP-46 Smart Accounts & `stellar-core`:** Real `HashIdPreimage::envelopeTypeContractId` derivation + `Operation.createCustomContract` op builder, SAC `transfer` routing via Soroban RPC for `C...` destinations, Horizon dynamic `fee_stats()`, min 6-char PIN enforcement, HKDF-SHA256 + `rpId` WebAuthn wrapping, and `fundClaimEscrow`/`claimFromEscrow`.
  - **Scan & Shield:** Live SEP-42 fetching/caching (`sep42.ts`, configured with `https://api.stellar.expert/explorer/testnet/asset-list/top50`), `M...` → base `G...` directory/SEP-29 check, recursive `subInvocations` directory lookup, Soroban RPC `simulateTransaction` (`xdrFormat: "json"`, `balanceDiffs`), lazy Web Worker Raw XDR inspection (`inspectRawXdrInWorker`), and Claimable Balance spam shield (`ClassicToolsSheet`).
  - **Server Security (`apps/server`):** D1 migration `0002_production_hardening.sql` **applied remotely** (anti-replay unique `tx_hash`, multi-payer `intent_payments`, `processed_alerts` dedup), KV rate limiter (`rate-limit.ts`), `/v1/relay/submit` Origin/`intentAuth` + XDR/Shield + `RELAY_ALLOWED_CONTRACTS` gates, `/v1/proxy/*` rate limit + SSRF guard (verified live `127.0.0.1` -> `HTTP 400`) + Soroswap SAC/stroops payload, `POST /v1/intents/:id/confirm` op-level & Soroban verification, 2-stage Claim Links, Smart Account Guardian `/connect` verification, bot `@username` sync, exact stroops `/split`, `assetIssuer` resolution, `ChainWatcherDO` bounded batching (`15`) & `empty_init` fix, and `[env.mainnet]` scaffold in `wrangler.toml`.
  - **PWA Shell & Client Security (`apps/pwa`):** Global `ErrorBoundary`, 5-min inactivity auto-lock + 60s visibility lock, progressive PIN cooldown backoff, explicit `window.stellar` SEP-43 consent modal, complete `IntentSheet` (`claim`, `swap`, `split`, Scan & Shield pre-sign guard, `#k=` hash stripping), `React.lazy` route/sheet splitting + Vite `manualChunks` (main app chunk ~`224 kB` / `59 kB` gzip), PNG icons (`192×192`, `512×512`, `apple-touch-icon.png`), `sw.js`, and strict `_headers` CSP (`'wasm-unsafe-eval'`, HSTS, COOP) verified live on `https://astrowallet-b1o.pages.dev`.
  - **CI & Tooling:** `.github/workflows/ci.yml` runs Rust `fmt`/`clippy`/`test`, checks zero `@stellar/stellar-xdr-json` leakage in `apps/pwa/dist/assets/`, `pnpm check`, and `pnpm build`.

---

## 3. Remaining Steps for Next Session / Pre-Mainnet

1. **OpenZeppelin Smart Account Integration (`VITE_SMART_ACCOUNT_WASM_HASH`):**
   - Integrate/deploy the audited OpenZeppelin `stellar-contracts` (`multisig-account-example` / WebAuthn + Ed25519 verifier policies) and upload/pin its WASM hash into `VITE_SMART_ACCOUNT_WASM_HASH` (never reuse the Claim Escrow WASM hash).
2. **Production Redundancy & Sponsor Quotas (Optional / Pre-Mainnet):**
   - Add secondary failover endpoints to `STELLAR_RPC_URLS` / `VITE_STELLAR_RPC_URLS` and `HORIZON_URLS` / `VITE_HORIZON_URLS`, and set Worker secrets `OZ_CHANNELS_API_KEY`, `SOROSWAP_API_KEY`, and `INDEXER_WEBHOOK_SECRET` when scaling sponsorship/indexer volume.
3. **Custom Domain & Mainnet Cutover:**
   - Attach a branded domain (e.g. `app.astrowallet.xyz`) to anchor WebAuthn `rpId` and Telegram webhook, provision dedicated `[env.mainnet]` D1/KV/secrets + Mainnet Claim Escrow V2 deployment in `wrangler.toml`, and set `STELLAR_NETWORK=mainnet` (zero `FRIENDBOT_URL`).
4. **SCF #7 Audit Bank, Cloud Reown Relay & Physical Device QA:**
   - Submit [`docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](./SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) + enroll live Claim Escrow V2 in Soroban Security Audit Bank; optionally integrate `@reown/walletkit` for cloud QR WalletConnect v2 pairing (replacing the local sandbox notice); run physical QA on iOS Home Screen PWA, Android Chrome, and Telegram mobile (including live `/connect`, `/pay`, Claim Link round-trip, `/split`, `/swap`).

---

## 4. Quick Resume Commands

### Verify & Build Locally
```bash
pnpm check && pnpm build
cargo fmt --manifest-path contracts/claim-escrow/Cargo.toml --check
cargo clippy --manifest-path contracts/claim-escrow/Cargo.toml --all-targets -- -D warnings
cargo test --manifest-path contracts/claim-escrow/Cargo.toml
```

### Redeploy Worker & Pages (Zero `workers.dev` / Project-Only Names)
1. Apply D1 migration (if new migrations added) & deploy `apps/server` Worker:
   ```bash
   pnpm --filter @astrowallet/server exec wrangler d1 migrations apply astrowallet --remote
   pnpm --filter @astrowallet/server exec wrangler deploy --env=""
   ```
2. Rebuild & deploy `apps/pwa` to Cloudflare Pages (**always run `wrangler pages deploy` from inside `apps/pwa/`** so `apps/pwa/functions/` Service Binding attaches automatically):
   ```bash
   set -a
   source ~/.secrets/astrowallet/telegram-bot.env ~/.secrets/astrowallet/contracts.env
   set +a
   unset VITE_SMART_ACCOUNT_WASM_HASH
   export VITE_STELLAR_NETWORK=testnet
   export VITE_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
   export VITE_STELLAR_RPC_URLS=https://soroban-testnet.stellar.org
   export VITE_HORIZON_URLS=https://horizon-testnet.stellar.org
   export VITE_API_BASE_URL=https://astrowallet-b1o.pages.dev
   export VITE_PWA_ORIGIN=https://astrowallet-b1o.pages.dev
   export VITE_TG_BOT_USERNAME="$TG_BOT_USERNAME"
   export VITE_FRIENDBOT_URL=https://friendbot.stellar.org
   export VITE_SEP42_ASSET_LIST_URLS="https://api.stellar.expert/explorer/testnet/asset-list/top50"
   # Set VITE_SMART_ACCOUNT_WASM_HASH only to an audited OpenZeppelin Smart Account WASM hash:
   # export VITE_SMART_ACCOUNT_WASM_HASH="<AUDITED_OZ_SMART_ACCOUNT_WASM_HASH>"
   export VITE_CLAIM_ESCROW_CONTRACT_ID="$CLAIM_ESCROW_CONTRACT_ID"
   export VITE_SOROBITS_CONTRACT_ID=CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3
   export VITE_EXPLORER_BASE_URL=https://stellar.expert/explorer/testnet
   pnpm --filter @astrowallet/pwa build
   (cd apps/pwa && ../server/node_modules/.bin/wrangler pages deploy dist --project-name astrowallet --branch main)
   ```

---

## 5. Pending Decisions & Audit Follow-ups (added 2026-11-19)

1. **Read first:** [`AUDIT_2026-11.md`](./AUDIT_2026-11.md). The P0 items (Telegram `/connect` takeover, non-unique `@username`, no per-transaction confirmation, weak PIN vs. offline brute force, fake-asset alerts, relay auth by `Origin`, uncommitted work, domain/origin migration) block Mainnet. The previous "ready" status in this file applies to **Testnet only**.
2. **Open proposal — everything inside Telegram (Mini App):** see [`PROPOSAL_TELEGRAM_MINI_APP.md`](./PROPOSAL_TELEGRAM_MINI_APP.md).
   - Owner request: users should never leave Telegram; if the wallet must open, it should open as a Telegram app.
   - **Decision from the owner: investigate first, do not implement, do not change `AGENTS.md` yet.** Rule 7 (pure bot, no Mini App/WebView) remains in force.
   - Next session: run the research spike in §4–§6 of the proposal using official Telegram docs, record sources and dates, then write an ADR.
   - Guardrails while undecided: never store seed/PIN/keys in `CloudStorage`, `localStorage` or `sessionStorage`; never trust `initDataUnsafe` on the server.
3. **Do not start Mainnet work** (custom domain, `[env.mainnet]`) until the final domain is chosen, because IndexedDB, WebAuthn `rpId` and passkeys are bound to the origin.
