# Handoff de sesión — 2026-11-20

> Estado honesto: la parte backend/paquetes está verificada; la migración del PWA a Mini App está **a medias y el PWA probablemente NO compila**. Nada de lo marcado "pendiente" se ha verificado.

## 1. Hecho y verificado (salida real de comandos)
- Remediación de auditoría (contrato Soroban, domain, defi, security-shield, stellar-core, server, PWA previa, CI). Última verificación completa (antes de la migración Mini App): cargo fmt/clippy/build wasm/test (9/9), `pnpm build` 7/7, typecheck 12/12, lint 0 errores, `pnpm test` 20 archivos / 108 tests, secret-scan limpio, sin leak `stellar-xdr-json`, `pnpm audit --prod --audit-level=critical` OK (quedan avisos: `zod@3` high y `vitest>tinypool` dev-only; requieren salto de versión mayor).
- `.github/workflows/ci.yml`: gate `audit --prod --critical` + reporte high no bloqueante.
- Decisión del usuario: **Mini App 100% Telegram + Cláusula 7.3 (Stellar + TON + TON Connect v2)**, sin web pública. Skills Stellar + Docs MCP instalados en `.agents/plugins/stellar-dev/`.
- Verificados tras la migración: `@astrowallet/domain` (17 tests), `@astrowallet/tg-protocol` (14), `@astrowallet/ton-core` (4, paquete nuevo), `apps/server` typecheck+lint+20 tests (rutas `/v1/tg/*`, `connect-verifier.ts`, botones `web_app`/`t.me?startapp=`).
- Docs actualizados: `AGENTS.md` (Regla 5 y 7, env), `PROPOSAL_TELEGRAM_MINI_APP.md`, ESLint (ton-core), secret-scan (URLs TON).

## 2. A medias / probablemente roto (apps/pwa) — NO verificado
- `src/state/wallet-context.tsx`: se añadió TON (derivación, `sendTonPayment`, TON Connect, biometría Telegram) y se quitaron imports/estado de SEP-43, pero el bloque `authorizeDappRequest` + `createSep43Provider/attachSep43WindowProvider` y `handleDappRpcRequest` **siguen en el cuerpo** y referencian símbolos eliminados (`PendingDappConsent`, `pendingDappConsent`, `dappConsentResolverRef`, `createWalletConnectStellarResponder`, etc.). Hay que borrar ese código (Cláusula 7.3: sin `window.stellar` ni WalletConnect) y `inspectDappAuthEntrySecurity` ya no se importa.
- `src/App.tsx`: imports, tipos (`AppDockTab`), tabs y drawers ya reescritos, pero el cuerpo de `WalletShell` aún usa `onNavigateLanding`, `SIDEBAR_ITEMS`, tabs `dev`/`telegram`, `DappConnectSheet`, `pendingDappConsent`, `IconGlobe/IconExternalLink`; `RoutedExperience`/`App` siguen con `LandingPage`/`RouteView`.
- `LandingPage.tsx` y `DappConnectSheet.tsx` ya borrados (hay referencias colgantes; `DevLabSheet` quizá use `handleDappRpcRequest`).
- Creados sin compilar: `telegram/webapp.ts`, `state/telegram-context.tsx`, `state/ton-connect-store.ts`, `components/{TelegramOnlyGate,TonWalletSheet,TonConnectSheet}.tsx`; `IosBrowserGuard`, `RampSheet`, `UnlockSheet`, `IntentSheet` reescritos/editados.
- `pnpm install` añadió `buffer`, `@ton/*`, `tweetnacl` (sin `@types/tweetnacl`, no existe en npm).

## 3. Pendiente
1. Terminar `wallet-context.tsx` y `App.tsx` (ver §2): quitar website/sidebar, envolver en `<TelegramProvider>` + `<TelegramOnlyGate/>`, usar `startParamRoute`, `useTelegramBackButton`, `setTelegramClosingConfirmation`, modal de aprobación TON Connect (`pendingTonConnectTx`), botón "Sync Wallet with Telegram" (`/v1/tg/link-challenge` → `signConnectChallenge` → `/v1/tg/link-confirm`), launcher TON Connect y Dev Lab en Vault.
2. `glass.css`: mantener `.aw-mobile-header` y `.glass-dock` visibles siempre, quitar layout sidebar ≥960px, soportar `--tg-safe-area-inset-*`.
3. `apps/pwa/.env.example`, `apps/server/.dev.vars.example`, `apps/server/wrangler.toml`: añadir `VITE_TG_MINI_APP_SHORT_NAME`, `VITE_TON_*`, `VITE_ALLOW_DEV_OUTSIDE_TELEGRAM`, `TG_BOT_USERNAME`, `TG_MINI_APP_SHORT_NAME`.
4. `apps/pwa/src/security.test.ts`: tests de `shouldAllowMiniAppAccess` y `parseStartAppParam`.
5. Verificación final (los 9 checks): cargo (fmt, clippy, build wasm32v1-none, test), `pnpm build`, `typecheck`, `lint`, `test`, `secret-scan`, grep de `stellar-xdr-json` en `apps/pwa/dist/assets`, `pnpm audit --prod --audit-level=critical`, `git status -s`. Vigilar bundle de `@ton/core` con polyfill `buffer` y CSP.
6. Actualizar README/ARCHITECTURE/DESIGN_SYSTEM/PLAN/FEASIBILITY (aún dicen "bot puro, sin Mini App" y mencionan la web `pages.dev`), y quitar la fila "Official Website" del README.
7. Fuera de alcance de esta sesión: registrar el Mini App en BotFather (short name), dominio definitivo (P0-8), auditoría externa del escrow, upgrade `zod` v4/`vitest`, tests de abuso e2e, wasm hash real de smart account, indexer principal.

## 4. Cómo retomar
`git checkout wip/telegram-mini-app`, leer este archivo, arreglar `pnpm --filter @astrowallet/pwa typecheck` iterativamente, luego correr la suite completa.
