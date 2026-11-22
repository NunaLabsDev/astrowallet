# `@astrowallet/connect`

Open, lightweight Stellar & Soroban wallet connection SDK for Telegram Mini Apps (**AstroConnect v1**).

- **Zero runtime dependencies** — pure Web Crypto Ed25519 + SHA-256 SEP-53 verification (~5 KB, zero `@stellar/stellar-sdk` bloat).
- **Telegram ToS §7.3–7.4 compliant** — uses native `https://t.me/<bot>/<short>?startapp=...` deep links and Boomerang return instead of forbidden `window.stellar` or non-TON WalletConnect injections.
- **Classic (`G...`) + Soroban (`C...`) ready** — supports SEP-53 Sign-In (`login`), arbitrary message signing (`signMessage`), Clear-Sign XDR execution (`signTransaction` in `submit` or `signOnly` mode), `AstroID` directory resolution (`resolveIdentity`), and `@creit.tech/stellar-wallets-kit` drop-in integration (`createAstroWalletKitModule`).

See [`../../docs/DEVELOPER_QUICKSTART.md`](../../docs/DEVELOPER_QUICKSTART.md) and [`../../docs/ASTRO_CONNECT_SPEC.md`](../../docs/ASTRO_CONNECT_SPEC.md) for full integration guides.
