---
trigger: glob
globs: "packages/**, apps/**, tsconfig*.json, eslint*"
---

# AstroWallet Hexagonal Package Dependency Matrix

Enforce this DAG in [`eslint.config.mjs`](../../eslint.config.mjs) (`no-restricted-imports`) and [`tsconfig.base.json`](../../tsconfig.base.json) (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`):

| Package / App | May Import From | Strictly Forbidden From Importing |
| :--- | :--- | :--- |
| **`@astrowallet/domain`** | `zod` only (pure TS types, ports, schemas) | `@stellar/*`, `@ton/*`, DOM/Window/IndexedDB, React, `grammy`, Hono, Cloudflare APIs, `@astrowallet/*`, `@noble/*`, `hash-wasm` |
| **`@astrowallet/stellar-core`** | `@astrowallet/domain`, `@stellar/stellar-sdk`, `smart-account-kit`, `hash-wasm`, `@noble/hashes` | React, DOM UI components, `grammy`, Hono, `apps/*`, peer `@astrowallet/*` packages (incl. `@astrowallet/ton-core`), `cloudflare:*` |
| **`@astrowallet/ton-core`** | `@astrowallet/domain`, `@ton/core`, `@ton/ton`, `@noble/hashes`, `@scure/bip39`, `tweetnacl` | React, DOM UI components, `grammy`, Hono, `@stellar/*`, peer `@astrowallet/*` packages, `cloudflare:*` |
| **`@astrowallet/security-shield`** | `@astrowallet/domain`, `@stellar/stellar-sdk` (lazy worker `@stellar/stellar-xdr-json`) | React, `grammy`, Hono, peer `@astrowallet/*` packages, Cloudflare bindings directly (use injected fetcher port) |
| **`@astrowallet/defi`** | `@astrowallet/domain`, `@stellar/stellar-sdk`, `@soroswap/sdk`, `@lumenwipe/sdk` | React, `grammy`, Hono, peer `@astrowallet/*` packages, `cloudflare:*`, raw secret keys (`sk_` keys live in `apps/server` proxy only) |
| **`@astrowallet/tg-protocol`** | `@astrowallet/domain`, Web Crypto / `@noble/ed25519` | React, IndexedDB, DOM APIs, `grammy`, Hono, peer `@astrowallet/*` packages, `cloudflare:*` |
| **`apps/pwa`** | All `@astrowallet/*` client packages (NEVER `sk_*` server secrets) | `grammy`, `hono`, `cloudflare:*`, Cloudflare D1/KV, server signing secrets |
| **`apps/server`** | `@astrowallet/domain`, `@astrowallet/security-shield`, `@astrowallet/defi`, `@astrowallet/tg-protocol`, `hono`, `grammy` | React, DOM/IndexedDB, `@astrowallet/stellar-core`, `@astrowallet/ton-core`, user private keys |

## Additional TS / Bundle Guardrails
- Keep `@stellar/stellar-xdr-json` (~3 MB WASM) excluded from initial `apps/pwa` chunks; load it strictly on-demand inside a Web Worker (`inspectRawXdrInWorker`).
- Verify boundaries after edits with `pnpm --filter "./packages/*" build && pnpm -r typecheck && pnpm -r lint`.
