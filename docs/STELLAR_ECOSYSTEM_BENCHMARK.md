# Stellar Ecosystem Benchmark: Wallets, Scans & Protocols (2014–2026)

This document synthesizes verified research across the Stellar wallet ecosystem, block explorers ("scans"), security scanners, and Stellar Community Fund (SCF 7.0) patterns as of **November 2026**.

---

## 1. Historical & Modern Stellar Wallet Inventory (2014–2026)

### A. Early & Legacy Wallets (Key Lessons)
| Wallet | Era / Author | What Happened & Key Lesson |
| :--- | :--- | :--- |
| **Stellar Account Viewer** | 2015–present (SDF) | Minimalist balance/payment viewer (`accountviewer.stellar.org`). Deprecated raw `S...` browser entry in favor of Ledger/Trezor, Albedo, and Freighter/Varial; developer ops moved to **Stellar Lab** (`lab.stellar.org`). |
| **Centaurus** | 2015–2016 (Tobias Latzke) | First open-source Android Stellar wallet (Ionic/Cordova). Unmaintained; incompatible with modern Horizon/Soroban. |
| **Stargazer** | 2016–2019 (Future Tense) | Desktop/mobile wallet, officially archived June 11, 2022. |
| **BlackWallet** | 2017–Jan 2018 | **Critical Security Lesson:** Hosting/DNS hijack redirected web traffic to a malicious clone and stole **669,920 XLM (~$400K–$440K)** from users entering raw `S...` keys in a server-hosted web wallet. Catalyzed client-side key isolation and delegated signers. |
| **Keybase Stellar** | Sep–Dec 2019 (SDF) | **Sybil Lesson:** "Space Drop" (2B XLM budget) halted after 3 months (~300M XLM) due to automated Sybil bot farms bypassing lightweight social checks. |
| **Solar Wallet** | 2019–2022 (SatoshiPay) | 100% open-source multisig + SEP-6 wallet (`satoshipay/solar`). Stalled after SatoshiPay pivoted to Pendulum. |
| **Vibrant → Vesseo** | 2020–present (Sunship/SDF) | Grew 282% MAU in LatAm (2023–2024); rebranded to **Vesseo** (`vesseoapp.com`) in Apr 2025 to add virtual US bank rails and cards; sunset USDC Rewards loyalty yield in Jan 2026. |

### B. Current Dominant & Recommended Wallets (2024–2026)
- **LOBSTR + LOBSTR Vault + Tangem (`lobstr.co`)** — *Largest dedicated Stellar client base*: **1M+ Google Play downloads (~4.6–4.7★)**, hybrid encrypted keystore, `user*lobstr.co` Federation, built-in SDEX/AMM swaps, MoneyGram & MoonPay virtual accounts, **LOBSTR Vault** `M`-of-`N` multisig, and **Tangem NFC** tap-to-sign hardware cards. *Gaps:* Soroban WalletConnect/extension app-switching friction inside mobile WebViews; passkeys use WebAuthn PRF only to encrypt a classic `G...` keystore (not on-chain smart accounts).
- **Varial (formerly Freighter, `varialwallet.com`)** — *SDF Flagship (rebranded Oct 29, 2026)*: Browser extension + iOS/Android, first-class Soroban `signAuthEntry`, **Discover** dApp directory, **Blockaid** malicious transaction blocking, `M...` muxed history, claimable balance spam filtering, Ledger support, and planned Blend Earn + EVM-to-Stellar USDC deposits (`@stellar/varial-sdk`).
- **xBull (`xbull.app`)** — *Power-user & open-source leader (Creit Tech)*: Extension + Mobile + **installable PWA**, Ledger + Trezor support, full Classic SDEX/AMM/Path Payments, custom Horizon/RPC endpoints, and XDR lab. Authors of **Stellar Wallets Kit** (`stellarwalletskit.dev`).
- **Albedo (`albedo.link`)** — *By OrbitLens / StellarExpert*: Delegated browser intent popups + `web+stellar:` SEP-7 signing without requiring extensions.
- **Rabet & Hana (`hanawallet.io`)** — Open-source Stellar extension (Rabet) and 20-chain extension/mobile wallet (Hana) integrated into Stellar Wallets Kit.
- **Beans (`beansapp.com`), Decaf (`decaf.so`), Meru (`getmeru.com`)** — *Consumer Neobanks & LatAm Rails*: Seedless UX, sponsored fees/reserves, **SEP-24 MoneyGram** cash-in/out across 180+ countries, Pix/SPEI/ACH/SEPA rails, Visa cards, and abstracted Blend/DeFindex yield. *Gap:* Closed consumer silos lacking open dApp/WalletConnect parity.
- **MetaMask Native Stellar (Oct 29, 2026)** — Announced at Meridian 2026 Lisbon; integrates Stellar natively across Mobile & Extension from the user's SRP (XLM, trustlines, Soroban tokens).
- **Telegram / Chat / Smart Passkey Wallets**:
  - **Walt (`@walt`, formerly Wallet in Telegram, rebranded Sep 2026)**: Added XLM & Stellar USDC P2P transfers (Aug–Oct 2025) for 100M+ users, but lacks Soroban DeFi, Soroswap, custom trustlines, and self-custodial classic/smart controls.
  - **HOT Wallet (`hot-labs.org`)**: Multi-chain wallet abstracting Stellar reserve activation and routing through Aquarius/Soroswap.
  - **SoroPass (`soropass.dev`)**, **Sollpay (`sollpay.com`)**, **JUMPA (`usejumpa.com`)**, **Strooper**: Seedless ZK / Protocol 21 `secp256r1` passkey smart accounts and chat-native (Telegram/WhatsApp/USSD) onboarding.

---

## 2. Feature & Protocol Matrix (2026 Standard)

### Classic Stellar (`G...` EOAs)
- **Reserves & Lifecycle:** Minimum balance `= (2 + subentries + sponsoring - sponsored) * 0.5 XLM`; `createAccount` detection (`>= 1 XLM`); **CAP-33 Sponsored Reserves** (`beginSponsoringFutureReserves` / `endSponsoringFutureReserves`); `accountMerge` reserve-recovery wizard.
- **Exchange Safety:** **CAP-27 Muxed Accounts (`M...`)** + typed Memos (`TEXT`, `ID`, `HASH`, `RETURN`) + mandatory CEX memo enforcement.
- **Assets & Compliance:** `changeTrust` reserve previews, **CAP-23 Claimable Balances** with automatic dust/phishing spam filtering, asset flags (`AUTH_REQUIRED`, `AUTH_REVOCABLE`, `AUTH_IMMUTABLE`, `AUTH_CLAWBACK_ENABLED`), **SEP-1** `stellar.toml` verification.
- **Liquidity & Multisig:** `pathPaymentStrictSend` / `pathPaymentStrictReceive`, SDEX `manageSellOffer`/`manageBuyOffer`, CAP-38 Classic AMMs (`2 subentries` = `1 XLM`), weighted `M`-of-`N` multisig, **CAP-15 Fee-Bump** transactions.

### Soroban & Smart Accounts (Protocol 20–23+)
- **Execution & Simulation:** `InvokeHostFunctionOp`, `SorobanAuthorizationEntry` (`signAuthEntry`), Protocol 21–23 state archival/TTL rent handling (including Protocol 23 automatic restore via RPC simulation).
- **Smart Accounts (`C...`):** Custom `__check_auth` contracts using **Protocol 21 CAP-0051 (`secp256r1` WebAuthn)**, **OpenZeppelin `stellar-contracts` (`packages/accounts`)** modular **Signers + Context Rules + Policies** (spending limits, session keys, guardian recovery), and **OpenZeppelin Relayer + Stellar Channels** for zero-XLM gas sponsorship (replacing deprecated Launchtube).
- **DeFi & Standards:** SEP-41 tokens, SEP-50 NFTs, **Soroswap** (AMM + Aggregator), **Blend**, **DeFindex**, **Aquarius**.

### Ecosystem Interoperability
- **SEP-0005** (BIP-39 12/24-word + SLIP-0010 `m/44'/148'/i'`), **SEP-0002** (Federation), **SEP-0007** (`web+stellar:`), **SEP-0010** (Web Auth), **SEP-0012** (KYC), **SEP-0024 / 0006 / 0038** (Anchors & RFQ quotes), **SEP-0042** (Asset Lists), **SEP-0043 / 0060** (Web Wallet API & Discovery), **WalletConnect v2** (`stellar:pubnet`, `stellar:testnet`, `stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signAuthEntry`, `stellar_signMessage`), and **Stellar Wallets Kit** `ModuleInterface`.

---

## 3. Stellar "Scans", Explorers, Indexers & Security Tools

| Tool / Service | Category | What It Provides to AstroWallet |
| :--- | :--- | :--- |
| **StellarExpert** (`stellar.expert` / `api.stellar.expert`) | Premier Classic + Soroban Explorer & Directory | Open Directory threat tags (`malicious`, `unsafe`, `exchange`, `anchor`), `/directory/blocked-domains`, Asset Trust Ratings (fights fake `USDC`), OHLCV/market analytics, Soroban WASM/storage inspection (`/contract`, `/contract-state`). |
| **Stellar Lab** (`lab.stellar.org`) | Official SDF Tx & Contract Studio | Reference for `@stellar/stellar-xdr-json` XDR↔JSON decoding, SEP-48 contract spec UI, and `simulateTransaction` footprints. |
| **StellarChain** (`stellarchain.io`) | Active Classic + Soroban Explorer | Real-time web explorer for accounts, txs, assets, LPs, and Soroban contracts. |
| **Lumenscan / Steexp** | Legacy / Lightweight Explorers | `lumenscan.io` is discontinued as a primary explorer; `steexp.com` (`chatch/stellarexplorer`) is a classic Horizon UI predating Soroban. |
| **SorobanScan / SoroScan** | Soroban-Native Explorers | **SorobanScan** (`sorobanscan.com`, Galexie + Rust + ClickHouse) & **SoroScan** (`soroscan.io`, open-source Go + TimescaleDB) decode Soroban invocations, storage diffs, and DeFi activity. |
| **Mercury / Goldsky / Galexie / Hubble** | Production Indexers & Data Pipelines | **Horizon is in maintenance/EOL mode (1-year public limit)** and Stellar RPC retains ~7 days. Production wallets use **Mercury** (GraphQL/Retroshades/Zephyr), **Goldsky Turbo Pipelines**, Managed Portfolio APIs, or self-hosted **Galexie** + **Hubble** (BigQuery). |
| **Blockaid** (`blockaid.io`) | Pre-Sign Threat Scanner | `client.stellar.transaction.scan(...)` simulates Classic + Soroban XDRs to flag drainers (`setOptions` signer hijack, `accountMerge` traps, rogue approvals) and phishing domains (`benign`/`warning`/`malicious`). |
| **Stellar Scout & Security Portal** | Token Safety & Contract Audits | **Stellar Scout** (`stellarscout.app`) flags mint/freeze/clawback risk, holder concentration, and `stellar.toml` validity; **Stellar Security Portal** catalogs Soroban audits. |
| **LumenWipe** (`lumenwipe.com`, SCF #44 RFP) | Account Hygiene / Exit Tool | Open-source Web App, REST API & TS SDK unwinding both Classic subentries and Soroban DeFi positions (Blend, Aquarius, Soroswap) for safe `ACCOUNT_MERGE`. |

---

## 4. Unsolved Opportunity & SCF 7.0 Fit

No single Stellar wallet today cleanly combines:
1. **Master SEP-0005 Multi-Account Seed (`G...` Classic/SDEX/LOBSTR-portable) + Optional Paired Smart Account (`C...` via `smart-account-kit` + OpenZeppelin Channels gaslessness & `G...` Guardian)**,
2. **Universal Phone-First Auth** (mandatory Argon2id PIN/Passphrase + optional Fingerprint—zero FaceID requirement) wrapped in an **Apple Liquid Glass UI & Astro Navigators** visual system,
3. **Zero-WASM Pre-Sign Scan & Shield** (`@stellar/stellar-sdk` + `contract.Spec` decoder + RPC simulation + StellarExpert Directory + SEP-42/29 + lazy Raw XDR Worker, with pluggable v2 Blockaid), and
4. **Genuine Telegram Super-Bot Social Layer** (ToS-compliant standard bot + Inline Mode + Signed Intents + live card editing + viral Claim Links).

Positioning AstroWallet as an **SCF 7.0 Integration Track** project composing **OpenZeppelin Smart Accounts & Channels + Soroswap + StellarExpert/SEP-42 + v1 Self-Serve CCTP/Ramps** avoids Open Track NQG voting volatility, aligns strictly with SCF's composability rules, and unlocks **Soroban Security Audit Bank** coverage (up to 100% audit cost reimbursement after the 5% refundable co-payment).
