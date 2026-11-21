---
trigger: model_decision
description: "Zero-hardcoding Zod env config policy and pointer to docs/ENV_MATRIX.md for apps/pwa and apps/server."
---

# AstroWallet Zero-Hardcoding & Zod Env Config Policy

- **Authoritative Matrix:** See [`docs/ENV_MATRIX.md`](../../docs/ENV_MATRIX.md) for every `apps/pwa` (`VITE_*`) and `apps/server` (Cloudflare env/binding/secret) variable, example value, and note.
- **Single Zod Source of Truth:** Every client and server env var must be parsed and validated at startup via [`packages/domain/src/config.ts`](../../packages/domain/src/config.ts) (`parsePwaConfig` and `parseServerConfig`). Missing required variables must **fail fast** with explicit errors.
- **Zero Hardcoding in Source:** Never hardcode Stellar/TON network passphrases or chain IDs, RPC/Horizon/TON URLs, contract IDs, asset issuers, bot usernames, API keys (`sk_*`), or domain origins inside `apps/*/src` or `packages/*/src`. Environment switching (`testnet` <-> `mainnet`) happens exclusively via `STELLAR_NETWORK` / `VITE_STELLAR_NETWORK` and env config—never via `if (isProd)` hardcoded branches.
- **Real Testnet Parity & Mainnet Hard-Blocks:** Runtime code must call real Testnet/Mainnet endpoints (mocks belong strictly in `*.test.ts`). Zod rejects `FRIENDBOT_URL` / `VITE_FRIENDBOT_URL`, plaintext `http://` endpoints, and `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM=true` whenever network is `mainnet`.
- **Templates & Scanning:** Keep public/local examples in [`apps/pwa/.env.example`](../../apps/pwa/.env.example) and [`apps/server/.dev.vars.example`](../../apps/server/.dev.vars.example); verify changes with `pnpm secret-scan` (`scripts/secret-scan.mjs`).
