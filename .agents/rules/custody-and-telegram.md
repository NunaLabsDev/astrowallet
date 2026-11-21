---
trigger: model_decision
description: "Argon2id/WebAuthn/Telegram BiometricManager non-custodial key isolation, Zero-Knowledge AGVAULT sync, G.../C... Stellar boundaries, and Telegram Mini App Clause 7.3 policy for astrowallet."
---

# AstroWallet Custody, Stellar Account Boundaries & Telegram Mini App Policy

## 1. Non-Custodial Key Isolation, Universal Auth & ZK Cloud Sync
- **Universal Baseline (No FaceID Requirement):** Never require FaceID hardware or FaceID-only UI copy. Use PIN/passphrase derived via **Argon2id in a Web Worker** (`hash-wasm` primary + `@noble/hashes/argon2` fallback, `64 MiB`, `iterations: 3`) + **AES-GCM-256** inside **IndexedDB** (`navigator.storage.persist()`), with persistent lockout (`getPinLockoutState` / `recordFailedPinAttempt`). Keep unlocked session mnemonics in zeroizable `Uint8Array` (`sessionVault`), never in React `useState` strings.
- **Optional Biometrics:** Prefer Telegram `BiometricManager` + Bot API 9.0 device `SecureStorage` (iOS Keychain / Android Keystore) inside the Mini App, falling back cleanly to standard WebAuthn (`userVerification: "preferred"`) Fingerprint or Soroban `secp256r1`.
- **Zero-Leak Boundaries & Zero-Knowledge Sync (`AGVAULT` v1):** **Plaintext** private keys, mnemonics, decrypted seeds, PINs, and recovery passwords must **never** touch `localStorage`, `sessionStorage`, Telegram `CloudStorage`, bot webhooks, D1/KV, analytics, or Worker logs. Clients may sync ONLY client-encrypted `AGVAULT` v1 ciphertext (`Argon2id >= 64 MiB` + `AES-GCM-256`, `>= 10` char Recovery Password) to `encrypted_vault_backups` (`PUT/GET/DELETE /v1/tg/vault-backup`) and `Telegram.WebApp.CloudStorage`.
- **Identity Verification:** Telegram Mini App sessions verify `Telegram.WebApp.initData` via HMAC-SHA256 (`POST /v1/tg/auth`, `auth_date <= 300s`, 15m JWT/HMAC session token)—never trust `initDataUnsafe`. `/connect` (private DM only + `confirmCode`) and `/v1/tg/link-confirm` bind `telegram_user_id` + `@username` strictly via cryptographic signature proof of public `G...`/`C...` addresses.

## 2. Honest Classic (`G...`) vs Smart Account (`C...`) Boundaries
- **Classic (`G...`):** Supports Classic SDEX, `pathPayment`, Claimable Balances, raw CEX `Memo` deposits, `accountMerge`, and `0.5 XLM` subentry reserves.
- **Smart Account (`C...`):** Supports gasless Soroban invocations via **OpenZeppelin Channels** (`/v1/relay/submit` fee sponsorship—note Channels does not sponsor `G...` base reserves), Fingerprint `secp256r1` auth, session keys, and context rules. **Cannot** directly place Classic SDEX offers or receive un-muxed raw memo CEX deposits (use `M...` muxed encoding or 1-tap `SAC` bridge to linked `G...`). *(Check `docs/AUDIT_2026-11.md` §5 for open `C...` activation gaps.)*

## 3. Telegram-Exclusive Mini App & ToS Clause 7.3 Policy (Rule 7 Active)
- `apps/pwa` runs **100% inside Telegram** (`web_app` in private chats, `https://t.me/<bot>[/<short_name>]?startapp=...` in groups/inline; guarded by `TelegramOnlyGate`). Zero standalone public landing site.
- Native Stellar (`G...`/`C...`) and TON (`WalletContractV4`/`V5R1`, SLIP-0010 `m/44'/607'/i'`) custody lives in-app. External app connections operate **exclusively via TON Connect v2**—never inject `window.stellar`, ship WalletConnect/Reown non-TON dApp connectors, or embed non-TON app catalogs/promotions (Telegram ToS §7.3–7.4).
- CSP framing allows **only** `frame-ancestors https://web.telegram.org https://*.telegram.org`.
