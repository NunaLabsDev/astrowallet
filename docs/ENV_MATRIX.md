# AstroWallet — Environment & Network Configuration Matrix

> Extracted from [`AGENTS.md`](../AGENTS.md) and verified against [`packages/domain/src/config.ts`](../packages/domain/src/config.ts) (`parsePwaConfig`, `parseServerConfig`). Nothing uses silent fallback URLs in production mode.
>
> Templates: [`apps/pwa/.env.example`](../apps/pwa/.env.example) | [`apps/server/.dev.vars.example`](../apps/server/.dev.vars.example) | [`apps/server/wrangler.toml`](../apps/server/wrangler.toml)

---

## A. Client Public Config (`apps/pwa` — `VITE_*` prefix only; zero secrets)

| Variable | Testnet Example Value | Mainnet Example Value | Notes |
| :--- | :--- | :--- | :--- |
| `VITE_STELLAR_NETWORK` | `testnet` | `mainnet` | Controls badge & network passphrase coherence |
| `VITE_STELLAR_NETWORK_PASSPHRASE` | `Test SDF Network ; September 2015` | `Public Global Stellar Network ; September 2015` | Passed directly to `@stellar/stellar-sdk` |
| `VITE_STELLAR_RPC_URLS` | Comma-separated RPC endpoints | Comma-separated RPC endpoints | Primary + failover array (HTTPS required on mainnet) |
| `VITE_HORIZON_URLS` | Comma-separated Horizon endpoints | Comma-separated Horizon endpoints | Failover array for Classic ops |
| `VITE_API_BASE_URL` | `https://api-testnet.astrowallet.example` | `https://api.astrowallet.example` | Points to `apps/server` Worker |
| `VITE_PWA_ORIGIN` | `https://testnet.astrowallet.example` | `https://app.astrowallet.example` | WebAuthn `rpId` origin anchor |
| `VITE_TG_BOT_USERNAME` | `AstroWalletAppBot` | `AstroWalletBot` | Deep-link builder only |
| `VITE_TG_MINI_APP_SHORT_NAME` | `wallet` | `wallet` | BotFather Mini App short name (`t.me/<bot>/<short_name>`) |
| `VITE_ASTRODEX_BOT_USERNAME` | `AstroDexBot` | `AstroDexBot` | Optional Boomerang return & Token Explorer pro link target |
| `VITE_ASTRODEX_MINI_APP_SHORT_NAME` | `dex` | `dex` | Optional AstroDex Mini App short name (`t.me/<bot>/<short_name>`) |
| `VITE_ASTROGATE_BOT_USERNAME` | `AstroGateSorobanBot` | `AstroGateBot` | Optional Boomerang return link for AstroGate-origin intents |
| `VITE_TON_NETWORK` | `testnet` | `mainnet` | Defaults to `VITE_STELLAR_NETWORK` |
| `VITE_TON_RPC_URLS` | Comma-separated TON RPC URLs | Comma-separated TON RPC URLs | Toncenter JSON-RPC v2 endpoints (HTTPS on mainnet) |
| `VITE_TON_BRIDGE_URL` | TON Connect SSE bridge URL | TON Connect SSE bridge URL | TON Connect v2 encrypted bridge (`https://...`) |
| `VITE_TON_EXPLORER_BASE_URL` | Testnet TON explorer URL | Mainnet TON explorer URL | Optional transaction/address explorer link |
| `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM` | `false` (or `true` locally) | *(forbidden: must be `false`)* | Zod rejects if `true` when `mainnet` |
| `VITE_FRIENDBOT_URL` | `https://friendbot.stellar.org` | *(unset — forbidden on mainnet)* | Zod rejects if set when `mainnet` |
| `VITE_SMART_ACCOUNT_WASM_HASH` | Testnet OZ account WASM hash | Mainnet audited OZ WASM hash | Enables counterfactual `C...` |
| `VITE_CLAIM_ESCROW_CONTRACT_ID` | Testnet escrow `C...` | Mainnet audited escrow `C...` | Claim-Link Escrow contract |
| `VITE_SOROBITS_CONTRACT_ID` | Sorobits SEP-50 `C...` | Mainnet Sorobits `C...` | Optional on-chain NFT showcase |
| `VITE_SEP42_ASSET_LIST_URLS` | Verified testnet SAL JSON URLs | SDF `assets.stellar.org` SAL JSON URLs | Anti-spoof token registry |
| `VITE_SOROBAN_MAX_RESOURCE_FEE_STROOPS` | `5000000` | `5000000` | Client resource fee cap (default `5000000`) |
| `VITE_EXPLORER_BASE_URL` | `https://stellar.expert/explorer/testnet` | `https://stellar.expert/explorer/public` | Optional Stellar explorer base |
| `VITE_SOROBITS_EXPLORER_URL` | Optional NFT explorer base | Optional NFT explorer base | Optional Sorobits explorer link |
| `VITE_CCTP_BRIDGE_URL` / `VITE_CCTP_FORWARDER_CONTRACT_ID` | Optional CCTP config | Optional CCTP config | In-app Circle CCTP 6↔7 USDC precision validator |
| `VITE_REOWN_PROJECT_ID` / `VITE_MOONPAY_WIDGET_URL` / `VITE_TRANSAK_WIDGET_URL` | *(legacy / disabled in Mini App)* | *(disabled in Mini App)* | Retained for schema compatibility only; disabled under ToS §7.3–7.4 |

---

## B. Server Worker Env & Secrets (`apps/server` — Cloudflare `wrangler.toml` + `wrangler secret`)

| Binding / Secret | Type | Purpose |
| :--- | :--- | :--- |
| `STELLAR_NETWORK` / `STELLAR_NETWORK_PASSPHRASE` | Env Var | Must match `apps/pwa` network (validated on every `/v1/*` call) |
| `STELLAR_RPC_URLS` / `HORIZON_URLS` | Env Var | Comma-separated RPC & Horizon endpoints for simulation, poller, and `/scan` |
| `PWA_ORIGIN` / `ALLOWED_ORIGINS` | Env Var | Strict CORS allowlist + Mini App URL builder |
| `TELEGRAM_API_ORIGIN` / `TG_BOT_USERNAME` / `TG_MINI_APP_SHORT_NAME` | Env Var | Telegram Bot API origin + `t.me/<bot>/<short_name>?startapp=...` link builder |
| `FRIENDBOT_URL` | Env Var | Optional on `testnet`; **Zod rejects if set when `STELLAR_NETWORK=mainnet`** |
| `STELLAR_EXPERT_API_BASE` | Env Var | Base URL for Open Directory / blocked domains proxy |
| `OZ_CHANNELS_API_URL` | Env Var | `https://channels.openzeppelin.com/testnet` or `https://channels.openzeppelin.com` |
| `SOROSWAP_API_BASE` | Env Var | Soroswap aggregator API base URL |
| `SEP42_ASSET_LIST_URLS` / `CLAIM_ESCROW_CONTRACT_ID` / `SMART_ACCOUNT_WASM_HASH` | Env Var | Server-side SEP-42 lists, escrow `C...`, and smart account WASM hash verification |
| `RELAY_ALLOWED_CONTRACTS` | Env Var | Comma-separated `C...` allowlist enforced by `/v1/relay/submit` |
| `RELAY_RATE_LIMIT_PER_MIN` / `PROXY_RATE_LIMIT_PER_MIN` | Env Var | Rate-limit thresholds (defaults: `10`, `60`) |
| `RELAY_MAX_OPERATIONS` / `RELAY_MAX_FEE_STROOPS` / `RELAY_DAILY_BUDGET_STROOPS` | Env Var | Policy caps (defaults: `5`, `2000000`, `500000000` stroops) |
| `DB` | Cloudflare D1 | Users (`telegram_user_id` PK), linked addresses, intents, claim links, `rate_limits`, `relay_daily_usage`, `processed_tg_updates`, `encrypted_vault_backups` |
| `CACHE` | Cloudflare KV | Edge-cached StellarExpert tags, `stellar.toml` fetches, SEP-42 lists, rate-limit fallback |
| `CHAIN_WATCHER` | Durable Object | Lightweight Stellar RPC/Horizon cursor poller fallback for Testnet real-time alerts |
| `TG_BOT_TOKEN` | Secret | Telegram Bot API token (`grammY` + `initData` HMAC verification) |
| `TG_WEBHOOK_SECRET` | Secret | Verifies `X-Telegram-Bot-Api-Secret-Token` header on `/tg/webhook` |
| `INTENT_HMAC_SECRET` | Secret | Signs & verifies Intent Tokens (`<= 5 min` TTL) and Mini App session tokens (`15m` TTL) |
| `OZ_CHANNELS_API_KEY` | Secret | Rate-limited OpenZeppelin Channels sponsorship key |
| `SOROSWAP_API_KEY` | Secret | Proxied `sk_` key (never exposed to browser) |
| `INDEXER_WEBHOOK_SECRET` | Secret | Verifies Goldsky Turbo Pipeline / Mercury webhook signatures on `/webhooks/indexer` |
| `ECOSYSTEM_SHARED_INTENT_SECRET` | Secret | Authenticates server-to-server `POST /v1/intents/external` & `official` AstroConnect requests (`>= 32` chars) |
| `CONNECT_VERIFIED_BOTS` | Env Var | Optional comma-separated list of verified third-party Telegram bot usernames (`verified` trust tier in AstroConnect v1) |
