# Astro Wallet — Documentation Index

> Check this index first (with `rg`, or `astro-docs` CLI/MCP) and read **only** the doc/section needed for your task. Never bulk-read `docs/`.

| File | ~Lines | Purpose | Status |
| :--- | :---: | :--- | :--- |
| [`AGENTS.md`](../AGENTS.md) | 37 | Engineering contract, 7 non-negotiable rules (Mini App + TON ToS §7.3), DoD | **Active** (`GEMINI.md` symlinked) |
| [`README.md`](../README.md) | 90 | Vision, 6 pillars, Mini App + TON overview, live Mainnet/Testnet URLs & IDs | **Active** |
| [`ARCHITECTURE.md`](../ARCHITECTURE.md) | 212 | Hexagonal monorepo diagram (`ton-core` incl.), custody, `G...`/`C...`, Scan & Shield, Mini App flow | **Active reference** (`C...` gated in audit) |
| [`ENV_MATRIX.md`](ENV_MATRIX.md) | 78 | Client (`VITE_*`) & Server (`wrangler.toml`/secrets) Zod env matrix | **Active** |
| [`ASTRO_CONNECT_SPEC.md`](ASTRO_CONNECT_SPEC.md) | 90 | Open AstroConnect v1 protocol specification (SEP-53 auth, Clear-Sign XDR, Boomerang, discovery) | **Active Open Standard** |
| [`DEVELOPER_QUICKSTART.md`](DEVELOPER_QUICKSTART.md) | 125 | 5-minute developer guide for `@astrowallet/connect` & `StellarWalletsKit` bridge | **Active Developer Guide** |
| [`AUDIT_2026-11.md`](AUDIT_2026-11.md) | 75 | Consolidated Security Audit (Audits #1–#5 + Carbon Block 1) & remaining Pre-Mainnet GA gates | **Authoritative Audit Tracker** |
| [`NEXT_SESSION_HANDOFF.md`](NEXT_SESSION_HANDOFF.md) | 55 | Live Mainnet/Testnet IDs, deploy/verify commands, and next priorities | **Active Operations Handoff** |
| [`NAMING.md`](NAMING.md) | 30 | Naming standard: brand names vs stable technical identifiers | **Active Spec** |
| [`DESIGN_SYSTEM.md`](DESIGN_SYSTEM.md) | 165 | Liquid Glass tokens, 5-color palette, Telegram Mini App shell & Navigators | **Active Spec** |
| [`SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md`](SCF_7_SUBMISSION_AND_STRIDE_THREAT_MODEL.md) | 79 | SCF 7.0 Integration Track dossier, STRIDE model, Audit Bank KPIs | **Submission Dossier** |

- Supporting docs: [`CONTRIBUTING.md`](../CONTRIBUTING.md), [`SECURITY.md`](../SECURITY.md), [`packages/connect-sdk/README.md`](../packages/connect-sdk/README.md).
- Scoped agent rules (`.agents/rules/`): [`hexagonal-boundaries.md`](../.agents/rules/hexagonal-boundaries.md), [`custody-and-telegram.md`](../.agents/rules/custody-and-telegram.md), [`env-and-zod.md`](../.agents/rules/env-and-zod.md).

> [!CAUTION]
> **Reality Check (`0cd5306`):** Live on Cloudflare Mainnet (`astrowallet-server-mainnet`), Testnet (`astrowallet-server`), and Pages (`https://astro-wallet.pages.dev`) with D1 `0001..0009`, **221/221 Vitest tests (38 files)**, **15/15 Rust tests**, and Carbon Block 1 (`HALLAZGO-01..07`) closed in code. **Do not deploy new Mainnet contracts** or enable `SMART_ACCOUNT_WASM_HASH` until the remaining gates in [`AUDIT_2026-11.md`](AUDIT_2026-11.md) are resolved.
