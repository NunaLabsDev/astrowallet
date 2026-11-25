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

## Sección C — Auditoría #2: Red Team & Contrato Rust (Estado Base y Checklist Pendiente)

- **Checks base ya ejecutados:**
  - `cargo clippy --manifest-path contracts/claim-escrow/Cargo.toml --all-targets -- -D warnings` → **0 warnings**.
  - `cargo test --manifest-path contracts/claim-escrow/Cargo.toml` → **11/11 tests OK**.
  - `pnpm secret-scan` → **0 hallazgos** en 132 archivos fuente.
  - `gitleaks git` → solo 2 falsos positivos sobre la clave pública `SIGNING_KEY = "GBFRJ6WMZJ37EQBA34RUEZBDSGZBKRY5T2JIVPG7EHJXZZUSKKQD6YRT"` (pendiente añadir `.gitleaks.toml` allowlist para `G[A-Z2-7]{55}` públicas).
- **Pendiente para ejecutar en Fase #2:**
  1. Revisión ofensiva línea por línea de `contracts/claim-escrow/src/lib.rs` vs `packages/stellar-core/src/claim-escrow/index.ts` (auth, TTL, aritmética checked, edge cases de `refund_expired_to` / `cancel_claim` / `rescue_excess`).
  2. Pruebas ofensivas de drenaje, replay y bypass en `apps/server/src/routes/relay.ts`, `tg-auth.ts` y `proxy.ts`.
  3. Auditoría XSS/SVG en `packages/stellar-core/src/sep50/index.ts:57-81` (entidades HTML / `<foreignObject>` si se renderizara fuera de `<img>`) y bypasses de `packages/security-shield`.

---

## Sección D — Auditoría #3: Verificación On-Chain Real (Sin Mocks) y Fixes Pendientes

- **Verificado en vivo contra nodos reales (`2026-11-25`):**
  1. **RedStone SEP-40 Mainnet (`CBMGLKUQZVSAIL5CPDDAWSUY7MAKXISHMOZEVLMBUWBMFGHRJSR4WYRF`):** ledger `65655638`, `decimals = 8`, `XLM = $0.12419086` (`sourceKind: "stellar"`), `USDC = $0.99990421` (`sourceKind: "stellar"`).
  2. **LayerZero V2 USDT0 OFT Mainnet (`CBOWOLFSDM5PZXNFIVDMP5NZ7U2GSIHED6H6R446QOHF266XINKUMMF6`):** `quoteLayerZeroOftBridge` hacia Arbitrum (`dstEid: 30110`, `10_000_000` stroops) devolvió `amountReceivedLdStroops7 = 10000000`, `minAmountLdStroops7 = 9950000`, `nativeFeeStroops = 6168763` (~`0.617 XLM`); orden alfabético `scvMap` de `SendParam` aceptado por el contrato real.
  3. **Sorobits SEP-50 Testnet (`CBVETCPLVAMNUUQRUJGH54XHVQT5ZOVB4FGGP2IGOGAZLUIYBBV7G3I3`):** `total_supply = 3`; `fetchSep50Holdings` decodificó en vivo `Sorobit #0` (`GB6CIS...`) y `Sorobit #1` + `Sorobit #6` (`GDQJTJ...`, confirmando `get_owner_token_id` cuando `tokenId !== index`).
- **Pendiente para cerrar en Fase #3:**
  1. `apps/pwa/src/components/RampSheet.tsx:256-264`: `resolvedUsdcSacContractId` toma el primer `"USDC"` de `verifiedAssets` en vez de fijar el SAC canónico de Circle (`CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA` Testnet / `CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75` Mainnet).
  2. `apps/server/src/routes/proxy.ts:1483-1511` & `packages/defi/src/sep40.ts:104-107`: normalizar `symbol.toUpperCase()` en `Asset::Other` (`?assets=btc` falla por minúsculas) y añadir umbral de frescura (`maxStalenessSec`) sobre `timestamp`.
  3. `packages/stellar-core/src/sep50/index.ts:297-313`: hidratar `metadataUrl` off-chain (`ipfs://`/`https://`) con timeout acotado *(adelantado en Auditoría #1)*.
  4. `packages/defi/src/pro-bridge.ts:386,497-500`: validar `amountStroops7 > maxFee` en CCTP y distinguir contrato/SAC inválido de `"No LayerZero peer wired..."` en `peer()`.

---

## Sección E — Auditoría #4: Cascada de Bundle, Bugs UX Móvil y Playwright

- **Cascada actual observada (`apps/pwa/dist/assets`):**
  - Boot bloqueado descarga ~`1.36 MB` (`vendor-stellar` `650 kB`, `App` `255 kB`, `vendor-react` `224 kB`, `token-catalog/zod` `123 kB`, `vendor-crypto` `78 kB`) antes de pintar `TelegramOnlyGate` / `UnlockSheet`.
  - Al desbloquear, `apps/pwa/src/state/wallet-context.tsx:766-799` dispara inmediatamente `vendor-ton` (`512 kB`) aunque el usuario esté en Wallet Home Stellar (`TonConnectSheet.tsx:2` también arrastra `@astrowallet/ton-core` en `DevLabSheet.tsx:22`). `Activity` (511L) y `Accounts` (746L) siguen inline en `App.tsx` (4,083L).
- **Bugs UX/Interacción pendientes de Fase #4:**
  1. **[HIGH]** `SwapSheet.tsx:1094` vs `:1118`: `<HighValueReauthGate>` usa `balance` total mientras el botón usa `spendableBalance`, bloqueando el swap con `sellingLiabilities` activas; `heldIdentifiers` (`:235-237`) no resta `minReserveXlm` en XLM.
  2. **[HIGH]** `ReceiveSheet.tsx:54-56,289-307`: con Muxed ID inválido, el botón habilitado `"Copy M... Address"` copia silenciosamente la cuenta `G...` plana.
  3. **[MEDIUM]** `App.tsx:1685-1710,2129-2137`: flash falso de `"Unfunded account"` mientras `loadingChain && !accountState`.
  4. **[MEDIUM]** `PublicStatsPage.tsx:185,295-314`: muestra `0` en todos los KPIs en lugar de estado `loading`.
  5. **[MEDIUM]** Controles sin `disabled`/lock o sin feedback de error (`App.tsx:3055,3126,3444,3481,3582`; `CollectiblesSheet.tsx:504` Transfer SEP-50 sin `disabled={!transferTo.trim()}` ni Clear-Sign review; `SwapSheet.tsx:1050`; `RampSheet.tsx:913` y `AgentBudgetSheet.tsx:273` clipboard fail silencioso; `OnboardingSheet.tsx` y `RampSheet.tsx` sin `useRef` lock).
  6. **Touch targets `< 44px` e iOS Auto-Zoom (`< 16px`):** `.aw-mini-chip` (`glass.css:1747`, `30px`), inline `minHeight: 38/34` (`RampSheet.tsx:659-679`, `AgentBudgetSheet.tsx:252,272`), `.aw-quiz-option` (`40px`), `.aw-toast-close` (`40px`), pill de red (`~22px`); e inline `style={{ fontSize: 12 }}` en `RampSheet.tsx:1027-1175` y `CollectiblesSheet.tsx:364,499` que anulan `font-size: max(16px, 1rem)`.
  7. **Playwright E2E (`390x844` y `360x740`):** ejecutar suite automatizada tras aplicar fixes UX.

---

## Sección F — Auditoría #5: Supply Chain (`pnpm audit` / `cargo audit`) y Runbook de Deploy

- **`pnpm audit --prod`:** **1 High** real en producción: `zod <4.6.6` (`GHSA-mrhx-c7xc-m3w5`, agotamiento de memoria en colecciones restringidas) vía `packages__ton-core > @ton/ton > zod`. Fix planificado: `"pnpm": { "overrides": { "zod": ">=4.6.6" } }` en `package.json` raíz.
- **`pnpm audit` (dev):** **2 Critical + 3 Moderate** en `tinypool <2.1.2` (`GHSA-5gmw-xhrv-c9v3`, `GHSA-85c8-ppgw-ccpr`) y `vitest` / `@vitest/mocker <4.1.12` (`GHSA-82fw-gwwq-j7x9`, `GHSA-qxg6-89mg-rqv8`).
- **`cargo audit`:** `RUSTSEC-2026-0387` en `crypto-bigint 0.5.5` (transitivo de `soroban-env-host 22.1.3` — solo entorno de test/host, excluido del binario WASM `#![no_std]`) + 3 avisos `unmaintained` (`chrono`, `derivative`, `paste`).
- **Runbook de despliegue sin caídas y Rollback `< 1 min`:**
  1. Migraciones D1: `pnpm --dir apps/server exec wrangler d1 migrations apply astrowallet --remote` y `--env mainnet --remote`.
  2. Workers: `pnpm --dir apps/server exec wrangler deploy` y `--env mainnet`.
  3. PWA + Functions (**siempre desde `apps/pwa`** con `--branch main`): `(cd apps/pwa && pnpm exec wrangler pages deploy dist --project-name astrowallet-soroban --branch main)`.
  4. Smoke tests JSON (Mainnet sin cabecera y Testnet con `X-Astro-Network: testnet`): `GET /health`, `GET /openapi.json`, `GET /v1/metrics/public`, `GET /v1/proxy/oracle/prices?assets=XLM,USDC`.
  5. Rollback inmediato: `pnpm --dir apps/server exec wrangler rollback` / `--env mainnet` y promoción del deployment previo sano en Cloudflare Pages.
