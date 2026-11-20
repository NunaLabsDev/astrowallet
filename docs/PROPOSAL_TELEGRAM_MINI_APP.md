# Propuesta (APROBADA E IMPLEMENTADA): AstroWallet 100% dentro de Telegram como Mini App Multichain (Cláusula 7.3)

> **Estado:** **APROBADA E IMPLEMENTADA (2026-11-20).** La Regla 7 de [`AGENTS.md`](../AGENTS.md) ha sido enmendada para operar exclusivamente como **Telegram Mini App Multichain** cumpliendo la **Cláusula 7.3 (*Multichain Wallets*)** de los [Términos del Servicio para Desarrolladores de Telegram](https://core.telegram.org/bots/terms#7-blockchain-integration).
>
> **Decisión verificada:**
> - La aplicación se ejecuta **exclusivamente dentro de Telegram** (`web_app` en chats privados y `https://t.me/<bot>/<short_name>?startapp=...` en grupos/inline), eliminando el sitio web/landing pública y bloqueando el acceso fuera de Telegram (salvo bandera explícita de desarrollo en Testnet).
> - La identidad del usuario se verifica en el servidor mediante HMAC-SHA256 de `Telegram.WebApp.initData` (`POST /v1/tg/auth`, `auth_date <= 300s`).
> - Cumplimiento Cláusula 7.3–7.4: gestión nativa Stellar (`G...`/`C...`) + TON (`WalletContractV4` / `WalletContractV5R1`, BIP-39 SLIP-0010 `m/44'/607'/i'`) dentro de la misma interfaz; conexiones externas exclusivamente mediante **TON Connect v2** (sin conectores WalletConnect/Reown ni `window.stellar` ni catálogos de apps no-TON).
> - Regla 4 intacta: claves, PINs y frases semilla **nunca** tocan `Telegram.WebApp.CloudStorage`, `localStorage`, `sessionStorage`, servidor ni D1/KV.
>
> **Origen:** petición del propietario del proyecto (2026-11-19 / 2026-11-20): *"la app debe estar bien diseñada para Telegram y funcionar exclusivamente dentro de Telegram, sin abrir en otra web o navegador, cumpliendo las reglas"* .

---

## 1. Problema que resuelve

Hoy el bot abre enlaces HTTPS al PWA en un navegador externo o en el WebView embebido de Telegram. Eso causa:

1. **Pérdida de contexto:** el usuario sale de Telegram para firmar.
2. **Almacenamiento aislado en iOS:** el WebView de Telegram, Safari y el PWA instalado no comparten IndexedDB. [`IosBrowserGuard`](../apps/pwa/src/components/IosBrowserGuard.tsx) sugiere "Confirmar con PIN aquí", pero la bóveda no existe en ese WebView, lo que empuja a pegar la semilla en un navegador embebido (ver auditoría §4).
3. **Identidad débil:** el enlace firmado es un token al portador; nadie comprueba que quien lo abre sea el usuario de Telegram que lo pidió (auditoría P0-1).

## 2. Hipótesis de solución

Registrar la wallet como **Telegram Mini App** (`t.me/<bot>/<app>?startapp=<intent>` y botón de menú/`web_app`), abierta dentro de Telegram desde el bot. El usuario nunca abre un navegador externo.

### Lo que podría aportar (a verificar contra la documentación oficial)

| Capacidad | Beneficio potencial |
| :-- | :-- |
| `initData` firmado por Telegram (HMAC-SHA256 con el token del bot, comprobar `auth_date`) | **Identidad verificada en servidor** del `telegram_user_id`. Cierra P0-1 sin desafío inverso. |
| `SecureStorage` (Keychain iOS / Keystore Android) | Posible almacén para la clave de envoltura de la bóveda. |
| `DeviceStorage` | Estado local no sensible. |
| `BiometricManager` | Comodidad de desbloqueo (huella/rostro) sin depender de WebAuthn en el WebView. |
| Enlaces directos `startapp` | El botón del bot abre el intent dentro de Telegram, sin saltos. |
| Mismo WebView siempre | Un único origen de almacenamiento por dispositivo/cliente, evitando la partición Safari↔PWA. |

## 3. Riesgos y conflictos con el diseño actual

- **Regla 7 de AGENTS.md** y todo lo que la repite: README (pilar 3), ARCHITECTURE §E y principio 5, DESIGN_SYSTEM (guard iOS), FEASIBILITY (pilar 4), PLAN (Phase 1/2), SCF dossier.
- **Regla 4:** *nunca* en `CloudStorage`, `localStorage`/`sessionStorage` sin cifrar, ni en D1/KV. Cualquier almacén de la Mini App debe seguir cumpliéndola; `CloudStorage` queda prohibido para secretos.
- **Confianza en el cliente Telegram:** el código web corre dentro de una app que no controlamos; evaluar qué pasa si el cliente o el token del bot se comprometen (el token del bot permite **validar y falsificar** `initData`).
- **Persistencia:** qué ocurre al borrar caché de Telegram, reinstalar, cambiar de dispositivo, o cerrar sesión. Riesgo de pérdida de bóveda; el respaldo `.agvault` y la frase de recuperación siguen siendo obligatorios.
- **Cumplimiento:** las políticas de Telegram y de App Store/Google Play para Mini Apps que manejan cripto. La documentación del repo afirma una "exclusividad TON de enero 2025"; **esa afirmación no está verificada** y debe confirmarse o corregirse en las fuentes oficiales.
- **Compatibilidad:** versiones mínimas de Bot API/cliente para `SecureStorage` y `BiometricManager`; qué porcentaje de usuarios las tiene.
- **WebAuthn/PRF y passkeys** dentro de los WebViews de Telegram: probablemente limitado; no asumir que funciona.
- **CSP y cabeceras:** una Mini App se carga en un contexto distinto (no `frame-ancestors 'none'` si Telegram embebe vía iframe en Desktop/Web). Hay que verificar qué política es compatible sin debilitar la actual.
- **Origen/dominio:** igual que en la auditoría P0-8, el dominio definitivo debe fijarse antes de tener usuarios.

## 4. Preguntas a investigar (con fuentes oficiales: core.telegram.org y changelog de Bot API)

1. ¿Qué versión de Bot API/cliente exige cada API (`SecureStorage`, `DeviceStorage`, `BiometricManager`, `startapp`, pantalla completa)? ¿Cuáles están en iOS, Android, Desktop y Web?
2. Semántica real de `SecureStorage`: ¿sobrevive a reinstalación? ¿se sincroniza/respalda en iCloud/Google? ¿límites de tamaño? ¿protege contra extracción en dispositivo con root/jailbreak?
3. ¿Se puede **evitar** guardar la semilla en el cliente (p. ej. cuenta `C...` con passkey y semilla solo como recuperación)? ¿Es viable passkey/WebAuthn dentro de la Mini App?
4. ¿Cómo se comporta IndexedDB en el WebView de Telegram en iOS/Android/Desktop a lo largo del tiempo (eviction, borrado de caché)?
5. ¿Qué políticas de Telegram y de las tiendas aplican a una wallet no custodial como Mini App?
6. Modelo de sesión: validar `initData` en el Worker, emitir sesión propia de corta duración, rotación, protección anti-replay, y qué se hace si se rota el token del bot.
7. ¿Se mantiene un **respaldo fuera de Telegram** (PWA/`.agvault`) para recuperación? ¿Cómo se migra una bóveda entre ambos?
8. Impacto en la experiencia en grupos: abrir Mini App desde un botón de grupo, privacidad de `/balance`, y quién puede abrir qué intent.

## 5. Criterios de decisión

Aprobar solo si **todas** se cumplen:
- La semilla **nunca** sale del dispositivo ni toca `CloudStorage`, servidor, logs ni D1/KV (Regla 4).
- Existe recuperación documentada y probada ante pérdida de caché/dispositivo.
- La identidad se valida en servidor con `initData` (con `auth_date` acotado) y el flujo `/connect` queda cerrado frente a P0-1.
- La seguridad de la bóveda no empeora respecto a la actual (idealmente mejora: ver auditoría P0-2/P0-3).
- Cumple las políticas de Telegram y de las tiendas.

## 6. Plan de trabajo propuesto (sin ejecutar)

1. **Investigación (spike, sin código de producción):** responder §4 con fuentes oficiales; registrar enlaces y fechas en este archivo.
2. **Prototipo aislado en Testnet** (rama separada): Mini App mínima que (a) valida `initData` en el Worker, (b) abre un intent firmado, (c) prueba persistencia de bóveda cifrada en el WebView en iOS y Android reales.
3. **Decisión documentada** (ADR) con resultados del prototipo.
4. **Si se aprueba:** enmendar `AGENTS.md` (Regla 7) y actualizar README, ARCHITECTURE, DESIGN_SYSTEM, FEASIBILITY, PLAN y SCF; reutilizar `apps/pwa` como shell de la Mini App; mantener el PWA como respaldo opcional.
5. **Si se rechaza:** mantener bot puro y mitigar con bandeja de intents + Web Push (auditoría §4).

## 7. Qué NO hacer mientras tanto

- No guardar semilla, PIN ni claves en `CloudStorage`, `localStorage` ni `sessionStorage`.
- No usar `initDataUnsafe` en el servidor; solo `initData` validado.
- No tocar `AGENTS.md` ni la arquitectura hasta cerrar el paso 3.

> **Nota de fiabilidad:** las capacidades de la sección 2 provienen de una búsqueda web con fuentes secundarias. Tratarlas como **hipótesis** hasta confirmarlas en la documentación oficial de Telegram.
