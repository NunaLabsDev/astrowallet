# AstroWallet — Engineering Contract

> **Scope:** Authoritative rules for contributors and AI models in this repository (`astrowallet`).

## 1. Context Lookup (Read Only What You Need)

Check [`docs/INDEX.md`](docs/INDEX.md) (with `rg`, or optional local `astro-docs` CLI/MCP) first and read **only** the doc or section relevant to your task—never bulk-read `docs/` upfront.
- Env matrix & schemas: [`docs/ENV_MATRIX.md`](docs/ENV_MATRIX.md)
- Architecture & diagrams: [`ARCHITECTURE.md`](ARCHITECTURE.md)
- Mainnet P0 blockers & audit status: [`docs/AUDIT_2026-11.md`](docs/AUDIT_2026-11.md)
- Stellar official AI resources: [`developers.stellar.org/llms.txt`](https://developers.stellar.org/llms.txt) & [`.agents/plugins/stellar-dev/`](.agents/plugins/stellar-dev/plugin.json)

## 2. Non-Negotiable Engineering Rules

1. **Zero Hardcoding (100% Zod Env-Driven):** Never hardcode network passphrases (`Test SDF Network ; September 2015`, `Public Global Stellar Network ; September 2015`), RPC/Horizon/TON endpoints, contract IDs, asset issuers, bot usernames, API keys, or origins in source files. Validate all env vars at startup via [`@astrowallet/domain`](packages/domain/src/config.ts) (`parsePwaConfig`, `parseServerConfig`); switch `testnet`↔`mainnet` strictly via `STELLAR_NETWORK` / `VITE_STELLAR_NETWORK`.
2. **Testnet Parity & Mainnet Hard-Blocks:** Runtime code (`apps/pwa`, `apps/server`, `packages/*`) must execute against real Testnet/Mainnet endpoints—never ship stubbed balances, fake prices, or fake tx hashes outside `*.test.ts`. Zod/runtime must reject `FRIENDBOT_URL` / `VITE_FRIENDBOT_URL` and `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM=true` on `mainnet`.
3. **Universal Mobile Auth (No FaceID Requirement):** Never require FaceID hardware or render FaceID-only copy/icons.
   - Mandatory baseline: PIN/passphrase derived via **Argon2id in a Web Worker** (`hash-wasm` primary + `@noble/hashes/argon2` fallback, `>= 64 MiB, t=3`) + **AES-GCM-256** inside **IndexedDB** (`navigator.storage.persist()`), with persistent lockout.
   - Optional convenience: Telegram `BiometricManager` + Bot API 9.0 `SecureStorage` (device Keychain/Keystore) or standard WebAuthn (`userVerification: "preferred"`) Fingerprint / Soroban `secp256r1`.
4. **Non-Custodial Key Isolation & Zero-Knowledge Sync:** One **SEP-0005** mnemonic (`m/44'/148'/i'` Stellar, `m/44'/607'/i'` TON) controls linked accounts. **Plaintext** keys, mnemonics, decrypted seeds, PINs, and recovery passwords must **never** touch `localStorage`, `sessionStorage`, `CloudStorage`, webhook payloads, D1/KV, or Worker logs/analytics. Only client-encrypted `AGVAULT` v1 ciphertext (`Argon2id >= 64 MiB` + `AES-GCM-256`, `>= 10` char Recovery Password) may sync to `encrypted_vault_backups` / `CloudStorage`. `/connect` & `/v1/tg/link-*` bind `telegram_user_id` + `@username` strictly via signature proof.
5. **Hexagonal DAG Boundaries:** Enforced by [`eslint.config.mjs`](eslint.config.mjs) (`no-restricted-imports`) and [`tsconfig.base.json`](tsconfig.base.json) (`strict: true`, `noUncheckedIndexedAccess: true`):
   - `domain` (`zod` only) <- `stellar-core` | `ton-core` | `security-shield` | `defi` | `tg-protocol` (no peer imports) <- `apps/pwa` (no `grammy`/`hono`/D1/KV/`sk_*`) & `apps/server` (no React/DOM/user keys/`stellar-core`/`ton-core`).
   - Full import matrix: [`.agents/rules/hexagonal-boundaries.md`](.agents/rules/hexagonal-boundaries.md).
6. **Honest `G...` vs `C...` Boundaries:** Never paper over protocol constraints.
   - Classic `G...`: SDEX, `pathPayment`, Claimable Balances, raw CEX `Memo`, `accountMerge`, `0.5 XLM` subentry reserves.
   - Smart Account `C...`: gasless Soroban (`OpenZeppelin Channels`), `secp256r1` passkeys, session limits; **cannot** place Classic SDEX offers or receive un-muxed raw memo CEX deposits (use `M...` or 1-tap `SAC` transfer to linked `G...`).
7. **Telegram-Exclusive Multichain Mini App & ToS Clause 7.3:** `apps/pwa` runs exclusively inside Telegram (`TelegramOnlyGate` + `POST /v1/tg/auth` HMAC-SHA256 `initData`, `auth_date <= 300s`, 15m session token; zero public marketing site; never trust `initDataUnsafe`). Stellar + TON (`WalletContractV4`/`V5R1`) custody runs in-app; external dApp connections operate **exclusively via TON Connect v2** (never inject `window.stellar`, WalletConnect/Reown, or non-TON catalogs under Telegram ToS §7.3–7.4). Framing CSP: `frame-ancestors https://web.telegram.org https://*.telegram.org`.

## 3. Verification & Definition of Done

Run after the final edit (`pnpm check` runs the first four; build packages first if `@astrowallet/domain` changed):
- `pnpm typecheck` (`strict: true`, `noUncheckedIndexedAccess: true`)
- `pnpm lint` (ESLint hexagonal boundaries across all packages and apps)
- `pnpm test` (Vitest: SEP-0005/TON vectors, Argon2id/AES-GCM vault, Intent/Mini-App security, Scan & Shield, 100-user flows)
- `pnpm secret-scan` (plus `gitleaks`: zero hardcoded URLs, passphrases, `sk_`, or `S...` keys outside `.env.example`/`.dev.vars.example`/tests)
- When touching `contracts/claim-escrow`: `cargo fmt --manifest-path contracts/claim-escrow/Cargo.toml --check`, `cargo clippy --manifest-path contracts/claim-escrow/Cargo.toml --all-targets -- -D warnings`, `cargo test --manifest-path contracts/claim-escrow/Cargo.toml`, `cargo build --manifest-path contracts/claim-escrow/Cargo.toml --release --target wasm32v1-none`.
- Bundle & CSP (`pnpm build` when touching PWA/build): keep `@stellar/stellar-xdr-json` (~3 MB WASM) lazy-loaded in a Web Worker (excluded from `apps/pwa/dist/assets/`), keep CSP free of `'unsafe-inline'` scripts/styles, `'unsafe-eval'`, and unrestricted framing (`frame-ancestors https://web.telegram.org https://*.telegram.org` only).
