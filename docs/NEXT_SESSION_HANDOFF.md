# AstroWallet — Operations & Next Session Handoff

> **Live State (`0cd5306`, 2026-11-26):** Deployed live on Cloudflare **Mainnet** (`astrowallet-server-mainnet`), **Testnet** (`astrowallet-server`), and **Pages** (`https://astrowallet-soroban.pages.dev`). Verification: **38/38 Vitest files (216/216 tests)**, **15/15 Rust tests**, `stellar contract build` (`944f9bfccd17f2e95942525dd7e050c40cbc5b6616950fc5287afbb9c37123de`), `pnpm secret-scan` clean, `astro-docs lint` (`0` errors). See [`AUDIT_2026-11.md`](AUDIT_2026-11.md) for remaining Mainnet GA gates.

---

## 1. Live Infrastructure Inventory

| Component | Identifier | Notes |
| :--- | :--- | :--- |
| **GitHub Repo** | `NunaLabsDev/astrowallet` (`main` branch) | Independent repo |
| **Mini App & Origin** | `https://astrowallet-soroban.pages.dev` (`t.me/AstroWalletAppBot/wallet`) | Pages project `astrowallet-soroban` (`./functions` proxy routes by `X-Astro-Network`) |
| **Telegram Super-Bot** | `@AstroWalletAppBot` (`17` commands) | Webhook `/tg/webhook` (query `?network=testnet` for Testnet routing) |
| **Mainnet Worker** | `astrowallet-server-mainnet` (`workers_dev = false`) | D1 `astrowallet-mainnet` (`b67e7931-e091-418b-84ad-5c8003d2c421`, `0001..0009`) · KV `a21e4dfbbc9e45d1bdb7a6e3bf9606b3` |
| **Testnet Worker** | `astrowallet-server` (`workers_dev = false`) | D1 `astrowallet` (`12b7f77d-5467-44a6-a4b3-11ccd63a315c`, `0001..0009`) · KV `3389ff9f05414c219d912e82a7a84baa` |
| **RedStone Oracle (Mainnet)** | `CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF` | Live SEP-40 feed (`/v1/proxy/oracle/prices`) |
| **ClaimEscrow (Testnet)** | `CCWVGVBSHAFS73HCDRJ5MEFJPYKKG4WQFJ2LJPNIO2PU3U4X6PTDA4TA` | Latest built WASM (`lib.rs` TTL fix): `944f9bfccd17f2e95942525dd7e050c40cbc5b6616950fc5287afbb9c37123de` |
| **Sorobits SEP-50 (Testnet)** | `CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3` | Also in Testnet `RELAY_ALLOWED_CONTRACTS` |
| **SEP-10 Client Signing Key** | `GBFRJ6WMZJ37EQBA34RUEZBDSGZBKRY5T2JIVPG7EHJXZZUSKKQD6YRT` | Served at `/.well-known/stellar.toml` |
| **Smart Account WASM** | Intentionally unset (`SMART_ACCOUNT_WASM_HASH`) | Fail-closed (`403`) until CAP-46 deploy + `__check_auth` wired |
| **Local Secrets (git-ignored)** | `~/.secrets/astrowallet/` | Never commit or print raw secrets |

---

## 2. Quick Resume Commands

### Verify Locally
```bash
pnpm --filter "./packages/*" build && pnpm -r typecheck && pnpm -r lint && pnpm test && pnpm secret-scan && pnpm --filter @astrowallet/pwa build
cargo fmt --manifest-path contracts/claim-escrow/Cargo.toml --check && cargo clippy --manifest-path contracts/claim-escrow/Cargo.toml --all-targets -- -D warnings && cargo test --manifest-path contracts/claim-escrow/Cargo.toml
astro-docs lint
```

### Deploy Workers & Pages (`astrowallet-soroban`)
```bash
# Apply D1 migrations if any new SQL files were added:
# pnpm --filter @astrowallet/server exec wrangler d1 migrations apply astrowallet --remote
# pnpm --filter @astrowallet/server exec wrangler d1 migrations apply astrowallet-mainnet --remote --env=mainnet

pnpm --filter @astrowallet/server exec wrangler deploy --env=""
pnpm --filter @astrowallet/server exec wrangler deploy --env=mainnet

# Always build & deploy Pages from inside apps/pwa/ so apps/pwa/functions/ attaches:
pnpm --filter @astrowallet/pwa build
(cd apps/pwa && ../server/node_modules/.bin/wrangler pages deploy dist --project-name astrowallet-soroban --branch main)
```
> Env var reference: [`ENV_MATRIX.md`](ENV_MATRIX.md).

### Live Smoke Checks
```bash
curl -sS https://astrowallet-soroban.pages.dev/health
curl -sS -H "X-Astro-Network: testnet" https://astrowallet-soroban.pages.dev/health
curl -sS "https://astrowallet-soroban.pages.dev/v1/proxy/oracle/prices?assets=XLM,USDC"
```

---

## 3. Next Priorities
1. **Carbon Block 2 Security Audit:** Client vault (`crypto.ts`, `session-vault.ts`, `AGVAULT`), `bot.ts`, `intents.ts`, `connect.ts`, `proxy.ts`, and `ton-core` / TON Connect v2.
2. **Closed Beta Physical QA:** Live iOS/Android Telegram tests with small amounts (`$5–$20`).
3. **External Contract Audit & Mainnet Cutover:** Audit `contracts/claim-escrow/src/lib.rs`, deploy with `--guardian`, configure Mainnet contract IDs + secrets (`RELAY_SPONSOR_SECRET`, `OZ_CHANNELS_API_KEY`, `SOROSWAP_API_KEY`, `RELAY_CHANNEL_ACCOUNTS`), and finish MoneyGram SEP-10 partner onboarding.
