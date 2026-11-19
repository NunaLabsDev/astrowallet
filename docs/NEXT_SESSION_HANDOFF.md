# AstroWallet — Next Session Handoff Guide

> **Current Status:** **Phases 0–4**, the official Stellar Landing Website (`/`), the full-featured Liquid Glass Fintech Wallet (`/app`) for users & developers (**Dev Lab**), animated crisp-pixel Navigators, live Sorobits SEP-50 integration, Cloudflare live Testnet deployment, and Telegram Super-Bot webhook are **100% live and verified** (`76` Vitest tests + `2` Soroban Rust tests passing).

---

## 1. Live Testnet Deployment & Provisioned Infrastructure

| Component | Live Value |
| :--- | :--- |
| **GitHub Repository** | `https://github.com/NunaLabsDev/astrowallet` (`main` branch) |
| **Official Website (Landing Showcase)** | `https://astrowallet-b1o.pages.dev/` |
| **Fintech Wallet App (PWA `/app` + Bot `/intent/*`)** | `https://astrowallet-b1o.pages.dev/app` |
| **Stellar & Soroban Dev Lab** | `https://astrowallet-b1o.pages.dev/app?tab=dev` |
| **Worker Service Name (`workers_dev = false`)** | `astrowallet-server` (bound via `ASTROWALLET_SERVER` to Pages Functions) |
| **Health Check** | `https://astrowallet-b1o.pages.dev/health` |
| **Explorer Base URL (`VITE_EXPLORER_BASE_URL`)** | `https://stellar.expert/explorer/testnet` |
| **Telegram Super-Bot** | `@AstroWalletAppBot` (`https://astrowallet-b1o.pages.dev/tg/webhook`) |
| **Cloudflare D1 Database** | `astrowallet` (`12b7f77d-5467-44a6-a4b3-11ccd63a315c`, migration `0001_init.sql` applied) |
| **Cloudflare KV Namespace** | `astrowallet-cache` (`3389ff9f05414c219d912e82a7a84baa`) |
| **Claim-Link Escrow Contract (Testnet)** | `CBZBB5ZAGBE6KMDVPEIFCZ7EYGO65JQ7QYJMBQVHSCDUAXK77DK72635` |
| **Claim-Link Escrow WASM Hash** | `988ac906c80398174a8e42dbfbd1c30ae54b3e5f138fef1899f73ac0db43c65d` |
| **Sorobits SEP-50 Contract (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` |
| **Local Secrets Directory (git-ignored)** | `~/.secrets/astrowallet/` (`telegram-bot.env`, `contracts.env`) |

---

## 2. Completed & Verified Milestones

- **Phases 0–4 Complete:** Zero-hardcoding Zod env config (`PwaConfig` + `ServerConfig` with Mainnet Friendbot hard-block), SEP-0005 multi-account Argon2id/AES-GCM-256 IndexedDB vault, mandatory PIN + optional Fingerprint, Scan & Shield zero-WASM pre-sign pipeline, Soroban Smart Accounts (`C...`) + Guardian rotation (`rotate_guardian`), Soroswap + Horizon Path Payments, Claim-Link Escrow Soroban contract (`contracts/claim-escrow/src/lib.rs`), `M...` muxed/typed Memos/LumenWipe/SDEX, Reown/WalletConnect v2 + Wallets Kit v2 + SEP-43, Goldsky/Mercury `POST /webhooks/indexer`, and Circle CCTP (6↔7 decimal guard) + MoonPay/Transak `RampPort`.
- **Banking-Trust Website (`/`) + Fintech Wallet & Dev Lab (`/app`) (`apps/pwa` & `packages/stellar-core`):**
  - 60/30/10 Sovereign Navy / Frosted Amethyst / Vault Gold palette, `LandingPage.tsx` at `/` (live `/health` telemetry, interactive 6-state Navigator preview, honest `G...` vs `C...` comparison, `@AstroWalletAppBot` preview, and live on-chain `fetchSorobitShowcase`), and `/app` Wallet Shell (desktop sidebar + mobile icon dock, 2-step guided onboarding with `3×4` seed grid, uncluttered Wallet balance hero + Spendable vs Reserved bar + quick actions + `ModalDrawer` tool sheets, multi-token `CollectiblesSheet` showcase grid).
  - **Full User Execution Suite:** Multi-asset `SendSheet` (`25%/50%/MAX`, SEP-0002 Federation resolve, SEP-0007 URI parse, Contacts quick-picker, Camera QR scanner, live pre-send Scan & Shield, Explorer links via `VITE_EXPLORER_BASE_URL`), `SwapSheet` (Soroswap + live Horizon Strict-Send path swap execution with slippage tolerance & hops preview), `ReceiveSheet` (`G...`, `SEP-0007` Payment Request QR, `M...` Muxed QR + Web Share), Activity filtering + Explorer/Tx copy, and Vault management (Contacts book, Account Rename, PIN-gated Reveal Seed Phrase, and Wipe Vault danger zone).
  - **Stellar & Soroban Dev Lab (`/app?tab=dev`):** Live RPC telemetry, Testnet Faucet, interactive Soroban Contract Read/Write Caller, XDR Inspector/Template Generator/Sign-Only/Broadcaster, SEP-53 Sign & Verify, Raw Ed25519 Hex & SEP-0005 derivation table, On-chain `ManageData` editor, and dApp Bridge.
  - Custody posture strip (`Self-Custodial SEP-0005 · Argon2id IndexedDB · 0 Server Keys`), `32×32` crisp-pixel `AstroWalletLogo` & `favicon.svg`, and `32×32` pixel `AstroNavigatorAvatar` across 6 animated behavioral states (`float`, `shield`, `warp`, `vault`, `comms`, `zenith`).

---

## 3. Mainnet Promotion & SCF 7.0 Checklist

1. **SCF 7.0 Integration Track & Soroban Security Audit Bank:**
   - Submit [`docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](./SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) with the live demo at `https://astrowallet-b1o.pages.dev` and `@AstroWalletAppBot`.
2. **Mainnet Cutover (Env-Only, Zero Code Changes):**
   - Deploy audited `contracts/claim-escrow` to Stellar Mainnet and enroll in Soroban Security Audit Bank.
   - Create dedicated Mainnet Cloudflare D1/KV (`astrowallet-mainnet`), set `STELLAR_NETWORK=mainnet`, remove `FRIENDBOT_URL` / `VITE_FRIENDBOT_URL`, configure Mainnet RPC/Horizon/API origins, and rotate `TG_BOT_TOKEN` / `TG_WEBHOOK_SECRET` / `INTENT_HMAC_SECRET`.

---

## 4. Quick Resume Commands & Next Session Paths

### Verify & Build Locally
```bash
pnpm check && pnpm build
cargo test --manifest-path contracts/claim-escrow/Cargo.toml
```

### Redeploy Worker & Pages (Zero `workers.dev` / Project-Only Names)
1. Deploy `apps/server` Worker:
   ```bash
   set -a && source ~/.secrets/env && set +a
   pnpm --filter @astrowallet/server exec wrangler deploy
   ```
2. Rebuild & deploy `apps/pwa` to Cloudflare Pages (**always run `wrangler pages deploy` from inside `apps/pwa/`** so `apps/pwa/functions/` Service Binding attaches automatically):
   ```bash
   set -a
   source ~/.secrets/env ~/.secrets/astrowallet/telegram-bot.env ~/.secrets/astrowallet/contracts.env
   set +a
   export VITE_STELLAR_NETWORK=testnet
   export VITE_STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"
   export VITE_STELLAR_RPC_URLS=https://soroban-testnet.stellar.org
   export VITE_HORIZON_URLS=https://horizon-testnet.stellar.org
   export VITE_API_BASE_URL=https://astrowallet-b1o.pages.dev
   export VITE_PWA_ORIGIN=https://astrowallet-b1o.pages.dev
   export VITE_TG_BOT_USERNAME="$TG_BOT_USERNAME"
   export VITE_FRIENDBOT_URL=https://friendbot.stellar.org
   export VITE_SMART_ACCOUNT_WASM_HASH="$CLAIM_ESCROW_WASM_HASH"
   export VITE_CLAIM_ESCROW_CONTRACT_ID="$CLAIM_ESCROW_CONTRACT_ID"
   export VITE_SOROBITS_CONTRACT_ID=CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3
   export VITE_EXPLORER_BASE_URL=https://stellar.expert/explorer/testnet
   pnpm --filter @astrowallet/pwa build
   cd apps/pwa && ../server/node_modules/.bin/wrangler pages deploy dist --project-name astrowallet --branch main
   ```

### Logical Next Session Options
1. **Custom Domain Attachment:** Connect a branded domain (e.g. `astrowallet.xyz`) to Cloudflare Pages and update `PWA_ORIGIN`, `ALLOWED_ORIGINS`, `VITE_API_BASE_URL`, `VITE_PWA_ORIGIN`, and the Telegram webhook URL.
2. **Real-Device E2E QA & Polish:** Walk through mobile PWA onboarding, Friendbot funding, multi-asset sends, Horizon path swaps, `@AstroWalletAppBot` `/connect` + `/pay` live intents, and Soroban contract invocations in **Dev Lab**, fixing any real-world edge cases discovered.
3. **SCF 7.0 Submission & Mainnet Cutover:** Finalize screenshots/demo links in [`docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](./SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) and execute Mainnet deployment + Audit Bank enrollment.
