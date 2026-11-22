# AstroConnect v1 — Open Stellar & Soroban Wallet Standard for Telegram

> **Mission:** Make **AstroWallet** an open, permissionless authentication and transaction-signing standard for **every** Stellar & Soroban project building on Telegram — without custodial lock-in, browser extensions, or Telegram ToS violations.

---

## 1. Why an Ephemeral Request Bridge?

Telegram Mini Apps face two strict platform constraints:
1. **`startapp` length limit:** Telegram deep links (`https://t.me/<bot>/<short_name>?startapp=...`) only carry short URL-safe payloads (`<= 64` characters reliably across mobile clients). A Soroban `TransactionEnvelope` XDR is typically `1 KB – 15 KB`, which cannot fit in `startapp`.
2. **Telegram ToS Clauses 7.3–7.4:** Non-TON wallets inside Telegram cannot inject `window.stellar` or advertise WalletConnect/Reown multi-chain catalogs.

**AstroConnect v1** solves both cleanly with an **Ephemeral Request Bridge** (modeled after TON Connect, built natively for Stellar Classic `G...` & Soroban `C...`):
- Calling dApps register a short-lived (`60s–300s`) request via `POST /v1/connect/requests` and receive a **50-character** `startapp=c-<requestId>-<sig>` deep link plus a secret polling `resultToken`.
- **Zero key custody on server:** AstroWallet's server never touches private keys, mnemonics, or decrypted seeds. It stores only the temporary request envelope and SHA-256 hashes of `xdrSha256` and `resultToken`.

---

## 2. Cryptographic & Security Guarantees

1. **128-bit HMAC Deep-Link Binding:**
   - Canonical message: `connect:${network}:${requestId}:${expiresAt}`
   - `sig` is the first 32 hex characters (`128 bits`) of HMAC-SHA256 using `INTENT_HMAC_SECRET`.
   - Resulting `startapp` parameter: `c-ac_<12hex>-<32hex>` (**50 characters** total).
2. **Dual-Credential Access Control:**
   - **Wallet Read (`GET /v1/connect/requests/:requestId?sig=...`):** Requires valid HMAC `sig` and non-expired TTL.
   - **App Polling (`GET /v1/connect/requests/:requestId` with `X-Connect-Token: <resultToken>`):** Only the SHA-256 hash (`result_token_hash`) is persisted in D1. Only the app holding `resultToken` can read `{ address, signatureBase64, signedXdr, txHash }`.
3. **XDR Integrity Binding (`sign_xdr`):**
   - `POST /v1/connect/requests` verifies `SHA-256(unsignedXdr) === payload.xdrSha256` before accepting the request.
   - When `submit: true` (default), `POST /v1/connect/requests/:requestId/complete` verifies `txHash` directly on Horizon / Soroban RPC before marking `approved`.
   - When `submit: false` (sign-only / multi-sig / custom relayer), AstroWallet returns `signedXdr` so the dApp can inspect or co-sign before broadcast.
4. **Canonical SEP-53 Sign-In (`auth`):**
   - Server generates a deterministic, domain-bound challenge message:
     ```text
     AstroConnect Sign-In v1
     App: <AppName> (@<botUsername>)
     Network: <testnet|mainnet>
     Request ID: <requestId>
     Nonce: <nonce>
     Issued At: <unix>
     Expires At: <unix>
     Domain: <optional domain>
     Statement: <optional statement>
     ```
   - AstroWallet signs `SHA-256("Stellar Signed Message:\n" + challengeMessage)` with Ed25519.
   - Both AstroWallet's server (at `/complete`) and the external dApp's backend (`verifyAstroLoginProof`) verify the Ed25519 signature offline.
5. **Independent Scan & Shield + Anti-Phishing Boomerang:**
   - Every `sign_xdr` request undergoes independent client & edge **Scan & Shield** simulation inside AstroWallet (hard-blocking malicious `setOptions` / `accountMerge` / drainer calls).
   - Boomerang return URLs are strictly constrained to `https://t.me/<botUsername>[/<miniAppShortName>]?startapp=<param>` — arbitrary `http(s)://` redirects are forbidden.

---

## 3. App Trust Tiers

| Tier | How It Is Assigned | Clear-Sign UI Treatment |
| :--- | :--- | :--- |
| `official` | `X-Ecosystem-Secret` matches `ECOSYSTEM_SHARED_INTENT_SECRET` | **ASTRO Official** green seal |
| `verified` | `app.botUsername` listed in server `CONNECT_VERIFIED_BOTS` | **Verified App** gold badge |
| `external` | Permissionless default (any Telegram Mini App or Stellar project) | **External App** badge + amber review banner |

---

## 4. Machine-Readable Discovery & Open Endpoints

All permissionless discovery and AstroConnect endpoints enable `Access-Control-Allow-Origin: *` while keeping user vault, relay, and webhook routes locked down:

- `GET /openapi.json` — OpenAPI 3.1.0 specification
- `GET /llms.txt` — Concise plain-text guide for AI agents & developer tooling
- `GET /v1/identity/resolve?q=<telegramUserId|@username|G...|C...>` — Public `AstroID` directory
- `POST /v1/connect/requests` — Create `auth`, `sign_message`, or `sign_xdr` request
- `GET /v1/connect/requests/:requestId` — Poll status (`X-Connect-Token`) or fetch Clear-Sign payload (`?sig=`)
- `POST /v1/connect/requests/:requestId/complete` — Submit signed proof/tx or rejection from AstroWallet
