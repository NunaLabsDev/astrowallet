# AstroWallet — Next Session Handoff Guide

> **Current Status:** Commit `d99bba8` deployed live on Cloudflare Testnet (`astrowallet-server` version `2af84e04-51e6-471f-8bf6-350d6d9947b4` with `ChannelPoolDO`, Pages `https://bae57bc5.astrowallet-soroban.pages.dev`). Shipped universal `@astrowallet/connect` v0.2.0 (`intent.ts`, `resolveTelegramIdentity`, `scanTarget` via open-CORS `POST /v1/connect/scan`, `sourceAddress` auto-selection), explicit CSP `connect-src` allowlist in `_headers`, `HighValueReauthGate` (PIN/biometric re-auth for high-value & Mainnet-warning tx), `ChannelPoolDO` (`tx_bad_seq` retry), and `POST /v1/relay/bootstrap` (`sponsored_reserve` / `direct`). **154 Vitest tests across 28 files** (`secret-scan` clean), **11/11 Rust tests** in `claim-escrow`, clean builds/typechecks/lints. **Mainnet remains blocked** until Gate 1 provisioning & external contract audit in [`AUDIT_2026-11.md`](./AUDIT_2026-11.md) are approved.

---

## 1. Live Testnet Deployment & Provisioned Infrastructure

| Component | Live Value |
| :--- | :--- |
| **GitHub Repository** | `https://github.com/NunaLabsDev/astrowallet` (`main` branch, commit `8277f14`) |
| **Telegram Mini App Entry (`/app` + `/intent/*`)** | [`t.me/AstroWalletAppBot/wallet`](https://t.me/AstroWalletAppBot/wallet) (`https://astrowallet-soroban.pages.dev/app`, latest preview `https://0095ebe6.astrowallet-soroban.pages.dev`, zero public landing showcase under ToS §7.3) |
| **Telegram Super-Bot** | `@AstroWalletAppBot` (`https://astrowallet-soroban.pages.dev/tg/webhook`) |
| **Worker Service Name (`workers_dev = false`)** | `astrowallet-server` (Version `fb8c828c-3aa7-4170-a182-059778b857b5`; bound via `ASTROWALLET_SERVER` to Pages Functions) |
| **Health Check** | `https://astrowallet-soroban.pages.dev/health` (`HTTP 200`, `{"status":"ok","network":"testnet"}`) |
| **Explorer Base URL (`VITE_EXPLORER_BASE_URL`)** | `https://stellar.expert/explorer/testnet` |
| **Cloudflare D1 Database** | `astrowallet` (`12b7f77d-5467-44a6-a4b3-11ccd63a315c`; migrations `0001_init.sql`..`0005_astro_connect.sql` — verify remote `0005` via `wrangler d1 migrations list astrowallet --remote`) |
| **Cloudflare KV Namespace** | `astrowallet-cache` (`3389ff9f05414c219d912e82a7a84baa`) |
| **Claim-Link Escrow V2 Contract (Testnet Live)** | `CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ` *(deploy/verify V2.1 code parity before Mainnet)* |
| **Claim-Link Escrow V2 WASM Hash (Testnet Live)** | `33ecebddb590eedcf1059a969122c4edf3a9fe092912356d19bd827ce17f61fb` *(NEVER assign to `VITE_SMART_ACCOUNT_WASM_HASH`)* |
| **Sorobits SEP-50 Contract (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` |
| **SEP-42 Asset List URL (Testnet Live)** | `https://api.stellar.expert/explorer/testnet/asset-list/top50` |
| **Relay Allowlist (`RELAY_ALLOWED_CONTRACTS`)** | Claim Escrow (`CDEOJ4...H36BQ`), Testnet XLM SAC (`CDLZFC...GCYSC`), Testnet USDC SAC (`CBIELT...QDAMA`), Sorobits SEP-50 (`CBVETC...7G3I3`), AstroGate Launchpad (`CB5VMD...FAPK`), Soroswap Router (`CCJUD5...7BRD`), Soroswap Factory (`CDP3HM...JTBY`) |
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

- **Audit Remediation & Ecosystem Integration (`8277f14`):** Added server-to-server Boomerang confirmation callback (`ASTRODEX` Service Binding / `ASTRODEX_API_BASE_URL` with `X-Ecosystem-Secret`), indexed D1 O(1) lookup (`getUserByLinkedAddress`), `SOURCE_ACCOUNT_MISMATCH` + Mainnet fail-closed simulation + `assembledXdr` in `@astrowallet/security-shield`, auto-selected derived `sourceAddress` in `IntentSheet`, and `relaySubmitter` wired into `createSorobanDevClient.submitRawSignedXdr`.

---

## 3. Remaining Steps for Next Session / Pre-Mainnet

> **Design Constraint (`@astrowallet/connect-sdk`):** Keep `AstroWallet` and `@astrowallet/connect-sdk` **100% general-purpose and protocol-agnostic** so external and internal Telegram dApps (Stellar & TON) integrate via standard `AstroID` + `AstroConnect v1` + `Scan & Shield` without embedding Launchpad, DEX, or NFT marketplace domain logic inside the wallet.

1. **Provision `[env.mainnet]` D1/KV/Secrets (Gate 1 P0-8):**
   - Replace `REPLACE_WITH_MAINNET_*` D1/KV IDs in `apps/server/wrangler.toml`, apply D1 migrations `0001`–`0005` to Mainnet D1, and set Mainnet secrets (`TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`, `INTENT_HMAC_SECRET`, `ECOSYSTEM_SHARED_INTENT_SECRET`, `RELAY_SPONSOR_SECRET`).
2. **External Audit & Mainnet Contract Cutover:**
   - Enroll `contracts/claim-escrow/src/lib.rs` (V2.2) before Mainnet and deploy with atomic guardian, then populate Mainnet `CLAIM_ESCROW_CONTRACT_ID` and `RELAY_ALLOWED_CONTRACTS`.
3. **OpenZeppelin Smart Account Integration (`VITE_SMART_ACCOUNT_WASM_HASH`) & Physical QA:**
   - Pin an audited OpenZeppelin `stellar-contracts` WASM hash in `VITE_SMART_ACCOUNT_WASM_HASH` and run live iOS/Android Telegram QA.
4. **Community & SCF Roadmap Execution (Nov 2026 — See `ASTRO/docs/COMMUNITY_INTELLIGENCE_AND_SCF_PLAN.md`):**
   - Ethena (`USDE`/`SUSDE`) + `USDT0` anti-spoof & Token Explorer support; Zero-`op_no_trust` `/pay` auto-escrow; Clear-Signing 2.0 (`buildHumanClearSignSummary`); redesigned `RampSheet` (MoneyGram SEP-24 + NEAR Intents 1-Click + CCTP/OFT Pro); `x402` Agent Allowance (`m/44'/148'/99'`); `SEP-60` `signAuthEntry` + `getProviderMetadata()`; Privacy-Preserving Analytics polish.

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


---

## Session checkpoint — 2026-11-23 (late): Mainnet-ready wallet + Express Sign

**State: committed `31996fa` (+ `c0f9a39` redirect fix), pushed to `main`, deployed** (`astrowallet-server`, `astrowallet-server-mainnet`, Pages `astrowallet-soroban`).

### Done
- SEP-10 → SEP-24 MoneyGram proxy (`/v1/proxy/sep10/*`, `/sep24/interactive`); fixed Workers bug (`redirect: "error"` → `"manual"`).
- NEAR Intents real IDs + live dry quotes verified. Stellar→BTC needs `depositMode: MEMO` and ≥ ~51.5 USDC. Destination needs a USDC trustline.
- Removed AstroGate / Sorobits from user-facing UI and bots (AstroGate deferred to future NFT work). Classic NFT gallery only.
- Bot (`apps/server/src/bot.ts`): new `/buy`, `/sell`, `/nft`, `/nft send`; `/swap` now tries the AstroDex 5-way aggregator first, then Soroswap, then Horizon path. Canonical Mainnet assets map (USDE, SUSDE, USDT0, USDC, AQUA, EURC). `/start` and `/help` rewritten in English.
- Express Sign: `?express=1` on intent URLs; minimalist header, inline quick-unlock (biometric/PIN), hidden dock; session lease configurable (Always Ask/15/30/60 min, `aw_express_session_ttl_min`); `window.opener.postMessage({type:"ASTRO_SIGN_COMPLETE"})` + auto-close/auto-return after 900 ms with a "Stay Here" button.
- Telegram profile (`setMyCommands`, short/long description) updated for both bots; announcement sent to the owner DM (message_id 98).
- Gates passed: build, typecheck, lint, 173/173 tests, secret-scan, PWA build.

### Verified live
Webhooks for `/start /help /balance /nft /buy /sell /swap` returned 200. Pages contain no "astrogate" string. `GET /health` = mainnet.

### Open / next
1. **Not verified:** the bot replies actually delivered in Telegram (webhook 200 only). Check the owner chat manually. Telegram `getWebhookInfo` last_error was an old 405.
2. `/buy` & `/sell` & `/nft send` untested with real signing; run one tiny real Mainnet tx with wallet `GCOKDLY…` (has AQUA + 121 NFTs); `GBVH3ZM…` has 1 XLM only.
3. MoneyGram SEP-10 needs `client_domain` + published `SIGNING_KEY` in `/.well-known/stellar.toml` of the PWA (currently returns HTML) and partner registration.
4. Express Sign: `HighValueReauthGate` still applies; test popup flow on web (ASTROdex → wallet popup) with a real device.
5. Roadmap: SEP-43 smart-account session keys (zero-popup for `C…` accounts), AstroConnect `GET /requests/:id` requires `sig`.
6. Update docs: add the Express Sign and `/buy /sell /nft` commands to `docs/INDEX.md` and the SCF submission file; run `astro-docs lint`.
7. Cosmetic: `wrangler.toml` `env.mainnet` warns about vars not inherited (FRIENDBOT_URL, CLAIM_ESCROW_CONTRACT_ID, RELAY_ALLOWED_CONTRACTS, ASTRODEX_API_BASE_URL, ASTROGATE_API_BASE_URL) — decide whether mainnet should define them.

Secrets stay in `~/.secrets/` (never print). Scratch E2E scripts: `~/.gemini/antigravity-cli/brain/939b652b-b3d3-485d-ab34-b518d29b89b2/scratch/`.


---

## Session checkpoint — 2026-11-24: Full Telegram Audit, `ASTRODEX` Service Binding, `stellar.toml` & Community Sync

**State: deployed & live-verified** (`astrowallet-server`, `astrowallet-server-mainnet`, Pages `astrowallet-soroban`).

### Done
- **Service Binding `ASTRODEX`:** Added `[[services]]` (`binding = "ASTRODEX"`, `service = "astrodex-server"`) in `apps/server/wrangler.toml` and routed bot quote calls in `apps/server/src/app.ts` through `c.env.ASTRODEX.fetch(...)`, resolving Cloudflare same-account Worker→Pages blocking.
- **MoneyGram `/.well-known/stellar.toml` & SEP-10 `client_domain`:**
  - Generated dedicated unfunded SEP-10 client-domain keypair (`SIGNING_KEY = "GBFRJ6WMZJ37EQBA34RUEZBDSGZBKRY5T2JIVPG7EHJXZZUSKKQD6YRT"`), uploaded `SEP10_CLIENT_SIGNING_SECRET` to both `astrowallet-server` and `astrowallet-server-mainnet`.
  - Published `apps/pwa/public/.well-known/stellar.toml` + `apps/pwa/public/_headers` (`Content-Type: text/plain; charset=utf-8`, `Access-Control-Allow-Origin: *`, `https://stellar.moneygram.com` in `connect-src`).
  - Wired `SEP10_CLIENT_DOMAIN` & strict sequence-0 `manageData`-only cosigning in `packages/domain/src/config.ts` and `apps/server/src/routes/proxy.ts` (+ unit tests in `apps/server/src/app.test.ts`).
- **Telegram Best Practices & Cleanup:**
  - Added `setBottomBarColor("#060E24")` + `viewportChanged` / `safeAreaChanged` / `contentSafeAreaChanged` inset listeners in `apps/pwa/src/telegram/webapp.ts`.
  - Added group-chat collision guard to `/stats`, clean asset tickers in `/buy`/`/sell`/`/swap` cards, and removed `ASTROGATE_API_BASE_URL` from `wrangler.toml` + `sorobitsContractId` fallback in `DevLabSheet.tsx`.
  - Updated `README.md`, `docs/INDEX.md`, `docs/ENV_MATRIX.md`, `docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`; `astro-docs lint` passes 0 errors / 0 warnings.
- **Banners, `@BotFather` & `@AstroSoroban` Community Sync:**
  - Regenerated AstroWallet 640×360 banner without AstroGate, updated `@BotFather` avatar/banner/Mini App & Bot API (`17` commands), updated `@AstroSoroban` metadata/pinned guide, and posted the Mainnet Upgrade announcement (`message_id=17743`).

### Verified live (Telethon MTProto + Bot API + Probes)
- `@AstroWalletAppBot` **17/17 commands** + inline `pay` verified live in real Telegram chat (`/buy 10 USDE`, `/sell 10 USDE`, `/swap 10 XLM USDE` return live XOXNO `1.3033830 USDe` quotes + `⚡ Express Sign Swap` buttons).
- `GET https://astrowallet-soroban.pages.dev/.well-known/stellar.toml` → HTTP 200, `text/plain; charset=utf-8`, `Access-Control-Allow-Origin: *`.
- `GET /v1/proxy/sep10/challenge` forwards `client_domain=astrowallet-soroban.pages.dev` (MoneyGram returns `unable to process` until partner onboarding completes).
- Full test suite: **174/174** Vitest tests, typecheck, lint, `secret-scan`, and PWA build passed.

### Open / next (User-side)
1. **Real Mainnet Express Sign tx:** Tap any live `⚡ Express Sign Swap` button sitting in `@AstroWalletAppBot` chat (e.g. from `/buy 10 USDE`) or `/nft send` with your device PIN/biometric.
2. **MoneyGram Partner Onboarding:** Register domain `astrowallet-soroban.pages.dev` and `SIGNING_KEY` (`GBFRJ6WMZJ37EQBA34RUEZBDSGZBKRY5T2JIVPG7EHJXZZUSKKQD6YRT`) with MoneyGram.

---

## Session checkpoint — 2026-11-25

- Completed and deployed **all 5 Pre-Mainnet Audits (#1–#5)** documented in [`MAINNET_READINESS_5_AUDITS_2026-11-25.md`](./MAINNET_READINESS_5_AUDITS_2026-11-25.md):
  - **Testnet / Mainnet Workers:** `astrowallet-server` (`a9d974ca-2ddc-4082-ba98-22c9174e4565`) & `astrowallet-server-mainnet` (`6bb16c84-9184-4e70-b6a5-342f617be648`).
  - **Pages Production (`--branch main`, with `./functions`):** `https://237bba00.astrowallet-soroban.pages.dev` (`https://astrowallet-soroban.pages.dev`).
  - **Checks:** `12/12` Rust tests + `clippy` + `wasm32v1-none`, `38/38` files / `208/208` Vitest tests, `gitleaks` 0 leaks, `pnpm audit --prod` 0 vulnerabilities, Playwright mobile `4/4` (`390x844` & `360x740`), and `8/8` live JSON smoke tests.
  - **Next:** Closed Beta live testing ($5–$20 real TXs) and external audit of `ClaimEscrowContract` before enabling `CLAIM_ESCROW_CONTRACT_ID` / `RELAY_SPONSOR_SECRET` on Mainnet.
