# AstroWallet — Documentation Index

> Check this index (with `rg`, or optional local `astro-docs` CLI/MCP) first and read **only** the doc/section needed for your task. Never bulk-read `docs/`.

| File | ~Lines | Purpose | Status / Freshness Notes |
| :--- | :---: | :--- | :--- |
| [`AGENTS.md`](../AGENTS.md) | 37 | Engineering contract, 7 non-negotiable rules (Mini App + TON ToS §7.3), DoD | **Active** (`GEMINI.md` symlinked) |
| [`README.md`](../README.md) | 83 | Vision, 6 pillars, Mini App + TON overview, live Testnet URLs/IDs | **Active Testnet** (notes `C...` roadmap readiness pending WASM pin) |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 212 | Hexagonal monorepo diagram (`ton-core` incl.), custody, `G...`/`C...`, Scan & Shield, Mini App flow | **Active reference**; verify `C...` gaps in audit §3 |
| [`PLAN.md`](../PLAN.md) | 105 | Phases 0–4 + hardening + Mini App rollout, explicit v2 deferrals | **Testnet-only**; `[x]` items do **not** clear Mainnet blockers |
| [`ENV_MATRIX.md`](ENV_MATRIX.md) | 63 | Client (`VITE_*`) & Server (`wrangler.toml`/secrets) Zod env matrix | **Active**; single env spec alongside `domain/src/config.ts` |
| [`ASTRO_CONNECT_SPEC.md`](ASTRO_CONNECT_SPEC.md) | 90 | Open AstroConnect v1 protocol specification (SEP-53 auth, Clear-Sign XDR, Boomerang, discovery) | **Active Open Standard** |
| [`DEVELOPER_QUICKSTART.md`](DEVELOPER_QUICKSTART.md) | 125 | 5-minute developer guide for `@astrowallet/connect` & `StellarWalletsKit` bridge | **Active Developer Guide** |
| [`AUDIT_2026-11.md`](AUDIT_2026-11.md) | 78 | Full post-`81c4441` + remediation security/UX/Stellar/Soroban audit | **Authoritative blocker list** (updated with latest remediation) |
| [`SESSION_HANDOFF_2026-11-20.md`](SESSION_HANDOFF_2026-11-20.md) | 29 | Notes from `wip/telegram-mini-app` cutover (resolved in `82e5890..81c4441`) | **Historical snapshot** |
| [`NEXT_SESSION_HANDOFF.md`](NEXT_SESSION_HANDOFF.md) | 96 | Live Testnet infra IDs, Mini App + TON state, `AstroID`/intent sync & resume commands | **Active Testnet handoff** (updated with `AstroID` SSO & external intent federation) |
| [`PROPOSAL_TELEGRAM_MINI_APP.md`](PROPOSAL_TELEGRAM_MINI_APP.md) | 84 | Mini App & ToS Clause 7.3 proposal | **APPROVED & IMPLEMENTED** (`2026-11-20`, Rule 7 amended) |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | 165 | Liquid Glass tokens, 5-color palette, Telegram Mini App shell & Navigators | **Active spec** |
| [`FEASIBILITY_OPTIMIZATION_AND_TOOLING.md`](FEASIBILITY_OPTIMIZATION_AND_TOOLING.md) | 106 | 2026 SDK checks (`smart-account-kit`, OZ Channels, Horizon EOL, TON Connect) | **Reference** (verify live `C...` status in audit §5) |
| [`SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) | 79 | SCF 7.0 Integration Track dossier, STRIDE model, Audit Bank KPIs | **Submission dossier** (pre-Mainnet) |
| [`STELLAR_ECOSYSTEM_BENCHMARK.md`](STELLAR_ECOSYSTEM_BENCHMARK.md) | 77 | 2014–2026 Stellar wallets, explorers/scanners, indexer benchmark | **Background research** |
| [`PAST_AND_CURRENT_CASE_STUDIES.md`](PAST_AND_CURRENT_CASE_STUDIES.md) | 57 | Post-mortems of Stellar chat, Telegram & keyless wallets (2017–2026) | **Background research** |

- Supporting root docs: [`CONTRIBUTING.md`](../CONTRIBUTING.md) (25L), [`SECURITY.md`](../SECURITY.md) (12L).
- Scoped agent rules (1-level under `.agents/rules/`): [`hexagonal-boundaries.md`](../.agents/rules/hexagonal-boundaries.md) (glob), [`custody-and-telegram.md`](../.agents/rules/custody-and-telegram.md) (model_decision), [`env-and-zod.md`](../.agents/rules/env-and-zod.md) (model_decision).

> [!CAUTION]
> **Reality Check:** `origin/main` shipped the Telegram-exclusive Multichain Mini App (`Stellar + TON`), Zero-Knowledge `AGVAULT` backup sync, `ClaimEscrowContract` V2.2 (`11` Rust tests), Express Sign (`?express=1`, configurable 15/30/60m session lease), `/buy`, `/sell`, `/nft` + `/nft send`, 5-Way `/swap`, MoneyGram SEP-10 `client_domain` (`/.well-known/stellar.toml`), and ASTRO Ecosystem `AstroID` SSO (`174+` Vitest tests, `pnpm secret-scan` clean). User-facing AstroGate/Sorobits UI and bot references were removed (deferred to future NFT phase). **Do not deploy new Mainnet contracts** until the remaining blockers in [`AUDIT_2026-11.md`](AUDIT_2026-11.md) (`C...` Smart Account WASM & `secp256r1` passkey, MoneyGram partner allowlisting, and external audit) are resolved.
