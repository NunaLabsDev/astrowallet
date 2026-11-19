# AstroWallet — Next Session Handoff Guide

> **Current Status:** **Phases 0–4**, the official Stellar Landing Website (`/`), the bank-grade Liquid Glass Wallet App (`/app`), animated crisp-pixel Navigators, live Sorobits SEP-50 integration, Cloudflare live Testnet deployment, and Telegram Super-Bot webhook are **100% live and verified** (`73` Vitest tests + `2` Soroban Rust tests passing).

---

## 1. Live Testnet Deployment & Provisioned Infrastructure

| Component | Live Value |
| :--- | :--- |
| **Official Website (Landing Showcase)** | `https://astrowallet-b1o.pages.dev/` |
| **Fintech Wallet App (PWA `/app` + Bot `/intent/*`)** | `https://astrowallet-b1o.pages.dev/app` |
| **Worker Service Name (`workers_dev = false`)** | `astrowallet-server` (bound via `ASTROWALLET_SERVER` to Pages Functions) |
| **Health Check** | `https://astrowallet-b1o.pages.dev/health` |
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
- **Banking-Trust Website (`/`) + Fintech Wallet App (`/app`) (`apps/pwa` & `packages/stellar-core`):**
  - 60/30/10 Sovereign Navy / Frosted Amethyst / Vault Gold palette, `LandingPage.tsx` at `/` (live `/health` telemetry, interactive 6-state Navigator preview, honest `G...` vs `C...` comparison, `@AstroWalletAppBot` preview, and live on-chain `fetchSorobitShowcase`), and `/app` Wallet Shell (desktop sidebar + mobile icon dock, 2-step guided onboarding with `3×4` seed grid, uncluttered Wallet balance hero + quick actions + `ModalDrawer` tool sheets, and multi-token `CollectiblesSheet` showcase grid).
  - Custody posture strip (`Self-Custodial SEP-0005 · Argon2id IndexedDB · 0 Server Keys`), `32×32` crisp-pixel `AstroWalletLogo` & `favicon.svg`, and `32×32` pixel `AstroNavigatorAvatar` across 6 animated behavioral states (`float`, `shield`, `warp`, `vault`, `comms`, `zenith`).

---

## 3. Mainnet Promotion & SCF 7.0 Checklist

1. **SCF 7.0 Integration Track & Soroban Security Audit Bank:**
   - Submit [`docs/SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](./SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) with the live demo at `https://astrowallet-b1o.pages.dev` and `@AstroWalletAppBot`.
2. **Mainnet Cutover (Env-Only, Zero Code Changes):**
   - Deploy audited `contracts/claim-escrow` to Stellar Mainnet and enroll in Soroban Security Audit Bank.
   - Create dedicated Mainnet Cloudflare D1/KV (`astrowallet-mainnet`), set `STELLAR_NETWORK=mainnet`, remove `FRIENDBOT_URL` / `VITE_FRIENDBOT_URL`, configure Mainnet RPC/Horizon/API origins, and rotate `TG_BOT_TOKEN` / `TG_WEBHOOK_SECRET` / `INTENT_HMAC_SECRET`.
