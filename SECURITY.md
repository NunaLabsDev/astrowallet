# Security Policy

## Non-Custodial Custody & Secret Isolation
AstroWallet is strictly non-custodial:
- BIP-39 / SEP-0005 seed phrases and derived secret keys never leave the user's device.
- Never commit `.env`, `.env.local`, `.dev.vars`, Telegram bot tokens, Cloudflare API tokens, or Stellar `S...` secret keys.
- Runtime secrets live strictly outside git (`~/.secrets/astrowallet/`, `.dev.vars`, or `wrangler secret put`).

## Reporting a Vulnerability
Do **not** open a public GitHub issue for security vulnerabilities (seed exposure, Intent Token bypass, Scan & Shield evasion, relayer abuse, or XSS/CSP bypass).

Please contact the maintainers privately with reproduction details, affected commit/branch, and impact assessment before public disclosure.
