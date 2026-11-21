# AstroWallet — Design System & Visual Identity ("Apple Liquid Glass × Astro Navigators")

> **Scope:** UI/UX architecture, color tokens, Apple Liquid Glass surface system, mobile performance budgets, universal authentication UX, and the independent **Astro Navigators** collectible visual language for `apps/pwa` and Telegram companion cards.

---

## 1. Visual Philosophy & Design Pillars

1. **Apple Liquid Glass Precision:** Layered translucent glass panes floating over a deep cosmic navy atmosphere (`#172C69`), defined by crisp `1px` specular top/inner rim highlights, subtle refraction gradients, and fluid spring physics (`cubic-bezier(0.22, 1, 0.36, 1)`).
2. **Financial Legibility Above Ornamentation:** Glass is never allowed to compromise numerical clarity. Balances, XLM/USDC amounts, asset tickers, and addresses always sit on controlled contrast surfaces with `font-variant-numeric: tabular-nums` and strict WCAG AA/AAA ink contrast.
3. **Universal Mobile Ergonomics (Zero FaceID Assumption):** Every action is designed for one-handed smartphone thumb reach (`44x44pt` minimum touch targets, bottom glass dock + swipeable glass bottom sheets). Authentication prompts always emphasize **PIN / Passphrase + optional Fingerprint / Device Biometrics**—never FaceID-specific icons or requirements.
4. **Honest Dual-Account Visual Clarity:** Users see their linked **Classic (`G...`)** and optional **Smart (`C...`)** accounts clearly labeled by role and capability (distinct glass badges and deterministic Astro Navigator avatars) rather than hiding Stellar protocol boundaries behind misleading abstractions.
5. **100% Independent Collectible Visual IP:** Inspired by the *concept* of multi-pose collectible characters, **Astro Navigators** is a wholly original visual identity created from scratch for AstroWallet—completely independent in character design, silhouette, traits, and naming from any third-party or sibling launchpad IP.

---

## 2. Official 5-Color Brand Palette & Semantic Tokens

### Core Palette Specification

| Token Name | Official Role | HEX | RGB | CSS Custom Property |
| :--- | :--- | :--- | :--- | :--- |
| **Solar Blaze** *(Naranja)* | Primary CTA energy, send/boost accents, alert highlights | `#F15A24` | `rgb(241, 90, 36)` | `--aw-solar-blaze` |
| **Stellar Gold** *(Amarillo dorado)* | Rewards, verified badges, claimable highlights, high-visibility warning accents | `#F5C928` | `rgb(245, 201, 40)` | `--aw-stellar-gold` |
| **Cosmic Purple** *(Morado)* | Smart Account (`C...`) accents, Soroban/DeFi gradients, active states | `#8050C8` | `rgb(128, 80, 200)` | `--aw-cosmic-purple` |
| **Nebula Lavender** *(Violeta claro)* | Secondary labels, focus rings, glass rim tints, soft interactive chips | `#A58BE0` | `rgb(165, 139, 224)` | `--aw-nebula-lavender` |
| **Deep Space Navy** *(Azul oscuro)* | Primary atmospheric canvas anchor, deep glass backing, high-contrast dark ink | `#172C69` | `rgb(23, 44, 105)` | `--aw-deep-space-navy` |

### Extended Neutrals & Contrast Guardrails

To preserve WCAG AA/AAA legibility on mobile OLED displays without breaking the 5-color identity:

```css
:root {
  /* Official 5-Color Core */
  --aw-solar-blaze: #F15A24;       /* rgb(241, 90, 36) */
  --aw-stellar-gold: #F5C928;      /* rgb(245, 201, 40) */
  --aw-cosmic-purple: #8050C8;     /* rgb(128, 80, 200) */
  --aw-nebula-lavender: #A58BE0;   /* rgb(165, 139, 224) */
  --aw-deep-space-navy: #172C69;   /* rgb(23, 44, 105) */

  /* Atmospheric Depth & Ink Derived from Deep Space Navy */
  --aw-space-void: #0B1433;        /* Deepened #172C69 for OLED contrast */
  --aw-ink-primary: #F8FAFF;       /* Primary text on dark glass */
  --aw-ink-secondary: #C8CBE8;     /* Muted labels on dark glass */
  --aw-ink-on-gold: #101D47;       /* Mandatory dark ink on #F5C928 (never white text on gold) */
  --aw-ink-on-orange: #FFFFFF;     /* Bold >=16px CTA text on #F15A24 */

  /* Protocol Semantic Accents */
  --aw-safe-emerald: #22C55E;      /* Verified / confirmed state */
  --aw-danger-crimson: #EF4444;    /* Malicious / blocked / drainer warning */

  /* Brand Signature Gradients */
  --aw-grad-aurora: linear-gradient(135deg, #F15A24 0%, #8050C8 55%, #172C69 100%);
  --aw-grad-orb-glow: radial-gradient(circle at 20% 15%, rgba(241, 90, 36, 0.28), transparent 45%),
                      radial-gradient(circle at 85% 25%, rgba(128, 80, 200, 0.32), transparent 50%),
                      radial-gradient(circle at 50% 90%, rgba(165, 139, 224, 0.16), transparent 55%);
}
```

**Strict Color & 60/30/10 Banking-Trust Psychology Rules:**
- **60% Sovereign Banking Navy (`#060E24` / `#172C69`):** Anchors all primary backdrops, portfolio surfaces, and Classic `G...` vaults so balances feel permanent, calm, and institutional rather than speculative.
- **30% Frosted Vault Glass & Royal Amethyst (`#8050C8` / `#A58BE0`):** Identifies Soroban Smart Accounts (`C...`), Swap/Ramp liquidity tools, and Telegram social layers with crisp `1px` specular glass edges.
- **10% Vault Gold (`#F5C928`) & Controlled Solar Blaze (`#F15A24`):**
  - **Stellar Vault Gold** (`#F5C928`) is used strictly for verified seals, reserve reclaims, and Classic `G...` vault corners—always paired with `--aw-ink-on-gold` (`#0B1433`) to guarantee >= 7:1 contrast (never white text over gold).
  - **Solar Blaze** (`#F15A24`) is reserved strictly for intentional primary action triggers (`Send`, `Confirm`, `Claim`)—never flood entire screen backgrounds with solid orange.
  - **Trust Emerald** (`#10B981`) drives the live non-custodial posture strip (`Self-Custodial SEP-0005 · 0 Server Keys`) and confirmed settlement indicators.

---

## 3. Apple Liquid Glass Elevation System

Every container in `apps/pwa` maps to one of five standardized glass tokens so depth hierarchy stays predictable and GPU-friendly:

| Elevation Token | Use Case | Backdrop Blur | Surface Fill | Specular Rim & Shadow |
| :--- | :--- | :--- | :--- | :--- |
| **`glass-canvas`** | Root viewport backdrop | `none` (static ambient orbs) | `#0B1433` + `#172C69` radial orbs | Zero blur cost; ambient glow via CSS gradients |
| **`glass-card`** | Portfolio cards, account switchers, activity rows | `blur(16px) saturate(160%)` | `rgba(23, 44, 105, 0.48)` | `1px solid rgba(165, 139, 224, 0.24)` + top inner highlight `inset 0 1px 0 rgba(255,255,255,0.22)` |
| **`glass-sheet`** | **Scan & Shield** bottom sheet, Send/Swap drawers, PIN/Fingerprint modal | `blur(24px) saturate(180%)` | `rgba(14, 26, 68, 0.76)` | `1px solid rgba(165, 139, 224, 0.34)` + `0 20px 48px rgba(7, 13, 36, 0.65)` |
| **`glass-pill`** | Network badge (`TESTNET` / `MAINNET`), account chips (`G...` / `C...`), Telegram `@handle` tags | `blur(10px) saturate(140%)` | `rgba(128, 80, 200, 0.22)` | `1px solid rgba(165, 139, 224, 0.32)` |
| **`glass-dock`** | Floating bottom navigation bar (`Stellar`, `TON`, `Activity`, `NFTs`, `Vault`) | `blur(20px) saturate(175%)` | `rgba(18, 34, 86, 0.72)` | `1px solid rgba(255, 255, 255, 0.18)` + pill active indicator tinted `#F15A24` / `#8050C8` |

### Mobile GPU & Accessibility Guardrails (Mandatory)
1. **Strict Blur Budget:** Never render more than **2–3 overlapping `backdrop-filter` layers** simultaneously in the viewport. Scrollable lists must place `glass-card` on the parent section or keep row blurs lightweight (`<= 12px`) to maintain 60fps scrolling on mid-range Android devices.
2. **Reduced Transparency Support:**
   ```css
   @media (prefers-reduced-transparency: reduce) {
     .glass-card, .glass-sheet, .glass-dock {
       backdrop-filter: none;
       -webkit-backdrop-filter: none;
       background: rgba(16, 29, 71, 0.96);
     }
   }
   ```
3. **Reduced Motion Support:**
   ```css
   @media (prefers-reduced-motion: reduce) {
     * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; }
   }
   ```
4. **Safe-Area & PWA Viewport Compliance:** Always pad top headers (`env(safe-area-inset-top)`) and bottom `glass-dock` (`env(safe-area-inset-bottom)`) using `100dvh` so iOS Home Screen PWAs and Android edge-to-edge displays never clip controls.

---

## 4. Universal Authentication & Signing UX Rules

- **No FaceID-Only Assumptions:** Hardware availability varies wildly across Android devices, older phones, and desktop browsers. Never gate onboarding or signing behind FaceID, and never label buttons exclusively as "Sign with FaceID".
- **Standard Copy & Icons:** Use **"Unlock with PIN"** / **"Use Biometrics"** paired with universal lock/fingerprint glyphs (`fingerprint` / `lock`).
- **Signing Hierarchy inside Telegram Mini App:**
  1. **Universal Mandatory Baseline:** 6+ character PIN or custom passphrase (Argon2id Web Worker KDF + AES-GCM-256 IndexedDB vault). Works offline across 100% of Telegram WebViews.
  2. **Telegram Native Biometrics + SecureStorage:** `Telegram.WebApp.BiometricManager` + Bot API 9.0 device-local `SecureStorage` (iOS Keychain / Android Keystore — never `CloudStorage`), falling back cleanly to standard WebAuthn (`userVerification: "preferred"`) when outside native Telegram biometric bridges.
  3. **Mini App Cache-Eviction Backup Reminder:** `IosBrowserGuard` reminds uninitialized users and intent signers that clearing Telegram's app cache erases local WebView storage, prompting offline 12-word backup or `.agvault.json` encrypted export.

---

## 5. "Astro Navigators" — Independent Collectible Visual System

AstroWallet incorporates an expressive, modular visual identity called **Astro Navigators**—a cosmic explorer avatar & badge system that reacts to real wallet states and differentiates linked accounts at a glance.

> **IP Independence Guarantee:** Astro Navigators is 100% original artwork designed exclusively around AstroWallet's 5-color orbital palette (`#F15A24`, `#F5C928`, `#8050C8`, `#A58BE0`, `#172C69`). It shares zero assets, species motifs, or naming with any external or launchpad project.

### A. Deterministic Account Avatar Generator
Because one **SEP-0005** seed phrase manages multiple derived accounts (`m/44'/148'/0'`, `'1'`, `'2'`, ...) plus optional Smart Accounts (`C...`), each address deterministically derives a unique visual Navigator from `SHA-256(publicKey)`:

| Hash Slice | Trait Category | Deterministic Options |
| :--- | :--- | :--- |
| Bytes `0–1` | **Visor Geometry** | Orbital Dome, Hex Visor, Prism Split, Nova Crest |
| Bytes `2–3` | **Primary Armor Tint** | Solar Blaze (`#F15A24`), Cosmic Purple (`#8050C8`), Stellar Gold (`#F5C928`), Nebula Lavender (`#A58BE0`) |
| Bytes `4–5` | **Constellation Emblem** | 16 geometric star-map glyphs etched on chest plate |
| Bytes `6–7` | **Orbital Halo / Aura** | Single Ring, Twin Orbit, Nebula Flare, Shield Grid |
| Account Kind | **Role Frame** | **Classic (`G...`)**: Deep Space Navy hexagonal frame · **Smart (`C...`)**: Cosmic Purple luminous ring |

All traits are composed as **pure client-side `32×32` crisp-pixel (`shape-rendering="crispEdges"`) SVG layers** (`AstroWalletLogo.tsx`, `favicon.svg`, `AstroNavigatorAvatar.tsx`), inspired by the crisp genomic pixel aesthetic of **NunaLabs Sorobits (SEP-50)** while maintaining 100% original AstroWallet vault character IP and zero network requests.

### C. Live On-Chain Sorobits (SEP-50) Integration
- Configured purely via `VITE_SOROBITS_CONTRACT_ID` (zero hardcoded contract IDs in source):
  - `CollectiblesSheet` (`NFTs` tab) queries `tokens_of`, `get_sorobit`, `token_uri`, and `animated_svg` from the NunaLabs Sorobits contract via Soroban RPC failover (`fetchOwnerSorobits`), and automatically loads the multi-token live showcase (`fetchSorobitShowcase`) when an account currently holds `0` Sorobits.
- Renders verified on-chain `32×32` animated pixel SVG collectibles safely inside `<img src="data:image/svg+xml;utf8,..." />` (`image-rendering: pixelated`).

---

## 6. Telegram-Exclusive Single-Surface Mini App Architecture (`/app` & `/intent/*`)

- **Zero Public Website (`TelegramOnlyGate`):** Standalone landing pages are removed; opening outside Telegram displays a clean Liquid Glass prompt to launch `@AstroWalletAppBot` inside Telegram (bypassable only via `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM=true` on Testnet dev).
- **Unified Mini App Shell (`App.tsx`, `ModalDrawer.tsx`, `OnboardingSheet.tsx`, `TonWalletSheet.tsx`, `TonConnectSheet.tsx`):**
  - Single-column responsive Liquid Glass stage (`max-width: 820px`) with **always-visible** compact header (Telegram `@username` + TON Connect status + network badge + Lock) and 5-tab floating Liquid Glass Bottom Dock (`Stellar`, `TON`, `Activity`, `NFTs`, `Vault`).
  - Full Telegram SDK integration: `--tg-safe-area-inset-top` / `--tg-safe-area-inset-bottom` CSS padding, native `BackButton` stack handling (`pendingTonConnectTx` → `activeDrawer` → `intentRoute` → `wallet` tab), `HapticFeedback` on tab changes/approvals/errors, and `ClosingConfirmation` during active transfers, swaps, onboarding, or seed reveal.
  - Guided 2-step vault creation (`3×4` numbered seed grid + 3-word backup quiz → PIN setup) and uncluttered `Stellar` hero balance card with 4 quick actions (`Send`, `Receive`, `Swap`, `Scan & Shield`) and 2×2 suite launcher cards (`Swap & Path Router`, `Scan & Shield`, `Classic & Reserves`, `CCTP Precision`) plus **Dev Lab** & **TON Connect v2** drawers.

### B. Animated + Static State Variants

Each Astro Navigator supports **6 behavioral states** with both a rich **animated variant** (CSS/WAAPI transforms or lightweight dotLottie `< 40 KB` per asset) and an instant **static vector variant** (used under `prefers-reduced-motion`, battery saver, and Telegram PNG/SVG card thumbnails):

| State Key | Visual Pose & Motion | Where It Appears |
| :--- | :--- | :--- |
| **`float`** | Gentle weightless hover (`translateY ±4px`, breathing halo) | Wallet Home header & active account card |
| **`shield`** | Raises translucent hexagonal energy shield (`#8050C8` / `#F5C928` pulse; crimson tint on danger) | **Scan & Shield** pre-sign inspection sheet |
| **`warp`** | Dynamic thruster trail (`#F15A24` → `#F5C928` streak) | Transaction broadcast, Soroswap swap execution, Claim link flight |
| **`vault`** | Anchored stance holding holographic key prism | SEP-0005 seed backup, multi-account derivation, Classic Guardian setup |
| **`comms`** | Pulsing orbital signal rings (`#A58BE0` ripples) | `/connect` Telegram link ceremony & live bot notification status |
| **`zenith`** | Celebratory orbital star-burst (`#F5C928` shimmer) | Confirmed payment, successfully claimed Telegram link, Reserve Reclaimed |

### C. Optional On-Chain Collectibles (v1.5 / v2 — SEP-50)
- **v1 Core:** Pure client-side SVG/dotLottie visual states (zero contract deployment required, zero network dependency).
- **v1.5 / v2 Enhancement:** Milestone-earned **SEP-50 Soroban Collectible Badges** (e.g., *Testnet Pioneer*, *Zero-Reserve Optimizer*, *Guardian Verified*) stored on-chain as non-custodial badges unlocking bonus visor/aura cosmetics inside the glass UI.
