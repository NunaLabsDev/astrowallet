# AstroWallet — Technical Feasibility, Optimization & 2026 Tooling Stack

This document captures the engineering verification of AstroWallet's four core pillars against real-world 2025–2026 browser/OS constraints, SDK capabilities, API access gates, and cost/performance trade-offs.

---

## Executive Feasibility Verdict

| Pillar | Feasible 100% Phone-First in 2026? | Critical Real-World Bottlenecks Discovered | Optimization / Workaround |
| :--- | :--- | :--- | :--- |
| **1. Multi-Account `G...` + Optional `C...` & Relayer** | **Yes** | `Launchtube` was retired/archived (Mar 2026). WebAuthn `prf` fails on external roaming keys & embedded `WKWebView`s, and FaceID is absent on many phones. `hash-wasm` Argon2id needs `'wasm-unsafe-eval'` CSP. | Use **SEP-0005** multi-account seed (`m/44'/148'/i'`) + mandatory **PIN/Passphrase (Argon2id Worker, `@noble/hashes` fallback)** + optional **Fingerprint** (`userVerification: "preferred"`). Pair optional `C...` via **`smart-account-kit`** (`v0.10.x`) + **`channels.openzeppelin.com`** (sponsors tx fees only, NOT Classic `CAP-33` reserves) with lazy deploy & `G...` Guardian. |
| **2. Classic + Soroban DeFi + SEP-24 Ramps** | **Yes (Phased Ramps)** | **MoneyGram Access** is strictly KYB/whitelist-only. **Kado** was acquired/wound down. **Soroswap Aggregator** free tier caps at `1 req/s` (`sk_` key). | Ship **Horizon Path Payments** + edge-proxied **Soroswap** in Phase 2, then **0-KYB Circle CCTP** (`CctpForwarder`) + **MoonPay/Transak** in v1 Phase 4; defer **Blend/DeFindex**, **BlindPay prod**, and **MoneyGram Access** to v2. |
| **3. Native "Scan & Shield" Pre-Sign** | **Yes** | `@stellar/stellar-xdr-json` WASM is **~3 MB** uncompressed. **Blockaid** is enterprise-gated (no free self-serve tier). `stellarscout.app` has no public API. Many SEP-1 `stellar.toml` domains lack CORS. | Decode natively with **`@stellar/stellar-sdk`** (`contract.Spec` SEP-46/47/48 + `SorobanAuthorizationEntry`) + Stellar RPC `xdrFormat: "json"`. Edge-proxy **StellarExpert Directory/Blocked Domains** + **SEP-1/29/42** + local drainer AST rules + **`@lumenwipe/sdk`** in v1; plug **Blockaid** in v2. |
| **4. Telegram-Exclusive Multichain Mini App (Stellar + TON)** | **Yes (ToS §7.3 Compliant)** | **Telegram ToS §7.3–7.4 requires TON Connect exclusivity** for external dApp links inside Mini Apps; clearing Telegram cache erases local WebView IndexedDB; raw `initDataUnsafe` is forgeable. | Verify `Telegram.WebApp.initData` server-side (`POST /v1/tg/auth`, HMAC-SHA256 + `auth_date <= 300s`), block open-browser access via `TelegramOnlyGate`, pair **Stellar (`G...`/`C...`) + TON (`WalletContractV4`/`V5R1`)** with **TON Connect v2** exclusively, use `BiometricManager` + device `SecureStorage` alongside Argon2id IndexedDB + `.agvault.json` backup reminders (zero `CloudStorage` secrets), and defer **Tangem NFC** to v2 **Capacitor**. |

---

## Pillar 1: Multi-Account `G...` + Optional `C...` Custody & Gas Sponsorship

### Verified Production Packages & Services
- **Ledger SDK:** `@stellar/stellar-sdk` **`17.x`** (ESM-first, requires Node `>= 22.12`).
- **Smart Accounts (Optional `C...` Pairing):** **`smart-account-kit`** (`v0.10.x`) + **`smart-account-kit-bindings`** (`v0.5.x`) on npm (`github.com/stellar/smart-account-kit`, note: *no* `@stellar/` npm scope), paired with **OpenZeppelin `stellar-contracts` (`packages/accounts` v0.8.0+)**.
  - *Alternative evaluated:* **`@soropass/core`** (`v0.3.1`, `soropass.dev`) is lighter (`@noble/curves` + `@noble/hashes` + Stellar Wallets Kit module), but lacks OpenZeppelin's audited **Context Rules + Policy** contracts (spending limits, session keys, weighted thresholds).
- **Gas Sponsorship Scope (Replacing Deprecated Launchtube):**
  - **`stellar/launchtube` was retired and archived in March 2026.**
  - **Production Replacement:** **`@openzeppelin/relayer-plugin-channels`** (`ChannelsClient`) proxied via `apps/server` (`/v1/relay`) to OpenZeppelin's **free managed service** (`https://channels.openzeppelin.com` for Mainnet; `https://channels.openzeppelin.com/testnet` for Testnet) with fair-use 24h stroop caps, OR self-hosting **`OpenZeppelin/openzeppelin-relayer`** (Rust/Actix-web + Docker + Redis, AGPL-3.0).
  - **Crucial Distinction (`Fees` vs `CAP-33 Reserves`):** Managed Channels sponsors **network transaction fees** (`submitSorobanTransaction` and `FeeBump`), **NOT Classic `G...` `CAP-33` base account reserves** (which lock `1+ XLM` of relayer capital per user and attract Sybil drain).
  - **Cost per Smart Account:** Deploying from a shared `wasm_hash` via `CreateContractV2` costs **< 0.01–0.05 XLM** once per active user (versus uploading WASM each time).

### Key Optimizations
1. **One SEP-0005 Seed → Multi-Account `G...` + Optional `C...` Recovery Guardian:** A single BIP-39 12/24-word mnemonic derives multiple indexed `G...` accounts (`m/44'/148'/0'`, `'1'`, `'2'`) with 100% portability to LOBSTR/Varial/Ledger/MetaMask, and registers the primary `G...` public key as an on-chain `Ed25519` **Recovery Guardian** for an optional `C...` Smart Account. Both roles stay clearly separated in UI with 1-tap `SAC` transfers between them.
2. **Counterfactual Lazy Deployment:** Precompute deterministic `C...` addresses (`deriveContractId` from deployer + credential hash/salt) so users can receive funds immediately, bundling `CreateContractV2` + `__constructor` into the user's **first outgoing transaction** (prevents empty-signup Sybil gas drain).
3. **Universal PIN Baseline + Optional Fingerprint (No FaceID Assumption):**
   - **Mandatory Universal Unlock:** Run **Argon2id** (`m=19456 KiB, t=2, p=1`) inside a **Web Worker** using **`hash-wasm`** (~11 KB gzipped, ~50–150 ms on mobile) with **`@noble/hashes/argon2`** (pure JS, ~200–500 ms) as automatic fallback if strict CSP (`'wasm-unsafe-eval'` disabled) or iOS Lockdown Mode blocks WASM.
   - **Optional Fingerprint Convenience:** Use standard WebAuthn (`userVerification: "preferred"`) for Touch ID / Android Fingerprint / screen lock. Never rely on WebAuthn `prf` as sole vault recovery or assume FaceID hardware exists.

---

## Pillar 2: Classic + Soroban DeFi + Real-World Fiat Ramps

### Verified DeFi Integrations & Trade-offs
| Protocol | Package / API | Access & Rate Limits | Role in AstroWallet |
| :--- | :--- | :--- | :--- |
| **Horizon Path Payments** | `@stellar/stellar-sdk` (`strictSendPaths` / `strictReceivePaths`) | **100% open, 0 API keys** | Zero-dependency baseline for atomic Classic SDEX & AMM swaps. |
| **Soroswap Aggregator** | `@soroswap/sdk` (`api.soroswap.finance`) | Requires `sk_` key; **1 req/s free tier** | Aggregates Soroswap, Aquarius, Phoenix, Sushi V3, Comet & SDEX; run behind Cloudflare Worker cache/proxy + supports USDC `platformFee`. *(Apache-2.0 self-hosted fallback: **LumAgg**).* |
| **Blend Capital v2/v2.1** | `@blend-capital/blend-sdk` | **100% permissionless, 0 API keys** | Direct RPC lending/yield fallback with zero backend dependency. |
| **DeFindex** | `@defindex/sdk` (`api.defindex.io`) | Requires `sk_` key (backend proxy) | Best 1-tap USDC auto-compounding yield (`dfTokens` over Blend + Soroswap) with partner yield-fee sharing. |

### Verified Fiat & Cross-Chain Ramp Sequencing (v1 vs v2)
- **v1 Immediate (Zero Corporate Gate / Fast Self-Serve):**
  1. **Circle CCTP on Stellar (0 KYB):** Permissionless 1:1 USDC bridging from Ethereum/Base/Arbitrum/Solana onto Stellar Soroban (`MessageTransmitterV2`, `TokenMessengerMinterV2`, **`CctpForwarder`**). *Implementation guard:* handle 6-to-7 decimal conversion and route recipients through `CctpForwarder` so strkeys don't get stuck.
  2. **MoonPay & Transak:** Both natively support **XLM and Stellar USDC** (cards, Apple Pay, Google Pay, bank transfers) with instant staging keys and self-serve dashboard KYB for production.
  3. **BlindPay (`blindpay.com`):** Fast developer sandbox for **Pix (BRL)** and **SPEI (MXN)** directly into Stellar USDC (requires corporate KYB for live prod).
  4. **Generic SEP-10 + SEP-24 Client:** Target open regional anchors from `stellar.org/anchor-directory` (e.g., **Anclap**, **AlfredPay**).
- **v2 Commercial Expansion:**
  - **MoneyGram Access (`developer.moneygram.com`):** Strictly whitelist-only (`stellar.toml` `client_domain` + corporate KYB + commercial contract). Plugs into our already-built MoneyGram Ramps SDK / SEP-24 module once approved.
  - **Avoid:** Legacy **Kado** (acquired by Swapped in 2025).

---

## Pillar 3: Native "Scan & Shield" Security Pipeline

### Bundle & Decoding Optimization
- **`@stellar/stellar-xdr-json` (`~3 MB` WASM uncompressed / `400–800 KB` gzipped):** **Do NOT bundle in initial PWA load.**
- **Fast Zero-WASM Primary Pipeline:**
  1. Use **`@stellar/stellar-sdk`** (`xdr.TransactionEnvelope`, `InvokeHostFunctionOp`, `SorobanAuthorizationEntry`, `scValToNative`) + **`contract.Spec`** (**SEP-46/47/48**) to decode human-readable operations, contract methods, arguments, and nested `subInvocations` in pure TypeScript.
  2. Call Stellar RPC **`simulateTransaction`** (optionally with `xdrFormat: "json"`) to compute `stateChanges` balance diffs, TTL/restore status, and `diagnosticEvents`.
  3. Only lazy-load `@stellar/stellar-xdr-json` inside a Web Worker if a power user opens a raw XDR inspector.

### Free v1 Threat Intelligence + v2 Enterprise Upgrade
1. **Cloudflare Worker Edge Proxy (Essential):** Proxy & cache **`api.stellar.expert/explorer/directory/{address}`** (`#malicious`, `#unsafe`, `#exchange`, `#anchor`), **`/directory/blocked-domains`**, and **SEP-1 `/.well-known/stellar.toml`** fetches at the edge (prevents mobile-carrier `429` throttling and fixes missing CORS headers on issuer domains).
2. **SDF SEP-42 Asset Lists (`https://assets.stellar.org`):** Verify official asset icons and issuers against fake `USDC` clones.
3. **SEP-29 (`config.memo_required`):** Auto-check destination account data entries and block/warn before sending without a Memo or `M...` muxed address to exchanges.
4. **Local Drainer Heuristics:** Hard-warn on `setOptions` signer/threshold changes, `accountMerge`, unexpected `changeTrust`, and Soroban recursive `subInvocations` requesting large/unlimited `approve` or `transfer_from`.
5. **Account Hygiene (`@lumenwipe/sdk`):** Open-source (Apache-2.0, free 120 req/min API) to safely unwind Classic + Soroban DeFi positions and reclaim locked XLM reserves.
6. **Claimable Balance Spam Shield:** Filter/hide unsolicited claimable balances from unverified or `#malicious` issuers by default.
7. **v2 Upgrade — Blockaid (`@blockaid/client`):** Commercial/enterprise API (`client.stellar.transaction.scan`) — integrate once funded by SCF #47.

### Post-Horizon History, Portfolio & Real-Time Push APIs (2026 Free Tiers)
Because **Horizon is in maintenance/EOL mode** (1-year public cap) and **Stellar RPC** retains ~7 days, separate **read history** from **real-time push alerts**:
- **Real-Time Telegram Alert Ingestion (`POST /webhooks/indexer`):**
  - **Alchemy does NOT provide Notify push webhooks for Stellar** (only EVM/Solana); use Alchemy strictly for RPC / Portfolio reads (`30M CU/month` free `balances`, `nfts`, `transfers`).
  - **Primary Push Stream:** **Goldsky Turbo Pipelines** (free Starter `$0/mo + $100 intro credit`, native Stellar `transfers` / `operations` / `events` streams) or **Mercury** webhooks (`mercurydata.app`, free Dev tier).
  - **Testnet / Self-Hosted Fallback:** `CHAIN_WATCHER` **Cloudflare Durable Object** inside `apps/server` polling Stellar RPC ledger cursors for D1-registered addresses.

---

## Pillar 4: Telegram-Exclusive Multichain Mini App & Storage Safety

### Real-World Telegram WebView & Storage Matrix
| Surface / Storage Layer | Real Behavior Inside Telegram Mini App | AstroWallet Safeguard |
| :--- | :--- | :--- |
| **Telegram Mini App WebView (`IndexedDB`)** | Consistent single origin inside Telegram per client, but **erased if user clears Telegram app cache** or reinstalls | Mandatory offline 12-word recovery quiz + encrypted `.agvault.json` export reminder (`IosBrowserGuard`) |
| **`Telegram.WebApp.CloudStorage`** | Synced to Telegram servers — **unsuitable for non-custodial key material** | **Strictly forbidden** for mnemonics, PINs, or private keys (`AGENTS.md` Rule 4 & Rule 7) |
| **Telegram `BiometricManager` & Bot API 9.0 `SecureStorage`** | Hardware-backed iOS Keychain / Android Keystore unlock inside Telegram without WebAuthn AASA constraints | Used strictly as convenience unlock for local vault PIN with standard WebAuthn + universal Argon2id PIN fallback |
| **External dApp Connections (ToS §7.3–7.4)** | Multichain Mini Apps may manage Stellar + TON internally, while external dApp connections must use **TON Connect** | Isolated `@astrowallet/ton-core` + **TON Connect v2** NaCl SSE bridge; zero `window.stellar` or non-TON external dApp connectors |

### Resulting Mini App Design Rules
1. **100% Telegram-Exclusive Entry & Cryptographic Auth:**
   - Remove standalone public landing pages; `TelegramOnlyGate` permits entry only after `POST /v1/tg/auth` verifies `Telegram.WebApp.initData` (HMAC-SHA256, `auth_date <= 300s`) and mints a 15-minute session Bearer token (with `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM=true` restricted solely to local Testnet dev).
   - Private chats launch `web_app` buttons directly; group/inline cards use `https://t.me/<bot>[/<short_name>]?startapp=i-<intentId>-<sig>` and `startapp=t-<tab>`.
2. **Telegram Super-Bot as Social & Real-Time Push Layer (`apps/server`):**
   - `grammY` (`webhookCallback(bot, "cloudflare-mod")`) + Hono + D1/KV on Cloudflare Workers powers `/connect`, `/pay`, `/request`, `/split`, `/scan`, `/swap`, `/alerts`, `/reserve`, Claim Links V2, and live chat card updates.
   - `POST /v1/tg/link-challenge` and `/v1/tg/link-confirm` also allow 1-tap wallet linking inside the Mini App bound directly to the authenticated `telegram_user_id`.
3. **Ecosystem Hardware Roadmap (v2):**
   - **v2 Native Shell (Capacitor):** Only if shipping a standalone native app for **Tangem NFC** (`tangem-sdk-ios` ISO 7816 APDU, unavailable in WebKit Web NFC).
