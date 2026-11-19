# Past & Current Stellar Chat, Mobile & Keyless Wallet Case Studies (2017–2026)

This document captures verified operational realities, custody architectures, failures, and pivots of past and active Stellar chat/Telegram/mobile/keyless wallets so **AstroWallet** avoids repeating historical mistakes.

---

## 1. Past & Discontinued Projects (Why They Died or Pivoted)

| Project | Era / Funding | Custody & Technical Model | Current Status | Why It Died / Pivoted |
| :--- | :--- | :--- | :--- | :--- |
| **`@PapayaBot` / `apay.io`** | 2017–2022 | **Custodial** Telegram bot + Stellar anchor bridging BTC/ETH/USDT; *"no private keys"* tied to Telegram account | **Dead (Solvency Collapse)** | Mid-2022 shortfall: out of ~$1.5M in user funds, <$100K remained accessible. Proved server-custodial chat bots carry fatal security/solvency risk. |
| **Keybase Stellar** | 2019–2023 | **Non-custodial E2EE sync** (`username*keybase.io` Federation + Paper Keys) | **Dead (Deprecated late 2023)** | 2B XLM Space Drop canceled after 3 months (~300M XLM) due to Sybil bot farms; later acquired by Zoom (2020) and Stellar wallet removed in 2023. |
| **Paysapp** | 2019–2020 (SCF #3) | **Custodial server-hosted** WhatsApp/Telegram bot (`github.com/kuyawa/paysapp`) | **Dead** | Maintainer drop-off, messaging API/Twilio friction, and server-side key custody liability. |
| **StellarTipBot** | Dec 2022 (SCF #11, $10K) | **Custodial** Telegram group tipping bot (XLM, tokens, NFTs) | **Unmaintained / Dead** | Post-grant maintainer inactivity + custodial bot liability. |
| **Mobius Tip Bot** | 2018–2022 | **Custodial** Ruby Telegram tipping bot | **Dead** | Organization stalled; servers shut down. |
| **Solar Wallet** | 2019–2022 (SatoshiPay) | **Non-custodial** open-source multisig + SEP-6 mobile/desktop wallet | **Abandoned by creator; forked as Sunce Wallet** | SatoshiPay pivoted to Pendulum; open-source non-custodial design allowed Montelibero community to keep **Sunce Wallet** alive. |
| **Leaf Global Fintech** | 2018–2023 | **Custodial** USSD + smartphone wallet for refugees/unbanked | **Acquired & Absorbed** | Acquired by IDT (Mar 2022) and folded into **Boss Money** (Feb 2023). |
| **ClickPesa** | 2019–Present | Legacy TZS Stellar anchor → **BoT-regulated PSP + Soroban institutional MFI/RWA lending** | **Pivoted to B2B/MFI** | Regulatory requirements + B2B economics outperformed retail crypto anchoring. |
| **Vibrant → Vesseo** | 2020–Present (Sunship/SDF) | **Non-custodial** (seed + **SEP-30** phone/2FA recovery) | **Alive (Rebranded Apr 2025)** | Rebranded to **Vesseo** (`vesseoapp.com`) for global freelancer neobank positioning (virtual US accounts, cards); ~4.6★ App Store. |

---

## 2. Current Active Chat, Telegram & Passkey Projects (2025–2026)

| Project | Live Status (Nov 2026) | How It Works Under the Hood | Strengths & Real-World Limits |
| :--- | :--- | :--- | :--- |
| **Walt (`@walt`, ex-Wallet in Telegram)** | **Live** (`walt.io`, rebranded Sep 2026) | XLM lives in **custodial** Walt tier (NOT TON Space/DeFi Account). Supports XLM deposits (`0.0084 XLM` min), swaps vs USDT, withdrawals. | **100M+ distribution**, zero seed phrase; **NO Soroban dApps**, **NO custom Stellar trustlines**, frequent KYC freezes, and user errors from missing CEX Memos. |
| **HOT Wallet (`hot-labs.org`)** | **Live** (TMA + iOS/Android + Chrome) | **MPC / DKG Ed25519** via HOT Protocol; abstracts 1 XLM reserve; swaps via **Soroswap + Aquarius**; WalletConnect + NEAR Intents bridge. | Adapted to Jan 2025 Telegram TON ToS via **Clause 7.3** (multichain wallet exemption) **AND** shipped standalone iOS/Android + Chrome extension to escape TMA sandbox limits. |
| **Strooper → Freelii** | **Strooper: 2024 prototype**; **Freelii: Active (SCF #32)** | Started as TMA + Soroban Passkey (`secp256r1`) hackathon prototype. | **Crucial UX lesson:** Field-testing chat remittance in the Philippines showed **user trust barriers around managing money purely inside messaging apps**, driving a pivot to **Freelii**'s dedicated mobile/fintech UI. |
| **JUMPA (`usejumpa.com`, SCF #44 $89.7K)** | **Live Nigeria-first launch** | AI chat/voice money app generating exportable multi-chain keys (`PIN`-confirmed) + Nigerian bank/card rails + group Circles. | Live app focuses on in-app AI chat + local KYC rather than WhatsApp/USSD channels originally pitched. |
| **SoroPass (`soropass.dev`, SCF #44 $95K)** | **Active SDK/Module** | `@soropass/core` + Stellar Wallets Kit module for `secp256r1` passkeys. | Composable UI/SDK layer (not a standalone consumer wallet). |
| **Passkey Kit / Smart Account Kit** | **Active (`smart-account-kit` is prod)** | `stellar/smart-account-kit` (OpenZeppelin `stellar-contracts`) + **OpenZeppelin Relayer + Stellar Channels** (**note: `stellar/launchtube` was retired & archived March 2026**). | **KALE** (`kalefarm.xyz`) proved passkeys at mainnet scale; origin-bound WebView passkey issues mitigated via multi-signer / session keys. |
| **Read-Only / Event Bots (`SorobanHooks`, `mimir-stellar/telegram-bot`)** | **Alive & Maintained** | Strictly non-custodial: poll Soroban RPC/events and push Telegram alerts/webhooks. | Survive long-term because they hold **zero private keys** and **zero user funds**. |

---

## 3. Current Consumer Mobile & Keyless Wallets (2025–2026 Status)

| Wallet | Live Status (Nov 2026) | Custody & Recovery | Gas & Monetization | Real UX Strengths & Friction |
| :--- | :--- | :--- | :--- | :--- |
| **Beans App (`beansapp.com`)** | **Mainnet Active** | On-device non-custodial key + **SEP-30 split-key recovery** (Beans key + independent provider key + Email/PIN 2FA) | Sponsors XLM fees & reserves; 0% fee on **Beans Earn** (Blend + DeFindex); MoneyGram SEP-24 + FX spreads | Zero-XLM UX + global cash-out; ~3.1/5 Trustpilot due to PIN recovery hiccups and MoneyGram KYC friction. |
| **Decaf (`decaf.so`)** | **Mainnet Active** (10K+ DL, ~4.4–4.6★) | Custom encrypted key-sharding via Google/Apple/email + passkeys + seed export (Stellar + Solana) | Gasless UX (sponsored); Visa card fees, FX/ramp spreads, Decaf Pay | Slick neobank UX + Visa + MoneyGram; complaints on KYC rejections, occasional UI freezes, bot support. |
| **Meru (`getmeru.com`)** | **Mainnet Active** (LatAm) | Hybrid app-layer self-custody | US ACH/EU IBAN, Visa card (~1–1.2% FX), Blend yield; users pay Web3 gas | Strong LatAm banking rails; ~2/5 Trustpilot from aggressive AML/compliance account blocks. |
| **Bexo (`bexo.app`, SCF #44 $90K)** | **Mainnet Active** | Native BIP44 seed phrase (*autocustodia real*) | Swaps + local LatAm QR merchant conversion fees | Real merchant QR payments + privacy mode; still requires manual seed phrase backup. |
| **TroqPay (`troqpay.com`, SCF #44 $60K)** | **Capped B2B Mainnet Pilot** | Embedded **Privy** self-custodial wallets + DeFindex | B2B merchant Pix→USDC pricing | Strong Pix-to-USDC merchant flow; not an open consumer wallet. |
| **Sollpay (`sollpay.com`, SCF #38 $118K)** | **Mainnet, Momentum Stalled** | Account Abstraction + ZK email/phone + biometrics | AA gas abstraction; swaps/PayFi | Very low 2026 adoption, quiet GitHub repos, last minor update Feb 2026, opaque ZK internals. |

---

## 4. Six Non-Negotiable Design Rules for AstroWallet (Learned from History)

1. **Never build a server-custodial Telegram bot:** `@PapayaBot`, `Paysapp`, `StellarTipBot`, and `Mobius` prove server-held keys/balances either get abandoned or collapse catastrophically. Telegram bots survive when they are **non-custodial / read-only** (`SorobanHooks`, `mimir-stellar/telegram-bot`) or hand off signing safely.
2. **Do not trap serious custody solely inside a Telegram WebView:** Both **Strooper → Freelii** (user trust field test) and **HOT Wallet** (rapid 2025 expansion to standalone iOS/Android/Chrome + ToS Clause 7.3) confirm users trust a dedicated **Mobile PWA / App** for custody, while Telegram shines for alerts, social P2P links, and viral discovery.
3. **Replace retired `Launchtube` with `OpenZeppelin Relayer + Stellar Channels`:** `stellar/launchtube` was archived in March 2026; greenfield smart accounts must build on `smart-account-kit` (unscoped npm package) + OpenZeppelin Channels/Relayer (covering tx gas fees, not Classic `CAP-33` reserves).
4. **Never rely on FaceID-only or Passkey-only auth without seed recovery:** WebAuthn is origin-bound, fails across embedded Telegram WebViews, and many target phones lack FaceID hardware. Always make **SEP-0005 seed + mandatory Argon2id PIN/Passphrase + optional Fingerprint** the universal baseline, pairing any optional `C...` Smart Account with an on-chain **`G...` Ed25519 Guardian**.
5. **Maintain 100% open-source non-custodial portability (SEP-0005):** When **Solar Wallet** stopped, users migrated seamlessly and the community forked **Sunce Wallet** because keys were local and code was MIT/open-source.
6. **Prevent CEX Memo disasters & spam before they happen:** Even Telegram's `@wallet` / Walt suffers constant "missing memo" support tickets—AstroWallet must enforce **SEP-29** (`config.memo_required`) and `M...` muxed support natively.
