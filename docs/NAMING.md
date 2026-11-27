# Astro Naming Standard

Single source of truth for names. Use **display names** in anything users read; keep **technical identifiers** stable unless a coordinated migration is approved.

| Layer | Name | Where |
| :--- | :--- | :--- |
| Project / organization | **Astro Soroban** | `stellar.toml` `ORG_NAME`, docs, pitch material |
| Ecosystem | **Astro** | Umbrella term for the three products |
| Product 1 | **Astro Wallet** | PWA title, manifest, Telegram bot display name |
| Product 2 | **Astro Gate** | Launchpad (separate repo) |
| Product 3 | **Astro Dex** | Trading terminal (separate repo, not launched) |

## Technical identifiers (do not rename ad hoc)

| Identifier | Current value | Why stable |
| :--- | :--- | :--- |
| Public origin | `https://astro-wallet.pages.dev` | CSP, CORS, SEP-10 `client_domain`, bot webhook |
| Legacy origin | `https://astrowallet-soroban.pages.dev` | Temporary entry in `ALLOWED_ORIGINS`; ASTROdex already migrated, remove after AstroGate is confirmed |
| Workers | `astro-wallet-server` (testnet), `astro-wallet-server-mainnet` | Service Bindings, Durable Objects, Wrangler secrets |
| Legacy Workers | `astrowallet-server`, `astrowallet-server-mainnet` | Kept without cron triggers until deletion is approved; the Free plan allows only 5 cron triggers per account |
| Telegram bot | `@AstroWalletAppBot` | Username changes only via BotFather and break `t.me` links |
| GitHub repo | `NunaLabsDev/astrowallet` | Remote URLs of all clones |
| Packages | `@astrowallet/*` | Workspace imports |

## Rules

1. Visible text: "Astro Wallet" (with space). Code, slugs, env vars: `astrowallet` / `ASTROWALLET_*`.
2. Never describe the project as "AstroWallet" alone; the project is **Astro Soroban**.
3. Do not change protocol strings (login-proof message, SEP-10 domains) without a versioned migration.
4. A technical rename needs a coordinated session across all three repos plus Wrangler, Telegram and DNS, and explicit approval.
