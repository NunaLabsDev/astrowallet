# AstroWallet — Operations & Next Session Handoff

> **Live State (Carbon Block 2, 2026-11-26):** Deployed live on Cloudflare **Mainnet** (`astro-wallet-server-mainnet`), **Testnet** (`astro-wallet-server`), and **Pages** (`https://astro-wallet.pages.dev`). Carbon Block 1 (`HALLAZGO-01..07`) & Carbon Block 2 (`HALLAZGO-08..17`) closed and verified. See [`AUDIT_2026-11.md`](AUDIT_2026-11.md) for remaining Mainnet GA gates.

---

## 1. Live Infrastructure Inventory

| Component | Identifier | Notes |
| :--- | :--- | :--- |
| **GitHub Repo** | `NunaLabsDev/astrowallet` (`main` branch) | Independent repo |
| **Mini App & Origin** | `https://astro-wallet.pages.dev` (`t.me/AstroWalletAppBot/wallet`) | Pages project `astro-wallet` (`./functions` proxy routes by `X-Astro-Network`) |
| **Telegram Super-Bot** | `@AstroWalletAppBot` (`17` commands) | Webhook `/tg/webhook` (query `?network=testnet` for Testnet routing) |
| **Mainnet Worker** | `astro-wallet-server-mainnet` (`workers_dev = false`) | D1 `astrowallet-mainnet` (`b67e7931-e091-418b-84ad-5c8003d2c421`, `0001..0009`) · KV `a21e4dfbbc9e45d1bdb7a6e3bf9606b3` |
| **Testnet Worker** | `astro-wallet-server` (`workers_dev = false`) | D1 `astrowallet` (`12b7f77d-5467-44a6-a4b3-11ccd63a315c`, `0001..0009`) · KV `3389ff9f05414c219d912e82a7a84baa` |
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

### Deploy Workers & Pages (`astro-wallet`)
```bash
# Apply D1 migrations if any new SQL files were added:
# pnpm --filter @astrowallet/server exec wrangler d1 migrations apply astrowallet --remote
# pnpm --filter @astrowallet/server exec wrangler d1 migrations apply astrowallet-mainnet --remote --env=mainnet

pnpm --filter @astrowallet/server exec wrangler deploy --env=""
pnpm --filter @astrowallet/server exec wrangler deploy --env=mainnet

# Always build & deploy Pages from inside apps/pwa/ so apps/pwa/functions/ attaches:
pnpm --filter @astrowallet/pwa build
(cd apps/pwa && ../server/node_modules/.bin/wrangler pages deploy dist --project-name astro-wallet --branch main)
```
> Env var reference: [`ENV_MATRIX.md`](ENV_MATRIX.md).

### Live Smoke Checks
```bash
curl -sS https://astro-wallet.pages.dev/health
curl -sS -H "X-Astro-Network: testnet" https://astro-wallet.pages.dev/health
curl -sS "https://astro-wallet.pages.dev/v1/proxy/oracle/prices?assets=XLM,USDC"
```

---

## 3. Next Priorities
1. **BotFather & Companion Repos Sync:** Update BotFather Mini App URL to `https://astro-wallet.pages.dev/app`, and update `ASTROWALLET_API_BASE_URL` in `AstroGate` & `ASTROdex` to `https://astro-wallet.pages.dev`.
2. **Closed Beta Physical QA:** Live iOS/Android Telegram tests with small amounts (`$5–$20`) across `V4R2` / `V5R1` TON & Stellar Testnet/Mainnet.
3. **External Contract Audit & Mainnet Cutover:** Audit `contracts/claim-escrow/src/lib.rs`, deploy with `--guardian`, configure Mainnet contract IDs + secrets (`RELAY_SPONSOR_SECRET`, `OZ_CHANNELS_API_KEY`, `SOROSWAP_API_KEY`, `RELAY_CHANNEL_ACCOUNTS`), and finish MoneyGram SEP-10 partner onboarding.
