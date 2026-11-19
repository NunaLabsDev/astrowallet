# Contributing to AstroWallet

Thank you for contributing to AstroWallet! Before submitting any pull request, read:
1. [`README.md`](README.md)
2. [`AGENTS.md`](AGENTS.md)
3. [`ARCHITECTURE.md`](ARCHITECTURE.md)
4. [`docs/DESIGN_SYSTEM.md`](docs/DESIGN_SYSTEM.md)

## Non-Negotiable Checks
Every change must pass the full verification suite locally before review:

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm secret-scan
```

## Rules Summary
- **Zero Hardcoding:** All endpoints, network passphrases, contract IDs, and secrets must flow through Zod-validated config in `@astrowallet/domain`.
- **Hexagonal Boundaries:** Keep imports strictly within the dependency DAG enforced by `eslint.config.mjs`.
- **Universal Mobile Auth:** Never require FaceID hardware or FaceID-only UI copy; support PIN/Passphrase + optional Fingerprint.
- **No Fake Runtime Mocks:** Production/Testnet app paths must talk to real Stellar endpoints; mocks belong strictly inside `*.test.ts`.
