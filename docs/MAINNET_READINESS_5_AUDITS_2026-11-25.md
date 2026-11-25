# AstroWallet — Dossier Pre-Mainnet de 5 Auditorías Quirúrgicas (`2026-11-25`)

> **Propósito:** Registro técnico verificable de los hallazgos, evidencias en vivo contra Cloudflare/Stellar/Soroban, y plan de remediación en 5 auditorías quirúrgicas para llevar `astrowallet` a **Mainnet Beta** bajo *Code Freeze*.
> **Reglas de oro:** cero features nuevas fuera de remediación, cero exposición de `.secrets/` / `.env.local` / claves `S...`, orden estricto de despliegue (**D1 → Workers → Pages `--branch main` desde `apps/pwa` → Smoke Tests**), y cero despliegues de contratos nuevos en Stellar Mainnet sin auditoría externa previa.

---

## Sección A — Diagnóstico Forense en Vivo de Señal #1 (`astrowallet-soroban.pages.dev` devolviendo HTML / 404)

1. **Causa raíz 1 — Cloudflare Pages sin `./functions` en `Production` (`main`):**
   - El deployment activo de `Production (branch: main)` era `237571be` (`dcbfa7f`), subido fuera de `apps/pwa` sin `./functions`. Como resultado, `/health`, `/openapi.json`, `/v1/metrics/public`, `/v1/proxy/oracle/prices` y `/tg/webhook` devolvían `200 text/html` (`index.html` de la SPA).
   - El deployment `378f171b` (`2cf17f8`, ejecutado desde `apps/pwa` con `./functions`) cayó en `Preview (branch: testnet)`, donde `https://378f171b.astrowallet-soroban.pages.dev/health` sí respondía `200 application/json`.
2. **Causa raíz 2 — Desfase de Worker y migraciones D1 en Mainnet:**
   - `astrowallet-server` (Testnet, versión `5dcc38a8` `2026-11-24T23:40Z`) tenía D1 al día (`0001..0008`).
   - `astrowallet-server-mainnet` (versión `2ca94a5e` `2026-11-23T22:56Z`) corría una versión anterior sin `/v1/proxy/oracle/prices` y le faltaban en D1 remoto las migraciones `0007_indexes_and_unique_username.sql` y `0008_connect_sign_auth_entry.sql`.
3. **Secrets verificados en Cloudflare (solo nombres):**
   - Ya provisionados en ambos Workers (`astrowallet-server` y `astrowallet-server-mainnet`): `ECOSYSTEM_SHARED_INTENT_SECRET`, `INDEXER_WEBHOOK_SECRET`, `INTENT_HMAC_SECRET`, `SEP10_CLIENT_SIGNING_SECRET`, `TG_BOT_TOKEN`, `TG_WEBHOOK_SECRET`.
   - Pendientes en Mainnet **únicamente** para habilitar operaciones patrocinadas / quotes en Mainnet: `RELAY_SPONSOR_SECRET`, `OZ_CHANNELS_API_KEY`, `SOROSWAP_API_KEY`, además de `CLAIM_ESCROW_CONTRACT_ID` / `RELAY_ALLOWED_CONTRACTS` (tras auditoría externa del contrato) y webhook/bot separado si Testnet y Mainnet conviven con bots distintos.

---

## Sección B — Auditoría #1: Paridad Back↔Front, CSP, Config y D1 (Estado: **✅ CERRADA Y DESPLEGADA — `2026-11-25`**)

> **Cierre Verificado (Orden Estricto D1 → Workers → PWA `--branch main` → Smoke Tests):**
> - **Checks locales:** `pnpm -r typecheck`, `pnpm -r lint`, **38/38 archivos / 204/204 tests Vitest**, `pnpm secret-scan` (132 archivos limpios), y `@astrowallet/pwa build`.
> - **Migraciones D1 remotas:** Testnet `astrowallet` (`0009_linked_addresses_unique.sql` ✅) y Mainnet `astrowallet-mainnet` (`0007`, `0008`, `0009` ✅).
> - **Workers Cloudflare:** `astrowallet-server` (Testnet, versión `fe6275cd-36dc-4909-a5b4-6edd04089cb1`) y `astrowallet-server-mainnet` (Mainnet, versión `648bdd0b-28fc-415f-a7fa-82a24556ae73`, sin binding `ASTRODEX` apuntando a Testnet).
> - **Pages Producción (`--branch main` desde `apps/pwa` con `./functions`):** `https://751d9835.astrowallet-soroban.pages.dev` (`https://astrowallet-soroban.pages.dev`).
> - **Smoke Tests Reales Post-Deploy (8/8 `200 application/json`, 0 HTML, 0 404):** `/health`, `/openapi.json`, `/v1/metrics/public` y `/v1/proxy/oracle/prices?assets=XLM,USDC` (Mainnet: RedStone ledger `65660324`, `XLM = $0.12357878`; Testnet con `X-Astro-Network: testnet`: `configured: false`).
> - **Variables/Secrets pendientes únicamente para operaciones patrocinadas/escrow/quotes en Mainnet:** `CLAIM_ESCROW_CONTRACT_ID`, `RELAY_ALLOWED_CONTRACTS`, `RELAY_SPONSOR_SECRET`, `OZ_CHANNELS_API_KEY`, `SOROSWAP_API_KEY` (y bot/webhook separado si Testnet y Mainnet conviven con bots distintos).

| ID | Severidad | Archivo y Línea Exacta | Hallazgo | Fix Quirúrgico |
| :--- | :---: | :--- | :--- | :--- |
| **`C-01`** | **P0** | `apps/server/wrangler.toml:144-146`, `bot.ts:1236`, `intents.ts:1037-1047` | `[[env.mainnet.services]]` vincula `ASTRODEX` a `astrodex-server` (Testnet; `astrodex-server-mainnet` aún no existe `[code: 10007]`), desviando quotes y callbacks Boomerang de Mainnet a D1 Testnet (`404`). | Comentar `[[env.mainnet.services]]` hasta desplegar `astrodex-server-mainnet` (usando HTTP `ASTRODEX_API_BASE_URL = "https://astrodex.pages.dev"`) y enviar `"X-Astro-Network": config.network` en `bot.ts:1236` e `intents.ts:1030` (y `&network=${config.network}` en `bot.ts`). |
| **`C-02`** | **P0** | `packages/connect-sdk/src/types.ts:15-32`, `client.ts:135,214,369,405` | `@astrowallet/connect` no envía `X-Astro-Network`, enrutando peticiones Testnet contra `astrowallet-server-mainnet` (`404` al abrir `ConnectRequestSheet.tsx:137-142` en Testnet). `/tg/webhook` y `/webhooks/indexer` requieren `?network=testnet` si apuntan a Testnet y comparten `TG_BOT_USERNAME = "AstroWalletAppBot"`. | Añadir `network?: AstroNetwork | undefined` en `AstroConnectConfig` y propagar `"X-Astro-Network"` en `postCreateRequest`, `getRequestStatus`, `resolveIdentity` y `scanTarget`. |
| **`C-03`** | **P0** | `bot.ts:647,720,1579`, `intents.ts:290-309`, `repository.ts:993-996` | `intent.expiresAt === escrowExpiresAt`; al expirar (único momento en que `refund_expired` desbloquea on-chain), `GET /v1/intents/:id` devuelve `410`, y 1h después `purgeExpiredRecords` borra `signed_intents` con `status = 'signed'` dejando `claim_links` huérfanos. | Pasar `nowSec = intent.expiresAt - 1` a `verifyIntentToken` en `GET /:intentId` cuando `actionType === "claim" && status === "signed"`, y cambiar el cron a `status NOT IN ('confirmed', 'signed')`. |
| **`H-01`** | **P1** | `apps/server/wrangler.toml:164-165` | `CLAIM_ESCROW_CONTRACT_ID` y `RELAY_ALLOWED_CONTRACTS` están comentados en Mainnet (el relayer responde `503` fail-closed hasta desplegar contrato auditado). `ASTROGATE_API_BASE_URL`/binding siguen ausentes. | Mantener fail-closed hasta Gate 1/3; documentar variables pendientes de Mainnet. |
| **`H-02`** | **P1** | `apps/server/src/routes/proxy.ts:1257-1259` | Envía `client_domain` a SEP-10 aunque `sep10ClientSigningSecret` sea `undefined`, omitiendo co-firma en `:1283` (`401` en MoneyGram). | Exigir `config.sep10ClientDomain && config.sep10ClientSigningSecret` en `:1257`. |
| **`H-03`** | **P1** | `apps/pwa/src/App.tsx:1039-1091` | `handleSyncWalletWithTelegram` reutiliza `sessionToken` de la red primaria al llamar `link-challenge`/`link-confirm` con `X-Astro-Network: altNet` → `403 wrong_network` (`tg-auth.ts:84-95`). | Autenticar primero contra `POST /v1/tg/auth` con `"X-Astro-Network": targetNet` e `initTelegramMiniApp()?.initData` cuando `targetNet !== config.network`. |
| **`H-04`** | **P1** | `packages/stellar-core/src/ledger/token-explorer.ts:492-495,530-537` | `fetchAssetStellarTomlMeta` llama `/v1/proxy/stellar-toml` sin cabecera `X-Astro-Network`. | Añadir `network?: "testnet" | "mainnet"` en `token-explorer.ts` y propagar `config.network` desde `wallet-context.tsx`, `SwapSheet.tsx`, `TokenExplorerSheet.tsx` y `market-cache.ts`. |
| **`H-05`** | **P1** | `AgentBudgetSheet.tsx:150,192`, `apps/pwa/public/_headers:8`, `apps/pwa/vite.config.ts:8-16` | `AgentBudgetSheet` hace `fetch` directo bloqueado por CSP; `vite.config.ts` omite `VITE_ALT_*`, `VITE_NEAR_INTENTS_API_BASE` y `VITE_ASTRODEX_API_BASE_URL`; `_headers` omite `ipfs.io`, `dweb.link` e `iris-api*.circle.com`. | Crear `POST /v1/proxy/x402-probe` SSRF-safe en `proxy.ts` (reenviando solo `X-PAYMENT` y `PAYMENT-SIGNATURE`), enrutar probes HTTPS vía proxy, y actualizar `_headers` + `vite.config.ts`. |
| **`M-01`** | **P2** | `packages/connect-sdk/src/types.ts:191,198` | Enum mismatch: SDK define `"safe"`/`"info"`/`"critical"`, pero `/v1/connect/scan` devuelve `"benign"`/`"warning"`/`"malicious"`. | Alinear `severity` (`"benign" | "info" | "warning" | "malicious" | "critical"`) y `verdict` (`"benign" | "safe" | "warning" | "malicious"`). |
| **`M-02`** | **P2** | `RampSheet.tsx:106-120`, `domain/src/config.ts:439-592`, `AgentBudgetSheet.tsx:59`, `PublicStatsPage.tsx:211` | 5 `C...` (CCTP/OFT) hardcodeados en `RampSheet.tsx`; `PwaNetworkProfile`/`applyPwaNetworkProfile` no rotan `cctpForwarderContractId`, `cctpTokenMessengerContractId`, `lzOftContractId`, `moneygramAnchorDomain` ni `astrodexApiBaseUrl`; lectura cruda de `import.meta.env.VITE_ASTRODEX_API_BASE_URL`. | Mover esos campos a Zod `RawPwaEnvSchema` + `PwaNetworkProfile` + `applyPwaNetworkProfile` (`exactOptionalPropertyTypes: true`), documentar defaults públicos en `apps/pwa/.env.example`, y limpiar `RampSheet.tsx`/`AgentBudgetSheet.tsx`. |
| **`M-03`** | **P2** | `0001_init.sql:14-30`, `repository.ts:427-440,491-536` | `linked_addresses` sin índice `UNIQUE` y alta no-atómica (`SELECT` + `INSERT`/`UPDATE`); `getUserByLinkedAddress` sin `ORDER BY`. | Crear `0009_linked_addresses_unique.sql` (dedup + `UNIQUE INDEX` en `address` y `(telegram_user_id, address)`), añadir `ORDER BY` y usar `ON CONFLICT(address) DO UPDATE`. |
| **`L-01`** | **P3** | `apps/pwa/public/sw.js:35-43`, `wrangler.toml`, `repository.ts:1277` | `sw.js` no excluye `/openapi.json` ni `/llms.txt`; falta `CONNECT_VERIFIED_BOTS`; `repository.ts:1277` cuenta filas `bootstrap:YYYY-MM-DD` en `relayTxCount`. | Subir SW a `astrowallet-tma-v15` excluyendo `/openapi.json` y `/llms.txt`; añadir `CONNECT_VERIFIED_BOTS = "AstroDexBot,AstroGateSorobanBot"` en `wrangler.toml`. |

---

## Sección C — Auditoría #2: Red Team & Contrato Rust (Estado: **✅ CERRADA Y DESPLEGADA — `2026-11-25`**)

- **Contrato Rust (`contracts/claim-escrow/src/lib.rs`):**
  - `rescue_excess` extiende también el TTL de `DataKey::EscrowedBalance` cuando `escrowed > 0`.
  - Nuevo test Red Team `test_red_team_boundary_and_rescue_invariants`: **12/12 tests Rust**, `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings` (0 warnings) y `cargo build --release --target wasm32v1-none` en verde.
- **Red Team Relay, Métricas, SVG XSS, Shield & Gitleaks:**
  - `apps/server/src/routes/relay.ts`: rechaza `FeeBumpTransaction` anidado (`400`), 0 operaciones (`400`), y restringe `intentAuth` de Claim Links `signed` expirados exclusivamente a `refund_expired` / `refund_expired_to` (`403` para `claim`/`create_claim`).
  - `apps/server/src/db/repository.ts`: `relayTxCount` filtra `WHERE day_utc NOT LIKE 'bootstrap:%'`.
  - `packages/stellar-core/src/sep50/index.ts`: bloquea `<foreignObject>`, `<iframe>`, `<object>`, `<embed>`, `<animate>`, `<set>`, `<meta>`, `vbscript:`, `data:text/html`, entidades `&#x`/`&#\d`, y `xlink:href`/`href` externos en SVGs.
  - `packages/security-shield/src/{decoder.ts,rules.ts}`: inspecciona `beginSponsoringFutureReserves` (`SPONSORED_RESERVE_COMMITMENT` + bloqueo si `sponsoredId` es malicioso).
  - `.gitleaks.toml`: allowlist estricto para la clave pública SEP-10 y fixtures `*.test.ts`; `gitleaks git --redact` → **0 leaks** en 62 commits.

---

## Sección D — Auditoría #3: Verificación On-Chain Real (Estado: **✅ CERRADA Y DESPLEGADA — `2026-11-25`**)

- **Verificado en vivo contra nodos reales (`2026-11-25`):**
  1. **RedStone SEP-40 Mainnet (`CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF`):** ledger `65660625`, `decimals = 8`, `XLM = $0.12380639`, `ageSec: 506`, `stale: false`.
  2. **LayerZero V2 USDT0 OFT Mainnet (`CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6`):** `quoteLayerZeroOftBridge` hacia Arbitrum (`dstEid: 30110`, `10_000_000` stroops) verificado en vivo (`nativeFeeStroops = 6168763`).
  3. **Sorobits SEP-50 Testnet (`CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3`):** `total_supply = 3`, decodificados `Sorobit #0`, `#1` y `#6` en vivo.
- **Fixes cerrados:**
  1. `RampSheet.tsx`: fijado el SAC canónico de Circle USDC (`GA5Z...` Mainnet / `GBBD...` Testnet) para CCTP V2.
  2. `packages/defi/src/sep40.ts` y `apps/server/src/routes/proxy.ts`: normalización `symbol.toUpperCase()` en `Asset::Other` (`?assets=xlm,usdc,btc`), rechazo de timestamps futuros, y `ageSec`/`stale` (`maxStalenessSec: 86_400`).
  3. `packages/stellar-core/src/sep50/index.ts`: hidratación acotada de `metadataUrl` off-chain.
  4. `packages/defi/src/pro-bridge.ts`: validación `amountStroops7 > maxFee` en CCTP y distinción entre contrato no-OFT y peer ausente en LayerZero `peer()`.

---

## Sección E — Auditoría #4: Bundle, UX Móvil y Playwright (Estado: **✅ CERRADA Y DESPLEGADA — `2026-11-25`**)

- **Lazy-load real de `vendor-ton`:** `ensureTonAccount()` en `wallet-context.tsx` difiere la descarga de `@astrowallet/ton-core` fuera del arranque de Wallet Home hasta abrir `TonWalletSheet`, `TonConnectSheet`, `RampSheet` (TON) o tener sesiones TON Connect previas.
- **Fixes UX cerrados:**
  1. `SwapSheet.tsx`: `heldIdentifiers` resta `minReserveXlm` en XLM nativo; `<HighValueReauthGate>` usa `spendableBalance` consistente con el botón; `"Retry Quote"` deshabilitado mientras `quoting`.
  2. `ReceiveSheet.tsx`: con Muxed ID inválido, muestra error en rojo y deshabilita los botones de copia/compartir sin filtrar `G...`.
  3. `App.tsx`: muestra `"Syncing ... ledger…"` mientras `loadingChain && !accountState` en vez de `"Unfunded account"`.
  4. `PublicStatsPage.tsx`: muestra `"…"` y estado de carga inicial en lugar de `"0"`.
  5. `CollectiblesSheet.tsx`, `RampSheet.tsx`, `AgentBudgetSheet.tsx`, `glass.css`: `disabled` en transfer vacío, `useRef` submit locks, feedback de error al copiar, targets `>= 44px` en móvil, y eliminados `fontSize: 12` inline en `<input>` (anti-zoom iOS).
- **Playwright E2E (`390x844` y `360x740` en `/` y `/stats`):** **4/4 en verde** (`hasOverflow: false`, `loadedVendorTon: false`, `pageErrors: []`).

---

## Sección F — Auditoría #5: Supply Chain y Despliegue Final (Estado: **✅ CERRADA Y DESPLEGADA — `2026-11-25`**)

- **`pnpm audit --prod`:** añadido `"pnpm": { "overrides": { "zod": ">=4.6.6" } }` en `package.json` raíz (`zod@4.6.7` activo) → **`No known vulnerabilities found`** (`0` High / `0` Critical).
- **`pnpm audit` (dev) / `cargo audit`:** `vitest`/`tinypool` en devDependencies y `RUSTSEC-2026-0387` en `crypto-bigint 0.5.5` (exclusivo de `soroban-env-host` de tests, fuera del WASM `#![no_std]`).
- **Despliegue final verificado (`2026-11-25`):**
  - Workers: `astrowallet-server` (`a9d974ca-2ddc-4082-ba98-22c9174e4565`) y `astrowallet-server-mainnet` (`6bb16c84-9184-4e70-b6a5-342f617be648`).
  - Pages Producción (`--branch main` desde `apps/pwa` con `./functions`): `https://237bba00.astrowallet-soroban.pages.dev` (`https://astrowallet-soroban.pages.dev`).
  - Smoke Tests en vivo: **8/8 `200 application/json`** en Mainnet y Testnet (`/health`, `/openapi.json`, `/v1/metrics/public`, `/v1/proxy/oracle/prices?assets=xlm,usdc,btc`).
  - **Checklist Fase Beta Cerrada:** probar con 5–10 testers usando montos pequeños ($5–$20), mantener límites conservadores en `RELAY_DAILY_BUDGET_STROOPS`, y provisionar `CLAIM_ESCROW_CONTRACT_ID`, `RELAY_ALLOWED_CONTRACTS`, `RELAY_SPONSOR_SECRET`, `OZ_CHANNELS_API_KEY` y `SOROSWAP_API_KEY` únicamente tras completar la auditoría externa de `ClaimEscrowContract`.
