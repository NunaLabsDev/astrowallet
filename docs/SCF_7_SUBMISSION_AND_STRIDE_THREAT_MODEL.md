# AstroWallet — SCF 7.0 Integration Track & STRIDE Threat Model

> **Scope:** Authoritative submission dossier for **Stellar Community Fund (SCF) 7.0 Integration Track** (`https://communityfund.stellar.org/`, Medium Tier ~$60K–$95K USD, 10/20/30/40% tranches) and **Soroban Security Audit Bank** enrollment prior to Mainnet activation.

---

## 1. SCF 7.0 Integration Track Summary

### Core Thesis
AstroWallet closes the mobile UX gap between Classic Stellar (`G...` SEP-0005), gasless Soroban Smart Accounts (`C...`), pre-sign Clear-Signing (`Scan & Shield`), `x402` AI agent allowances, MoneyGram SEP-24 cash off-ramps, and zero-`op_no_trust` Telegram social payments—shipped as an MIT-licensed, zero-hardcoding, 100% phone-first Telegram Mini App + Super-Bot (`grammY`).

### Composed Stellar Ecosystem Stack
| Ecosystem Component | Role in AstroWallet | Integration Module |
| :--- | :--- | :--- |
| **CAP-46 Counterfactual Smart Accounts & OpenZeppelin Channels** | Real XDR `HashIdPreimage::envelopeTypeContractId` counterfactual `C...` derivation & `Operation.createCustomContract` builder (`deriveCounterfactualSmartAccount`, `buildDeploySmartAccountOperation`; pending audited OpenZeppelin Smart Account WASM upload for live `C...` deployment), 1-tap `SAC` transfers, and policy-gated gasless relay (`/v1/relay/submit`) | [`packages/stellar-core/src/smart-account/index.ts`](../packages/stellar-core/src/smart-account/index.ts), [`apps/server/src/routes/relay.ts`](../apps/server/src/routes/relay.ts) |
| **Soroswap Aggregator + Horizon Path Payments** | Worker-proxied DEX aggregation (`/quote` + `/quote/build` using canonical SAC contract IDs & 7-decimal stroops) with zero-key Classic SDEX/AMM path fallback & Telegram `/swap` | [`packages/defi/src/index.ts`](../packages/defi/src/index.ts), [`apps/server/src/routes/proxy.ts`](../apps/server/src/routes/proxy.ts) |
| **StellarExpert Open Directory & SDF SEP-42 / SEP-29** | Edge-cached `#malicious` / `#unsafe` / `#exchange` tagging (`M...` → base `G...`), live SEP-42 asset list caching (`sep42.ts`), Soroban RPC `simulateTransaction` balance diffs, and mandatory exchange memo / `M...` guard | [`packages/security-shield/src/rules.ts`](../packages/security-shield/src/rules.ts), [`packages/security-shield/src/sep42.ts`](../packages/security-shield/src/sep42.ts), [`apps/server/src/routes/proxy.ts`](../apps/server/src/routes/proxy.ts) |
| **LumenWipe Reserve Reclamation** | Classic `(2 + subentries + sponsoring - sponsored) * 0.5 XLM` calculator & 1-tap `changeTrust(limit="0")` reclaimer + `/reserve` bot command | [`packages/domain/src/accounts.ts`](../packages/domain/src/accounts.ts), [`packages/stellar-core/src/classic/index.ts`](../packages/stellar-core/src/classic/index.ts) |
| **Circle CCTP (`CctpForwarder`, 0 KYB)** | Permissionless cross-chain USDC bridging with strict 6↔7 decimal dust guard and unmuxed `G...`/`C...` strkey check wired via Zod `PwaConfig` | [`packages/defi/src/index.ts`](../packages/defi/src/index.ts), [`apps/pwa/src/components/RampSheet.tsx`](../apps/pwa/src/components/RampSheet.tsx) |
| **SEP-43 / Wallets Kit v2 / dApp Sandbox** | Open dApp JSON-RPC responder (`stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signAuthEntry`, `stellar_signMessage`) + explicit `window.stellar` consent modal (external connections inside Telegram Mini App use [`TonConnectSheet`](../apps/pwa/src/components/TonConnectSheet.tsx) under ToS §7.3–7.4 alongside the local SEP-43 sandbox) | [`packages/stellar-core/src/dapp/index.ts`](../packages/stellar-core/src/dapp/index.ts), [`apps/pwa/src/components/TonConnectSheet.tsx`](../apps/pwa/src/components/TonConnectSheet.tsx) |

---

## 2. STRIDE Threat Model & Mitigations

### Subsystem A — Client Vault & Universal Mobile Auth (`packages/stellar-core/src/vault/`)
| STRIDE Category | Threat Vector | Implemented Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Attacker tricks iOS/Android user without FaceID hardware, brute-forces PIN, or hijacks WebAuthn `rpId` across domains | Universal **6-character minimum** PIN/passphrase baseline via Argon2id Worker (`hash-wasm` + `@noble/hashes` fallback) with progressive cooldown backoff (`5s → 15s → 30s → 60s` after 3 failed attempts); WebAuthn PRF wraps the PIN via **HKDF-SHA256** anchored to origin-matched `rpId`; non-blocking `IosBrowserGuard` protects embedded browsers. |
| **Tampering** | Modification of IndexedDB encrypted vault blob or `.agvault` backup | **AES-GCM-256** authenticated encryption with unique 12-byte IV and 16-byte Argon2id salt; tampered ciphertexts fail GCM tag authentication (`crypto.test.ts`). |
| **Repudiation** | Ambiguous key provenance across derived accounts | Deterministic **SEP-0005** SLIP-0010 derivation (`m/44'/148'/i'`) verified against official reference vectors (`sep0005.test.ts`). |
| **Information Disclosure** | Seed leak via `localStorage`, idle unlocked tab, server logs, RAM retention, or `sk_` exposure | Private keys stay strictly inside encrypted IndexedDB + transient memory with `.zeroize()`, **5-minute inactivity auto-lock**, and **60-second background visibility lock**; ESLint `no-restricted-imports` forbids `apps/server` from importing `@astrowallet/stellar-core`; `pnpm secret-scan` enforces zero hardcoded keys/URLs. |
| **Denial of Service** | iOS 7-day Safari ITP eviction or uncaught UI render errors | Onboarding guides "Add to Home Screen First" on iOS Safari, calls `navigator.storage.persist()`, supports encrypted `.agvault` backups, installs offline shell SW (`sw.js`), and wraps the app in a global Liquid Glass `ErrorBoundary`. |
| **Elevation of Privilege** | Compromised dApp silently calling `window.stellar` or WalletConnect RPC to drain funds; Express Sign session abuse | `authorizeRequest` runs `scanTransactionEnvelopeXdr` (throwing on `malicious`), validates CAIP-2 `chainId` & `networkPassphrase`, and requires **explicit user approval in the SEP-43 consent modal** (`pendingDappConsent`) before any keypair signs. Express Sign (`?express=1`) enforces `HighValueReauthGate`, configurable short session leases (Always Ask/15/30/60m), and origin-checked `window.opener.postMessage({ type: "ASTRO_SIGN_COMPLETE" })`. |

### Subsystem B — Scan & Shield Pre-Sign Pipeline (`packages/security-shield/`)
| STRIDE Category | Threat Vector | Implemented Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Fake `USDC`/`EURC` issuer clones, `M...` muxed directory bypasses, or phishing memo links | Live SEP-42 asset lists fetched & TTL-cached (`sep42.ts`) enforce `SPOOFED_PROTECTED_ASSET` (`blocksSigning: true`) when configured and emit a non-blocking warning (`UNVERIFIED_PROTECTED_ASSET_NO_REGISTRY`) when offline; `extractBaseDestination` unwraps `M...` → `G...` prior to directory & SEP-29 lookups; `ClassicToolsSheet` enables `filterSpamClaimableBalances` + `sanitizeMemoPhishing` by default. |
| **Tampering** | Opaque Base64 XDR hiding `setOptions`, `accountMerge`, or nested Soroban `approve` | Zero-WASM `@stellar/stellar-sdk` + `contract.Spec` decoding recursively collects `contractId` values across nested `subInvocations` for directory inspection; `MALICIOUS_SET_OPTIONS_SIGNER`, `MALICIOUS_SET_OPTIONS_MASTER_LOCKOUT`, `DANGEROUS_ACCOUNT_MERGE`, and `SOROBAN_NESTED_TOKEN_APPROVAL` block signing (`blocksSigning: true`). |
| **Blind Signing / State Drift** | Unknown Soroban execution fees, expired TTL entries, or hidden token outflows | `simulateSorobanTransaction` (`xdrFormat: "json"`) extracts simulated `balanceDiffs`, adds `minResourceFeeStroops`, flags Protocol 23 restore (`SOROBAN_TTL_RESTORE_REQUIRED`), and surfaces warnings cleanly in `ScanShieldSheet` and `IntentSheet`. |
| **Information Disclosure / DoS** | Heavy `~3 MB` WASM parser slowing mobile launch or SSRF/oversized `stellar.toml` | Raw XDR inspection runs lazily inside `inspectRawXdrInWorker` (`raw-xdr.worker.ts`) excluded from initial PWA chunks; `apps/server` rate-limits `/v1/proxy/*`, caches directory/TOML lookups in KV, and hardens `/stellar-toml` (`isSafePublicDomain`, `redirect: "error"`, 5s timeout, 128 KB max). |
| **Elevation of Privilege** | Sending un-memoed CEX deposits causing permanently stuck funds | **SEP-29** (`config.memo_required`) & directory `#exchange` lookup enforced in `MISSING_SEP29_EXCHANGE_MEMO` (across both `SendSheet` and `IntentSheet`); accepts either explicit Memo or CAP-27 `M...` muxed destination. |

### Subsystem C — Telegram Super-Bot, Relayer, Signed Intents & Indexer Webhooks (`apps/server/`, `packages/tg-protocol/`)
| STRIDE Category | Threat Vector | Implemented Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Forged Telegram webhook updates, `@username` hijacking, unauthorized relayer drainage, or spoofed webhooks | `/tg/webhook` verifies `X-Telegram-Bot-Api-Secret-Token` in constant time; `/connect` binds immutable `telegram_user_id` via SEP-53 Ed25519 signature (for `G...`) or Guardian proof (`verifySmartAccountGuardianSignature` for `C...`); `/v1/relay/submit` enforces allowlisted `Origin` or valid HMAC `intentAuth` + KV rate limits + XDR/Scan & Shield + `RELAY_ALLOWED_CONTRACTS` gates; `/webhooks/indexer` verifies HMAC-SHA256 or constant-time secret. |
| **Tampering** | Group chat user altering `/pay`, `/buy`, `/sell`, `/swap`, `/nft`, `/split`, or `/reserve` parameters; SEP-10 client-domain cosigning abuse | Every bot button links to `/intent/<id>?sig=<hmac>` signed by `INTENT_HMAC_SECRET`, stored server-side in D1 and verified on `GET`, `/connect`, `/confirm`, and `/v1/relay/submit`. `GET /v1/proxy/sep10/challenge` strictly verifies sequence `0`, `manageData`-only operations, and matching `client_domain` before cosigning with `SEP10_CLIENT_SIGNING_SECRET`. |
| **Repudiation / Replay** | Marking Telegram cards confirmed with historical/unrelated `txHash`, reusing a `txHash` across intents, or duplicate alert spam | `POST /v1/intents/:id/confirm` enforces `ExpectedTxMatch` (Horizon op-level destination/asset/issuer/amount/memo + Soroban `create_claim`/`claim` arg0 `claimId` + `minCreatedAtUnix` check) and D1 anti-replay (`UNIQUE` `tx_hash` in `0002_production_hardening.sql` + `isTxHashUsed`), tracks multi-payer `/split` via `intent_payments`, and deduplicates alerts via `processed_alerts` (`claimAlertDedupKey`). |
| **Cross-Network / DoS** | Replaying Testnet intents on Mainnet or exceeding Worker subrequest limits | Zod schemas forbid `FRIENDBOT_URL` / `VITE_FRIENDBOT_URL` on `mainnet`; `/connect` & `/confirm` enforce `intent.network === config.network`; `ChainWatcherDO` polls Classic accounts in bounded batches of 15 with persisted `batch_offset` and `empty_init` cursor safety. |

### Subsystem D — Soroban Claim-Link Escrow V2 Contract (`contracts/claim-escrow/src/lib.rs`)
| Threat / Vulnerability Class | Contract Invariant & Verification |
| :--- | :--- |
| **Front-Running / Recipient Hijack** | `claim()` enforces `recipient.require_auth()` and verifies an ephemeral Ed25519 signature (`env.crypto().ed25519_verify`) over canonical `"AW_CLAIM_V2:" || contract_xdr || claim_id || recipient_xdr` (`test_frontrun_recipient_substitution_is_rejected`). |
| **Reentrancy / Double-Claim** | **Checks-Effects-Interactions:** `create_claim()`, `claim()`, `refund_expired()`, and `cancel_claim()` mutate and persist `DataKey::Claim(claim_id)` state (and extend TTLs) **before** calling `token_client.transfer(...)`. |
| **State Archival / Permanent Lock** | `create_claim()` enforces `amount > 0`, `expires_at > now`, and `<= 30 days` (`DurationTooLong`), computes `compute_claim_ttl_ledgers` from `expires_at`, extends both persistent & instance TTLs, emits Soroban events, and supports both `refund_expired()` and sender-authorized `cancel_claim()`. |
| **Auth & Cross-Language Parity** | Verified across 6 Rust tests including real auth enforcement without `mock_all_auths` (`test_create_claim_requires_real_sender_auth`) and exact Rust↔TypeScript XDR byte-layout vector (`test_cross_language_payload_encoding_vector`). |

---

## 3. Soroban Security Audit Bank Readiness

Before activating Mainnet flags (`STELLAR_NETWORK=mainnet`), AstroWallet submits for **Soroban Security Audit Bank** review (5% refundable deposit):
1. **In-Scope Custom Rust Contract (Live on Testnet):** [`contracts/claim-escrow/src/lib.rs`](../contracts/claim-escrow/src/lib.rs) (549 LOC including comprehensive unit tests: `create_claim`, `claim`, `refund_expired`, `cancel_claim`, `get_claim`), deployed on Stellar Testnet at `CDEOJ4KCHMCSJY2N6VCHD3UYVFIIJ3ZVG7DRZ6XMLSTTU4US6ITH36BQ` (WASM hash `33ecebddb590eedcf1059a969122c4edf3a9fe092912356d19bd827ce17f61fb`), with D1 migration `0002_production_hardening.sql` applied remotely and live SEP-42 (`api.stellar.expert/explorer/testnet/asset-list/top50`) + `RELAY_ALLOWED_CONTRACTS` verified on `astrowallet-b1o.pages.dev`.
2. **Counterfactual Smart Accounts (`C...`):** CAP-46 deterministic address derivation (`deriveCounterfactualSmartAccount`) and `createCustomContract` deployment op (`buildDeploySmartAccountOperation`) ready to pair with audited OpenZeppelin `stellar-contracts` once WASM hash is uploaded and pinned.
3. **Automated Client/Server/Contract Security Verification:** Verified by `pnpm check` (`typecheck`, ESLint hexagonal `no-restricted-imports`, `89` Vitest tests across `18` suites, `pnpm secret-scan`), `pnpm build` (`@stellar/stellar-xdr-json` verified absent from PWA bundle), and CI Rust checks (`cargo fmt --check`, `cargo clippy -D warnings`, `6` Soroban Rust tests).

---

## 4. Verifiable Tranche #3 On-Chain KPIs

| Metric | Measurement Source | Target (Tranche #3) |
| :--- | :--- | :--- |
| **Active Funded Accounts (`G...` & `C...`)** | Stellar Ledger / Horizon accounts linked via `/connect` & smart account deploys | >= 1,500 active funded wallets |
| **Soroswap & Path Payment Swap Volume** | On-chain swap transactions routed via `createSoroswapProxyAdapter` & Horizon fallback | >= $250,000 USD equivalent volume |
| **Telegram Claim Link Conversions** | `ClaimEscrowContract` `create_claim` → `claim` conversions by first-time users | >= 500 claimed links (>= 65% claim rate) |
| **Blocked Adversarial Transactions** | Local & `/scan` `malicious` verdicts (`setOptions`, `accountMerge`, spoofed `USDC`, missing `SEP-29`) | 100% deterministic block rate on test vectors |
