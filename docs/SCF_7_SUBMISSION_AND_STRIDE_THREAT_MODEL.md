# AstroWallet — SCF 7.0 Integration Track & STRIDE Threat Model

> **Scope:** Authoritative submission dossier for **Stellar Community Fund (SCF) 7.0 Integration Track** (`https://communityfund.stellar.org/`, Medium Tier ~$60K–$95K USD, 10/20/30/40% tranches) and **Soroban Security Audit Bank** enrollment prior to Mainnet activation.

---

## 1. SCF 7.0 Integration Track Summary

### Core Thesis
AstroWallet closes the mobile UX gap between Classic Stellar (`G...` SEP-0005), gasless Soroban Smart Accounts (`C...`), pre-sign threat defense, and Telegram social commerce—shipped as an MIT-licensed, zero-hardcoding, 100% phone-first PWA + ToS-compliant Telegram Super-Bot (`grammY`, zero Mini App / zero TON dependency).

### Composed Stellar Ecosystem Stack
| Ecosystem Component | Role in AstroWallet | Integration Module |
| :--- | :--- | :--- |
| **OpenZeppelin Smart Accounts & Channels** | Counterfactual `C...` pairing with `G...` Recovery Guardian (`rotate_guardian`), `SAC` 1-tap transfers, and gasless fee sponsorship (`/v1/relay/submit`) | [`packages/stellar-core/src/smart-account/index.ts`](../packages/stellar-core/src/smart-account/index.ts), [`apps/server/src/routes/relay.ts`](../apps/server/src/routes/relay.ts) |
| **Soroswap Aggregator + Horizon Path Payments** | Worker-proxied DEX aggregation with zero-key Classic SDEX/AMM path fallback & Telegram `/swap` | [`packages/defi/src/index.ts`](../packages/defi/src/index.ts), [`apps/server/src/routes/proxy.ts`](../apps/server/src/routes/proxy.ts) |
| **StellarExpert Open Directory & SDF SEP-42 / SEP-29** | Edge-cached `#malicious` / `#unsafe` / `#exchange` tagging, anti-fake `USDC` validation, and mandatory exchange memo / `M...` guard | [`packages/security-shield/src/rules.ts`](../packages/security-shield/src/rules.ts), [`apps/server/src/routes/proxy.ts`](../apps/server/src/routes/proxy.ts) |
| **LumenWipe Reserve Reclamation** | Classic `(2 + subentries + sponsoring - sponsored) * 0.5 XLM` calculator & 1-tap `changeTrust(limit="0")` reclaimer + `/reserve` bot command | [`packages/domain/src/accounts.ts`](../packages/domain/src/accounts.ts), [`packages/stellar-core/src/classic/index.ts`](../packages/stellar-core/src/classic/index.ts) |
| **Circle CCTP (`CctpForwarder`, 0 KYB)** | Permissionless cross-chain USDC bridging with strict 6↔7 decimal dust guard and unmuxed `G...`/`C...` strkey check | [`packages/defi/src/index.ts`](../packages/defi/src/index.ts), [`apps/pwa/src/components/RampSheet.tsx`](../apps/pwa/src/components/RampSheet.tsx) |
| **Reown AppKit / Stellar Wallets Kit v2 / SEP-43** | Open dApp JSON-RPC responder (`stellar_signXDR`, `stellar_signAndSubmitXDR`, `stellar_signAuthEntry`, `stellar_signMessage`) + `window.stellar` | [`packages/stellar-core/src/dapp/index.ts`](../packages/stellar-core/src/dapp/index.ts), [`apps/pwa/src/components/DappConnectSheet.tsx`](../apps/pwa/src/components/DappConnectSheet.tsx) |

---

## 2. STRIDE Threat Model & Mitigations

### Subsystem A — Client Vault & Universal Mobile Auth (`packages/stellar-core/src/vault/`)
| STRIDE Category | Threat Vector | Implemented Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Attacker tricks iOS/Android user without FaceID hardware or inside Telegram WebView | Universal 6-digit PIN / passphrase mandatory baseline via Argon2id Worker (`hash-wasm` + `@noble/hashes` fallback); WebAuthn Fingerprint (`userVerification: "preferred"`) is purely an optional convenience layer; non-blocking `IosBrowserGuard` protects embedded browsers. |
| **Tampering** | Modification of IndexedDB encrypted vault blob or `.agvault` backup | **AES-GCM-256** authenticated encryption with unique 12-byte IV and 16-byte Argon2id salt; tampered ciphertexts fail GCM tag authentication (`crypto.test.ts`). |
| **Repudiation** | Ambiguous key provenance across derived accounts | Deterministic **SEP-0005** SLIP-0010 derivation (`m/44'/148'/i'`) verified against official reference vectors (`sep0005.test.ts`). |
| **Information Disclosure** | Seed leak via `localStorage`, server logs, RAM retention, or `sk_` exposure | Private keys stay strictly inside encrypted IndexedDB + transient memory with explicit `.zeroize()`; ESLint `no-restricted-imports` forbids `apps/server` from importing `@astrowallet/stellar-core`; `pnpm secret-scan` enforces zero hardcoded keys/URLs. |
| **Denial of Service** | iOS 7-day Safari ITP eviction wiping unbacked keys | Onboarding guides "Add to Home Screen First" on iOS Safari, calls `navigator.storage.persist()`, and supports encrypted `.agvault` export/import. |
| **Elevation of Privilege** | Compromised dApp calling `window.stellar` or WalletConnect RPC to drain funds | `authorizeRequest` runs `scanTransactionEnvelopeXdr` before signing, validates CAIP-2 `chainId` & `networkPassphrase`, and fails closed on cross-network or malicious payloads. |

### Subsystem B — Scan & Shield Pre-Sign Pipeline (`packages/security-shield/`)
| STRIDE Category | Threat Vector | Implemented Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Fake `USDC`/`EURC` issuer clones or phishing memo links | Protected asset symbols verified against SEP-42 issuer registry (`SPOOFED_PROTECTED_ASSET`); `filterSpamClaimableBalances` and `sanitizeMemoPhishing` strip malicious URLs and dust claimables. |
| **Tampering** | Opaque Base64 XDR hiding `setOptions`, `accountMerge`, or nested Soroban `approve` | Zero-WASM `@stellar/stellar-sdk` + `contract.Spec` decoding recursively inspects `subInvocations`; `MALICIOUS_SET_OPTIONS_SIGNER`, `MALICIOUS_SET_OPTIONS_MASTER_LOCKOUT`, `DANGEROUS_ACCOUNT_MERGE`, and `SOROBAN_NESTED_TOKEN_APPROVAL` block signing (`blocksSigning: true`). |
| **Information Disclosure / DoS** | Heavy `~3 MB` WASM parser slowing mobile launch or missing CORS on `stellar.toml` | `@stellar/stellar-xdr-json` is isolated to an on-demand Web Worker (`raw-xdr.worker.ts`) and excluded from initial PWA chunk; `apps/server` edge-proxies and KV-caches StellarExpert and `stellar.toml` lookups. |
| **Elevation of Privilege** | Sending un-memoed CEX deposits causing permanently stuck funds | **SEP-29** (`config.memo_required`) & directory `#exchange` lookup enforced in `MISSING_SEP29_EXCHANGE_MEMO`; accepts either explicit Memo or CAP-27 `M...` muxed destination. |

### Subsystem C — Telegram Super-Bot, Signed Intents & Indexer Webhooks (`apps/server/`, `packages/tg-protocol/`)
| STRIDE Category | Threat Vector | Implemented Mitigation |
| :--- | :--- | :--- |
| **Spoofing** | Forged Telegram webhook updates, `@username` hijacking, or spoofed Goldsky/Mercury webhooks | `/tg/webhook` verifies `X-Telegram-Bot-Api-Secret-Token` in constant time; `/connect` binds immutable numeric `telegram_user_id` via Ed25519 signature over `SEP-53` challenge; `/webhooks/indexer` verifies HMAC-SHA256 or constant-time `INDEXER_WEBHOOK_SECRET`. |
| **Tampering** | Group chat user altering `/pay` or `/reserve` URL amount/destination | Every bot button links to `/intent/<id>?sig=<hmac>` signed by `INTENT_HMAC_SECRET` with `<= 5 min` TTL for payment/connect intents, stored server-side in D1 and verified on `GET` and `POST /confirm`. |
| **Repudiation** | Marking Telegram chat card confirmed without on-chain finality | `POST /v1/intents/:id/confirm` queries Horizon `verifyTransactionConfirmed` before updating D1 status or calling `editMessageText`. |
| **Cross-Network Confusion** | Replaying Testnet intent or Friendbot helper on Mainnet | Zod schemas reject `FRIENDBOT_URL` / `VITE_FRIENDBOT_URL` on `mainnet`; `assertFriendbotAllowed` throws on `mainnet`; intents enforce `intent.network === config.network`. |

### Subsystem D — Soroban Claim-Link Escrow Contract (`contracts/claim-escrow/src/lib.rs`)
| Threat / Vulnerability Class | Contract Invariant & Verification |
| :--- | :--- |
| **Unauthorized Claim / Front-running** | `claim()` enforces `recipient.require_auth()` and verifies `sha256(secret_preimage) == deposit.claim_hash` before transferring funds. |
| **Reentrancy / Double-Claim** | **Checks-Effects-Interactions:** `deposit.status` is mutated to `ClaimStatus::Claimed` (or `ClaimStatus::Refunded`) and written to persistent storage **before** calling `token_client.transfer(...)`. |
| **Permanent Fund Lock** | `create_claim()` enforces `expires_at > now` and `amount > 0`; `extend_ttl()` extends persistent state (`CLAIM_TTL_THRESHOLD` / `CLAIM_TTL_EXTEND_TO`); `refund_expired()` lets anyone trigger return to `deposit.sender` once `now > expires_at`. |
| **Duplicate Claim Collision** | `create_claim()` rejects existing `DataKey::Claim(claim_id)` with `ClaimError::AlreadyExists`. |

---

## 3. Soroban Security Audit Bank Readiness

Before activating Mainnet flags (`STELLAR_NETWORK=mainnet`), AstroWallet submits for **Soroban Security Audit Bank** review (5% refundable deposit):
1. **In-Scope Custom Rust Contract:** [`contracts/claim-escrow/src/lib.rs`](../contracts/claim-escrow/src/lib.rs) (174 LOC, minimal surface area: `create_claim`, `claim`, `refund_expired`, `get_claim`).
2. **Reused Audited Smart Account Contracts:** OpenZeppelin `stellar-contracts` (`packages/accounts` Context Rules + Guardian recovery rotation via `rotate_guardian`).
3. **Client/Server Security Boundaries:** Verified by automated `pnpm check` (`typecheck`, ESLint hexagonal `no-restricted-imports`, 70 Vitest adversarial/vector tests across 15 suites, and `pnpm secret-scan`).

---

## 4. Verifiable Tranche #3 On-Chain KPIs

| Metric | Measurement Source | Target (Tranche #3) |
| :--- | :--- | :--- |
| **Active Funded Accounts (`G...` & `C...`)** | Stellar Ledger / Horizon accounts linked via `/connect` & smart account deploys | >= 1,500 active funded wallets |
| **Soroswap & Path Payment Swap Volume** | On-chain swap transactions routed via `createSoroswapProxyAdapter` & Horizon fallback | >= $250,000 USD equivalent volume |
| **Telegram Claim Link Conversions** | `ClaimEscrowContract` `create_claim` → `claim` conversions by first-time users | >= 500 claimed links (>= 65% claim rate) |
| **Blocked Adversarial Transactions** | Local & `/scan` `malicious` verdicts (`setOptions`, `accountMerge`, spoofed `USDC`, missing `SEP-29`) | 100% deterministic block rate on test vectors |
