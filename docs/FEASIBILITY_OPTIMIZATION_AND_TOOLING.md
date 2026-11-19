# AstroWallet — Technical Feasibility, Optimization & 2026 Tooling Stack

This document captures the engineering verification of AstroWallet's four core pillars against real-world 2025–2026 browser/OS constraints, SDK capabilities, API access gates, and cost/performance trade-offs.

---

## Executive Feasibility Verdict

| Pillar | Feasible 100% Phone-First in 2026? | Critical Real-World Bottlenecks Discovered | Optimization / Workaround |
| :--- | :--- | :--- | :--- |
| **1. Multi-Account `G...` + Optional `C...` & Relayer** | **Yes** | `Launchtube` was retired/archived (Mar 2026). WebAuthn `prf` fails on external roaming keys & embedded `WKWebView`s, and FaceID is absent on many phones. `hash-wasm` Argon2id needs `'wasm-unsafe-eval'` CSP. | Use **SEP-0005** multi-account seed (`m/44'/148'/i'`) + mandatory **PIN/Passphrase (Argon2id Worker, `@noble/hashes` fallback)** + optional **Fingerprint** (`userVerification: "preferred"`). Pair optional `C...` via **`smart-account-kit`** (`v0.10.x`) + **`channels.openzeppelin.com`** (sponsors tx fees only, NOT Classic `CAP-33` reserves) with lazy deploy & `G...` Guardian. |
| **2. Classic + Soroban DeFi + SEP-24 Ramps** | **Yes (Phased Ramps)** | **MoneyGram Access** is strictly KYB/whitelist-only. **Kado** was acquired/wound down. **Soroswap Aggregator** free tier caps at `1 req/s` (`sk_` key). | Ship **Horizon Path Payments** + edge-proxied **Soroswap** in Phase 2, then **0-KYB Circle CCTP** (`CctpForwarder`) + **MoonPay/Transak** in v1 Phase 4; defer **Blend/DeFindex**, **BlindPay prod**, and **MoneyGram Access** to v2. |
| **3. Native "Scan & Shield" Pre-Sign** | **Yes** | `@stellar/stellar-xdr-json` WASM is **~3 MB** uncompressed. **Blockaid** is enterprise-gated (no free self-serve tier). `stellarscout.app` has no public API. Many SEP-1 `stellar.toml` domains lack CORS. | Decode natively with **`@stellar/stellar-sdk`** (`contract.Spec` SEP-46/47/48 + `SorobanAuthorizationEntry`) + Stellar RPC `xdrFormat: "json"`. Edge-proxy **StellarExpert Directory/Blocked Domains** + **SEP-1/29/42** + local drainer AST rules + **`@lumenwipe/sdk`** in v1; plug **Blockaid** in v2. |
| **4. Mobile PWA + Telegram Super-Bot Handoff** | **Yes (with iOS Storage Guard)** | **iOS isolates `IndexedDB` between Safari/`SFSafariViewController` and the installed Home Screen PWA.** Telegram `WKWebView` blocks WebAuthn Passkeys/Fingerprint without AASA entitlements (`openLink()` only exists in TMAs). Web NFC does not exist on iOS. | Keep Telegram as **pure Bot + Inline Mode (`grammY` in `apps/server`)** using `InlineKeyboardButton({ url })` + HMAC-signed Intent links (zero TMA, zero TON dependency). On iOS, guide **"Add to Home Screen" before local seed creation**, always allow **PIN fallback** in-browser, offer "Open in Safari/Chrome for Fingerprint", and defer **Tangem NFC** to v2 **Capacitor**. |

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

## Pillar 4: Mobile PWA, iOS Partitioning & Telegram Super-Bot Handoff

### Critical iOS vs Android Browser Storage Reality
| Surface Pair | iOS Behavior (iOS 17–26) | Android Behavior |
| :--- | :--- | :--- |
| **Telegram `WKWebView` ↔ Safari / PWA** | **Completely Isolated** (sandboxed inside Telegram app) | Shared *only* if Telegram opens Chrome Custom Tabs (isolated in internal WebView) |
| **Safari / `SFSafariViewController` ↔ Installed Home Screen PWA** | **COMPLETELY PARTITIONED (`IndexedDB` & `localStorage` do NOT share!)** | **Shared** (Android WebAPK PWA uses Chrome's profile storage) |
| **Safari ↔ Home Screen PWA for iCloud Passkeys (`secp256r1`)** | **SHARED seamlessly via iCloud Keychain** (bound to RP ID / domain) | **Shared via Google Password Manager / Credential Manager** |
| **Telegram `WKWebView` WebAuthn (Fingerprint / Passkeys)** | **FAILS (`NotAllowedError`)** (Telegram lacks your domain's AASA `webcredentials` entitlement) | Unreliable / often blocked in embedded WebViews |

### Resulting Mobile-First UX Design Rules
1. **iOS Onboarding Flow ("Install First + Universal PIN Fallback"):**
   - Never let an iOS user generate an unbacked `IndexedDB` SEP-0005 seed in a regular Safari tab and then tell them to "Add to Home Screen" — the Home Screen PWA will show an empty `IndexedDB`.
   - **Solution:** On iOS Safari, prompt **"Add to Home Screen" first** (Home Screen PWAs are exempt from WebKit's 7-day ITP eviction cap and preserve `navigator.storage.persist()`), offer **encrypted `AGVAULT` transfer files** for device migration, and optionally pair a `C...` Smart Account whose **Fingerprint (`secp256r1`)** signer works across Safari and Home Screen PWA while **PIN/Passphrase** remains a universal fallback everywhere.
2. **Telegram Super-Bot as Zero-Install Push & Social Layer:**
   - Build **`apps/server`** (`/tg/webhook`) using **`grammY` (`webhookCallback(bot, "cloudflare-mod")`)** + Hono + D1/KV on Cloudflare Workers for instant push alerts, `@username` cryptographic binding (`/connect` keyed by immutable `telegram_user_id`), inline P2P & swaps, viral **Claim Links**, and live card editing.
   - Use standard **`InlineKeyboardButton({ url })`** pointing to server-issued HMAC-signed 5-min Intent URLs (never Mini App SDK APIs or TMA WebViews, keeping zero keys in Telegram `CloudStorage` and 100% exemption from Telegram's Jan 2025 TON-exclusivity rules).
   - **iOS In-App Browser Handoff:** Because standard Telegram URL buttons may open inside Telegram's embedded browser on iOS, the PWA Intent landing sheet immediately detects embedded WebViews and provides: (a) **"Confirm with PIN now"** (universal fallback), plus (b) **"Open in Safari / Chrome for Fingerprint"** with 1-tap URL copy/external launch guidance.
3. **Ecosystem dApp & Hardware Roadmap:**
   - **v1 PWA Connectivity (Phase 3):** Expose **`@creit-tech/stellar-wallets-kit` v2** (JSR `@creit-tech/stellar-wallets-kit`) module + **Reown AppKit (`@reown/appkit-adapter-stellar`)** WalletConnect v2 responder + **SEP-43/SEP-60** interface.
   - **v2 Native Shell (Capacitor):** Wrap `apps/pwa` with **Capacitor** only when adding native **iOS Keychain / Android Keystore** and **Tangem NFC** (`tangem-sdk-ios` ISO 7816 APDU, impossible in WebKit Web NFC).
