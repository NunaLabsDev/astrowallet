# AstroWallet — Next Session Handoff Guide

> **Current Status:** Migrated to a **Telegram-Exclusive Multichain Mini App (`Stellar + TON`, Telegram ToS Clause 7.3 compliant)** with **D1 security hardening (`0001`–`0004`)**, **Zero-Knowledge `AGVAULT` cloud backup sync**, **ClaimEscrowContract V2.2 (`__constructor` + `11` Rust unit tests)**, **client-side `/v1/relay/submit` fee-bump integration (`walletAuth` + `intentAuth`)**, **Stellar Token Explorer with live SEP-1 `stellar.toml` logos/metadata + native XLM ledger protocol telemetry + Auto-Quoting Swap with 3-tier anti-scam shield**, **ASTRO Ecosystem `AstroID` SSO & Universal Signer Federation (`/v1/identity/resolve`, `/v1/intents/external`, `IntentSheet` `sign_xdr` + Boomerang return)**, **IntentSheet pre-flight activation/trustline/balance guards + fee previews**, **4-hour auto-lock + Telegram mobile anti-jitter layout containment**, **unified `https://astrowallet-soroban.pages.dev` origin with `[env.mainnet]` multi-RPC failover**, and **141 Vitest tests across 25 files** (`97` source files clean on `pnpm secret-scan`, `cargo clippy -D warnings` clean, `pnpm --filter @astrowallet/pwa build` passing). **Mainnet remains blocked** until the remaining Pre-Mainnet blockers in [`AUDIT_2026-11.md`](./AUDIT_2026-11.md) are resolved.

---

## 1. Live Testnet Deployment & Provisioned Infrastructure

| Component | Live Value |
| :--- | :--- |
| **GitHub Repository** | `https://github.com/NunaLabsDev/astrowallet` (`main` branch) |
| **Telegram Mini App Entry (`/app` + `/intent/*`)** | [`t.me/AstroWalletAppBot/wallet`](https://t.me/AstroWalletAppBot/wallet) (`https://astrowallet-soroban.pages.dev/app`, zero public landing showcase under ToS §7.3) |
| **Telegram Super-Bot** | `@AstroWalletAppBot` (`https://astrowallet-soroban.pages.dev/tg/webhook`) |
| **Worker Service Name (`workers_dev = false`)** | `astrowallet-server` (bound via `ASTROWALLET_SERVER` to Pages Functions) |
| **Health Check** | `https://astrowallet-soroban.pages.dev/health` (`HTTP 200`, `{"status":"ok","network":"testnet"}`) |
| **Explorer Base URL (`VITE_EXPLORER_BASE_URL`)** | `https://stellar.expert/explorer/testnet` |
| **Cloudflare D1 Database** | `astrowallet` (`12b7f77d-5467-44a6-a4b3-11ccd63a315c`; migrations `0001_init.sql`..`0005_astro_connect.sql` — verify remote `0005` via `wrangler d1 migrations list astrowallet --remote`) |
| **Cloudflare KV Namespace** | `astrowallet-cache` (`3389ff9f05414c219d912e82a7a84baa`) |
| **Claim-Link Escrow V2 Contract (Testnet Live)** | `CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ` *(deploy/verify V2.1 code parity before Mainnet)* |
| **Claim-Link Escrow V2 WASM Hash (Testnet Live)** | `33ecebddb590eedcf1059a969122c4edf3a9fe092912356d19bd827ce17f61fb` *(NEVER assign to `VITE_SMART_ACCOUNT_WASM_HASH`)* |
| **Sorobits SEP-50 Contract (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` |
| **SEP-42 Asset List URL (Testnet Live)** | `https://api.stellar.expert/explorer/testnet/asset-list/top50` |
| **Relay Allowlist (`RELAY_ALLOWED_CONTRACTS`)** | Claim Escrow (`CDEOJ4...H36BQ`), Testnet XLM SAC (`CDLZFC...GCYSC`), Testnet USDC SAC (`CBIELT...QDAMA`), Sorobits SEP-50 (`CBVETC...7G3I3`) |
| **Smart Account WASM (`VITE_SMART_ACCOUNT_WASM_HASH`)** | Intentionally unset until an audited OpenZeppelin Smart Account contract matching our SDK constructor is integrated & uploaded |
| **Local Secrets Directory (git-ignored)** | `~/.secrets/astrowallet/` (`telegram-bot.env`, `contracts.env` — mode `600`) |

---

## 2. Completed & Verified Milestones

- **Telegram-Exclusive Multichain Mini App (`Stellar + TON`):** `TelegramOnlyGate` + `POST /v1/tg/auth` HMAC-SHA256 `initData` verification (`auth_date <= 300s`, 15m session token), `@astrowallet/ton-core` (`WalletContractV4` / `WalletContractV5R1`, SLIP-0010 `m/44'/607'/i'`), **TON Connect v2** encrypted NaCl bridge (`TonConnectSheet`), and strict removal of standalone landing site / `window.stellar` / Reown connectors per Telegram ToS §7.3–7.4.
- **Zero-Knowledge Vault & Lockout Hardening:** `Argon2id` (`64 MiB, t=3`) in Web Worker, secret strength gate, persistent IndexedDB failed-attempt lockout, zeroizable `SessionMnemonicVault` (`Uint8Array`), 3-word backup confirmation quiz, optional `BiometricManager` / `SecureStorage`, and client-encrypted `AGVAULT` v1 cloud sync (`>= 10` char Recovery Password).
- **Contract V2.2 (`contracts/claim-escrow/src/lib.rs`):** Atomic deploy-time `__constructor(Option<Address>)` eliminating `init()` front-running windows, front-run-resistant ephemeral Ed25519 `claim()` (`AW_CLAIM_V2:` domain-separated payload), conservative `3s`/ledger TTL calculation, guardian `init`/`set_deposits_paused`/`rescue_excess`, `cancel_claim`, `refund_expired`, `refund_expired_to`, `extend_claim_ttl`, and `11` Rust unit tests (including non-mocked auth checks across all gated entrypoints).
- **Full Escrow & Relay Client + Server Verification:** `StellarClient`, `wallet-context.tsx`, `IntentSheet.tsx`, and `POST /v1/intents/:id/confirm` support `funded`, `claimed`, `cancelled`, and `refunded` escrow lifecycles; `StellarClient` connects to `/v1/relay/submit` in `feebump` mode with both signed SEP-53 `walletAuth` and `intentAuth` (unblocking unlinked Claim Link recipients) plus transparent Soroban RPC fallback; `IntentSheet` enforces pre-flight account activation, auto-trustline activation, spendable balance guards, and fee clarity (`SendSheet` / `TonWalletSheet` / `IntentSheet`); `verifyTransactionConfirmed` enforces `expectedSourceAccount` and `expectedActionType` (`swap`, `reclaim_reserve`).
- **Server Security & Anti-Abuse (`apps/server`):** D1 migrations `0001`–`0004`, atomic D1 `rate_limits` & `relay_daily_usage`, partial `UNIQUE INDEX` on `username_lower`, `bot.catch` & `processed_tg_updates` idempotency, `ChainWatcherDO` alarm recovery (`finally`), cron `purgeExpiredRecords`, SEP-42 + `>= 0.05 XLM` dust filtering, and private-chat `/connect` with `confirmCode` + `"Not me — Unlink"`.
- **PWA Shell & Mobile Polish (`apps/pwa`):** Global `ErrorBoundary`, lazy code-split sheets (`vendor-ton` & `vendor-stellar` isolated), lazy Web Worker Raw XDR inspection (`inspectRawXdrInWorker`), 2-step transfer review sheets, mobile `>= 16px` anti-zoom inputs (`glass.css`), fixed `DevLabSheet` V2 `BytesN<32>` preset, and clean offline address error in `ScanShieldSheet`.
- **Stellar Token Explorer & On-Chain Scanner (`TokenExplorerSheet`, `token-explorer.ts`, `TokenBadge`):** Live Horizon `/assets`, `/liquidity_pools` (`discoverLiquidHorizonAssets`), `/ledgers?order=desc&limit=1` native XLM protocol telemetry (ledger seq, protocol version, base fee/reserve, max tx set), SEP-1 `stellar.toml` `[[CURRENCIES]]` live logo/description/anchor parsing via KV-cached `/v1/proxy/stellar-toml`, `/trade_aggregations` + `/trades` + `/order_book` interactive SVG price chart (`24h`/`7d`/`30d`), issuer security flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, `AUTH_IMMUTABLE`, `AUTH_CLAWBACK_ENABLED`), deterministic SAC `C...` derivation, authentic XLM vector emblem, and direct Explorer links (`account`, `contract`, `stellar.toml`).
- **Auto-Quoting Swap & 3-Tier Anti-Scam Token Shield (`SwapSheet`, `TokenBadge`, `token-catalog.ts`, `@astrowallet/defi`):** 380ms debounced automatic live quoting (no manual button click required), Horizon `/order_book` bid-walk fallback when `/paths/strict-send` returns empty, Soroswap-to-Horizon execution fallback, 1-tap auto-trustline activation, bare ticker resolution (`resolveSwapAssetInput`), and 3-tier trust classification (`✓ Official Native / SEP-42`, `⛔ SCAM / Spoofed Ticker` blocking swap execution on spoofed protected tickers, `⚠ Unverified Token` with issuer flag warnings).
- **4-Hour Vault Auto-Lock & Telegram Mini App Anti-Jitter Layout (`wallet-context.tsx`, `glass.css`, `webapp.ts`, all PWA sheets):** Extended inactivity and background lock timeout from 5 minutes to 4 hours (`4 * 60 * 60 * 1000` ms); synced `--tg-safe-area-inset-left/right` and `--tg-viewport-stable-height`; added `scrollbar-gutter: stable`, `#root` and `[style*="display: grid"]` `minmax(0, 1fr)` containment, fixed-height modal drawer (`.aw-modal-panel`) and reserved async slots (`.aw-quote-slot`, `.aw-token-chart-box`, `.aw-token-price-strip`, `.aw-qr-slot`) so dynamic content never shifts or overflows mobile screens.
- **ASTRO Ecosystem `AstroID` SSO & Universal Signer Federation (`identity.ts`, `intents.ts`, `IntentSheet.tsx`, `TokenExplorerSheet.tsx`):** Added public read-only `GET /v1/identity/resolve` (never exposing `encryptedVaultBackup`), `POST /v1/intents/external` (`X-Ecosystem-Secret` + `xdrSha256` verification + 4-field HMAC signature), `sign_xdr` Clear-Sign review + Soroban confirmation fallback, Boomerang **"Return to AstroDex" / "Return to AstroGate"** CTAs, and `"Pro Chart & Scan on AstroDex"` deep link inside `TokenExplorerSheet`.
- **AstroConnect v1 Open Standard (`packages/connect-sdk`, `routes/connect.ts`, `routes/discovery.ts`, `ConnectRequestSheet.tsx`, `0005_astro_connect.sql`):** Permissionless Telegram-native wallet bridge (`auth` SEP-53 Sign-In, `sign_message`, `sign_xdr` in `submit` or `sign_only` mode) with scoped CORS, `X-Connect-Token` polling, `official`/`verified`/`external` trust tiers, safe Telegram Boomerang return, `/openapi.json` & `/llms.txt`, `@astrowallet/connect` SDK + `StellarWalletsKit` adapter, and developer docs ([`ASTRO_CONNECT_SPEC.md`](./ASTRO_CONNECT_SPEC.md) & [`DEVELOPER_QUICKSTART.md`](./DEVELOPER_QUICKSTART.md)).

---

## 3. Remaining Steps for Next Session / Pre-Mainnet

1. **Provision `[env.mainnet]` D1/KV/Secrets & TON Failover (P0-8):**
   - `PWA_ORIGIN`, `ALLOWED_ORIGINS`, `TG_BOT_USERNAME`, `TG_MINI_APP_SHORT_NAME`, and Mainnet multi-endpoint `STELLAR_RPC_URLS`/`HORIZON_URLS` failover are anchored to `https://astrowallet-soroban.pages.dev` in `apps/server/wrangler.toml`. Remaining infra steps: replace `REPLACE_WITH_MAINNET_*` D1/KV IDs, add secondary failover URL to `VITE_TON_RPC_URLS`, and verify D1 migration `0004` remotely on Testnet.
2. **OpenZeppelin Smart Account Integration (`VITE_SMART_ACCOUNT_WASM_HASH`) & New-User Bootstrapping:**
   - Pin an audited OpenZeppelin `stellar-contracts` WASM hash in `VITE_SMART_ACCOUNT_WASM_HASH`, wire WebAuthn `secp256r1` contract signing, and add sponsored bootstrapping (CAP-33 / `C...`) so unfunded recipients can claim Claim Links without pre-funded XLM.
3. **External Audit & Production Hardening:**
   - Enroll `contracts/claim-escrow/src/lib.rs` (V2.1) in the Soroban Security Audit Bank and verify Testnet redeploy parity; tighten `_headers` `connect-src` from `https:` to explicit allowlisted origins; add optional high-value tx re-auth prompt.
4. **Physical Device QA & 2026 Parity Features:**
   - Run live end-to-end Telegram iOS/Android device QA (`/connect`, `/pay`, Claim Link fund/claim/cancel, `/split`, `/swap`, TON Connect v2); expand SEP-41 non-SAC balances, fiat pricing, and i18n (`es`/`en`).

---

## 4. Quick Resume Commands

### Verify & Build Locally
```bash
pnpm --filter "./packages/*" build && pnpm -r typecheck && pnpm -r lint && pnpm test && pnpm secret-scan && pnpm --filter @astrowallet/pwa build
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
   export VITE_API_BASE_URL=https://astrowallet-soroban.pages.dev
   export VITE_PWA_ORIGIN=https://astrowallet-soroban.pages.dev
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
   > See [`ENV_MATRIX.md`](./ENV_MATRIX.md) for the complete required `VITE_*` (including `VITE_TON_*` and `VITE_TG_MINI_APP_SHORT_NAME`) and Cloudflare Worker env/secret variables.
