# AUDITORÍA DEFENSIVA DE INVARIANTES PRE-MAINNET — BLOQUE 1 (+ SMART ACCOUNT)

**Proyecto:** `astrowallet` (Pillar 1 Hub: AstroID SSO, Non-Custodial Vault, Universal Clear-Sign Hub, Fee-Bump Relay, P2P ClaimEscrow & CAP-46 Counterfactual Smart Accounts)
**Fecha de auditoría:** 2026-11-25
**Modo:** Solo lectura (Zero-Trust Code-First; sin modificación de código fuente ni ejecución de transacciones)
**Alcance inspeccionado:**
- [contracts/claim-escrow/src/lib.rs](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs) (1–1560)
- [apps/server/src/routes/relay.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts) (1–833)
- [apps/server/src/db/repository.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts) (1–1407)
- [apps/server/src/durable-objects/channel-pool.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/durable-objects/channel-pool.ts) (1–107)
- [apps/server/wrangler.toml](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml) (1–177)
- Helpers y frontera Smart Account (`C...`): [packages/stellar-core/src/smart-account/index.ts](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/smart-account/index.ts), [packages/security-shield/src/decoder.ts](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts), [packages/security-shield/src/rules.ts](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/rules.ts), [packages/security-shield/src/index.ts](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/index.ts), [apps/server/src/routes/connect-verifier.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect-verifier.ts), [apps/server/src/routes/connect.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect.ts), [apps/server/src/routes/intents.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/intents.ts), [apps/server/src/stellar-verifier.ts](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/stellar-verifier.ts), [packages/stellar-core/src/ledger/client.ts](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/ledger/client.ts), [packages/stellar-core/src/dev-lab/index.ts](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/dev-lab/index.ts), [apps/pwa/src/state/wallet-context.tsx](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx).

---

## A) Tabla de Verificación de Invariantes Críticas (1–5 + Smart Account)

| # | Invariante / Sub-invariante | Estado | Referencia (`archivo:línea`) | Resumen Técnico |
| :- | :--- | :---: | :--- | :--- |
| **1a** | Atomicidad SQL de `relay_daily_usage` bajo concurrencia en D1 | **PASS** | [repository.ts:926-981](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L926-L981) | `INSERT OR IGNORE` inicializa la fila UTC y `UPDATE ... WHERE day_utc = ? AND (CAST(spent_stroops AS INTEGER) + ?) <= ? RETURNING spent_stroops` ejecuta la verificación e incremento en una sola sentencia atómica serializada por SQLite/D1. `refundRelayBudget` usa `MAX(0, ...)`. |
| **1b** | Exactitud entre `estimatedFeeStroops` descontado en D1 vs `resourceFee`/`outerFee` real en OZ Channels (`feebump` y `soroban`) | **FAIL** | [relay.ts:220-271](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L220-L271), [decoder.ts:172-257](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L172-L257) | En modo `soroban`, D1 siempre descuenta una constante ciega (`relayMaxFeeStroops = 2_000_000`) sin simular `resourceFee`. En modo `feebump`, D1 descuenta `max(innerTx.fee, 100..100_000)` pero un `innerTx` Classic con `fee = 0` (permitido por Stellar si va envuelto en `FeeBumpTransaction`) o Soroban con `innerTx.fee < outerMaxFee` solo descuenta `100`–`500` stroops en D1 mientras OZ Channels paga el `outerFee` completo (amplificación de agotamiento de fondos reales vs presupuesto D1 de hasta 4,000x). |
| **2a** | Integridad de `intentAuth` (`relay-intent:<intentId>:<status>`) y no-reutilización en `/v1/relay/submit` | **FAIL** | [relay.ts:132-170](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L132-L170), [relay.ts:273-326](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L273-L326), [relay.ts:395-402](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L395-L402) | 1) No valida `intent.payloadJson`: un intent `pending` (ej. `pay`/`request`/`swap`) o `claim` (`pending`/`signed`) puede usarse para patrocinar operaciones arbitrarias o quemar la única llave `relay-intent:<id>:<status>` de la víctima (DoS de gasless claim/refund). 2) Rompe intents `split` multi-pagador tras el 1.er participante. 3) Cuando la PWA envía `intentAuth` + `walletAuth` juntos ([wallet-context.tsx:625-651](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L625-L651)), si `intentAuth` ya fue consumido devuelve `409` en vez de hacer fallback a `walletAuth`. 4) `purgeExpiredRecords` borra `relay-intent:*:signed` tras 30 días aunque los intents `signed` nunca se borran ([repository.ts:997-1013](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L997-L1013)). |
| **2b** | Integridad de `walletAuth` (SEP-53 + nonce + `linked_addresses`) y ligadura al XDR enviado a OZ Channels | **FAIL** | [relay.ts:172-195](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L172-L195), [relay.ts:375-392](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L375-L392), [relay.ts:418-421](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L418-L421) | 1) En modo `soroban`, `expectedPayloadHash` solo hashea `body.funcXdrBase64` e **ignora `body.authEntriesXdrBase64`**, permitiendo mutar/inyectar entradas de autorización sin invalidar la firma `walletAuth`. 2) En modo `feebump`, `walletAuth.address` nunca se compara contra `decoded.sourceAccount`: cualquier cuenta vinculada puede patrocinar XDRs firmados por cuentas externas no vinculadas. 3) `decodeAuthEntryXdr` acepta `HashIdPreimage` que OZ Channels rechaza, y no verifica `RELAY_ALLOWED_CONTRACTS` en `decodedAuth.invocation.contractId` ni en `subInvocations`. |
| **2c** | Coincidencia estricta del XDR enviado a OZ Channels con Scan & Shield y `RELAY_ALLOWED_CONTRACTS` | **FAIL** | [relay.ts:273-300](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L273-L300), [decoder.ts:249](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L249) | 1) En `feebump`, las operaciones Classic (`op.soroban === undefined`) y las operaciones Soroban `extendFootprintTtl`/`restoreFootprint` **no pasan por `RELAY_ALLOWED_CONTRACTS`** cuando se usa `walletAuth` o un `intentAuth` distinto de `claim`. 2) `evaluateDecodedTransaction` y `evaluateSorobanInvocation` en `relay.ts` se invocan **sin** `directoryEntries`, `verifiedAssets`, `memoRequiredDestinations` ni simulación RPC, desactivando en el servidor las reglas `SPOOFED_PROTECTED_ASSET`, `DIRECTORY_MALICIOUS_*` y `MISSING_SEP29_EXCHANGE_MEMO`. |
| **3** | Consistencia de `POST /v1/relay/bootstrap` (`sponsored_reserve` CAP-33 y `direct` `createAccount`) ante fallos parciales y concurrencia | **FAIL** | [relay.ts:557-830](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L557-L830), [wallet-context.tsx:2888-2948](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L2888-L2948), [repository.ts:1011](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L1011) | 1) **`mode` no está firmado en `challengeMsg` y es elegible por el cliente**: cualquier usuario puede enviar `mode: "direct"` para extraer **1.5 XLM líquidos reales** por cuenta en vez de reserva patrocinada CAP-33 (drenaje de 37.5 XLM/día). 2) **Bloqueo permanente (Permanent Lockout)**: en `sponsored_reserve`, el servidor marca `bootstrap:tg:*` y `bootstrap:addr:*` (que `purgeExpiredRecords` jamás expira) y devuelve `sponsorSignedXdr` (TTL 180s) para que la PWA co-firme y envíe a Horizon; si falla la red del cliente o hay colisión de secuencia (`tx_bad_seq` porque `sponsorSequence` se lee de Horizon sin mutex/DO), la cuenta nunca se crea en Stellar pero queda **bloqueada de por vida (HTTP 409)** en D1. |
| **4** | Volatilidad de `ChannelPoolDO` y manejo de `tx_bad_seq` + `X-Channel-Account` en modo `feebump` y `soroban` | **FAIL** | [channel-pool.ts:16-20](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/durable-objects/channel-pool.ts#L16-L20), [relay.ts:482-525](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L482-L525), [wrangler.toml:121-177](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml#L121-L177) | 1) En `FeeBumpTransaction` de Stellar, el `feeSource` (cuenta canal) **no consume número de secuencia**; la secuencia pertenece a `innerTx.sourceAccount` (el usuario). Reintentar `tx_bad_seq` en otro canal en modo `feebump` es inútil y duplica latencia/carga. 2) `leases` vive solo en un `Map` en RAM sin `ctx.storage`: cualquier desalojo/deploy del DO o timeout de 10s en `fetchFn` (el bloque `finally` libera el lease mientras la TX sigue en vuelo en Stellar Core) reasigna el mismo canal inmediatamente, provocando `tx_bad_seq` en modo `soroban`. 3) `RELAY_CHANNEL_ACCOUNTS` no está configurado en `wrangler.toml` (`[vars]`, `[env.testnet]`, `[env.mainnet]`), por lo que `poolStub` es `null` en producción. |
| **5a** | `claim-escrow`: Consistencia de `EscrowedBalance(token)` frente a `rescue_excess` en todos los flujos | **PASS** | [lib.rs:106-130](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L106-L130), [lib.rs:234-291](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L234-L291), [lib.rs:341-375](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L341-L375) | `create_claim` mide el delta exacto `bal_after - bal_before == amount` (rechazando tokens fee-on-transfer) e incrementa `EscrowedBalance(token)`. `claim`, `refund_expired*` y `cancel_claim*` aplican CEI (cambian `status` a terminal y decrementan `EscrowedBalance` antes de `token_client.transfer`). `rescue_excess` exige `amount <= total_balance.checked_sub(escrowed)`. |
| **5b** | `claim-escrow`: Ciclo de vida de TTL y archival de almacenamiento `Persistent`/`Instance` en Soroban | **FAIL** | [lib.rs:9-17](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L9-L17), [lib.rs:76-82](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L76-L82), [lib.rs:132-140](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L132-L140), [client.ts:545-549](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/ledger/client.ts#L545-L549) | 1) **Desincronización de TTL de `Instance` vs `Claim` (`INSTANCE_TTL_EXTEND_TO` < `expires_at` + buffer)**: `INSTANCE_TTL_EXTEND_TO` es `864_000` ledgers (~50 días a 5s/ledger, o 30 días a 3s/ledger) con threshold de solo 7 días, mientras que un claim de 30 días recibe `compute_claim_ttl_ledgers = 44 días * 28_800 = 1_267_200` ledgers (~73 días a 5s/ledger). Si el contrato no recibe tráfico durante >30–50 días, la instancia del contrato (`Guardian`, `Initialized`, código) y/o el claim expiran a archivo, y `submitSorobanOperation` en `client.ts:545` **aborta con `NonRetryableSorobanError` en `isSimulationRestore(sim)`** sin ejecutar `RestoreFootprintOp`, dejando los fondos bloqueados desde la PWA. 2) `EscrowedBalance(token)` se extiende a `CLAIM_TTL_MAX_LEDGERS` (60 días conservadores) con threshold `30 días`; si pasan 31 días sin nuevas operaciones y `EscrowedBalance` tiene TTL residual de 30.1 días (> threshold 30 días), un nuevo `create_claim` a 30 días **no extiende `EscrowedBalance`**, permitiendo que `EscrowedBalance(token)` se archive antes de que venza el nuevo claim. |
| **5c** | `claim-escrow`: Verificación Ed25519 en `claim`, ligadura a contrato/destinatario y reversión atómica de `ReentrancyLock` | **PASS** | [lib.rs:84-104](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L84-L104), [lib.rs:396-449](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L396-L449) | `build_claim_sign_payload` liga `"AW_CLAIM_V2:" \|\| contract_addr.to_xdr() \|\| claim_id \|\| recipient.to_xdr()`. `recipient.require_auth()` + `env.crypto().ed25519_verify` impiden front-running o sustitución de destinatario. `ReentrancyLock` usa `temporary()` storage y si `ed25519_verify` o `token.transfer` hacen trap, la VM de Soroban revierte atómicamente toda la transacción incluyendo el lock. |
| **6 (Extra)** | **Activación y Auditoría de Smart Account (`C...` CAP-46 Counterfactual + Passkeys/Guardian)** | **FAIL** | [smart-account/index.ts:62-135](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/smart-account/index.ts#L62-L135), [wallet-context.tsx:660-715](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L660-L715), [wallet-context.tsx:3000-3015](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L3000-L3015), [connect-verifier.ts:87-131](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect-verifier.ts#L87-L131), [relay.ts:47,274-280,335](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L47) | **Trampa de fondos (Fund-Locking Trap) al activar `SMART_ACCOUNT_WASM_HASH`:** 1) La PWA vincula públicamente la dirección `C...` contrafactual en `/v1/identity/resolve` y permite recibir pagos SAC (`buildSacTransferOperation`), pero **no existe flujo de despliegue on-chain (`buildDeploySmartAccountOperation` nunca se invoca fuera de tests) ni firma `__check_auth` desde la PWA** (`activeAccount` siempre es `kind: "classic"`). 2) El relayer y Scan & Shield **bloquean** tanto el despliegue CAP-46 (`hostFunctionTypeCreateContractV2` rechazado en `relay.ts:335` y `276`) como la administración (`update_context_rule` bloqueado por `DANGEROUS_SOROBAN_FUNCTIONS` en `rules.ts:135`) y `WalletAuthSchema.address` rechaza direcciones `C...`. 3) Si `SMART_ACCOUNT_WASM_HASH` no está definido en el servidor, `connect-verifier.ts:109` omite verificar la derivación contrafactual y permite vincular **cualquier contrato `C...` arbitrario** como `"smart"` account. 4) Desincronización de `credentialIdB64` entre `webauthn-fingerprint.ts` (que sí lo guarda en IndexedDB) y `wallet-context.tsx:2775,3001` (que nunca lo pasa, derivando siempre con `"default"`). |

---

## B) Hallazgos Confirmados (Traza Técnica, Causa Raíz, Fix Quirúrgico y Test de Regresión)

---

### [HALLAZGO-01] `P0-MAINNET-BLOCKER` — Drenaje Directo de XLM del Sponsor (`mode: "direct"` no firmado) y Bloqueo Permanente de Usuarios/Direcciones en `POST /v1/relay/bootstrap`

- **Severidad:** `P0-MAINNET-BLOCKER`
- **Ubicación exacta:**
  - [apps/server/src/routes/relay.ts:557-563](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L557-L563) (`BootstrapBodySchema`)
  - [apps/server/src/routes/relay.ts:623-631](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L623-L631) (`challengeMsg` sin `body.mode`)
  - [apps/server/src/routes/relay.ts:659-707](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L659-L707) (reserva D1 de `bootstrap:tg:*` y `bootstrap:addr:*`)
  - [apps/server/src/routes/relay.ts:716-796](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L716-L796) (lectura concurrente de `sponsorSequence` sin lock y retorno sin envío en `sponsored_reserve`)
  - [apps/server/src/db/repository.ts:1010-1013](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L1010-L1013) (`dedup_key NOT LIKE 'bootstrap:%'`)
  - [apps/pwa/src/state/wallet-context.tsx:2901-2938](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L2901-L2938) (`bootstrapActiveAccount`)

#### Traza Técnica Paso a Paso
1. **Vector A — Extracción de XLM líquido vía `mode: "direct"`:**
   - `BootstrapBodySchema` ([relay.ts:559](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L559)) acepta `mode: z.enum(["sponsored_reserve", "direct"]).default("sponsored_reserve")` directamente del JSON del cliente.
   - El mensaje SEP-53 firmado por el cliente ([relay.ts:623](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L623)) es:
     `astrowallet-bootstrap:v1:${config.network}:${body.address}:${body.timestamp}:${body.nonce}` — **no incluye `body.mode`**.
   - En `mode: "sponsored_reserve"`, el sponsor usa CAP-33 (`beginSponsoringFutureReserves` + `createAccount(startingBalance: "0")` + `endSponsoringFutureReserves`), donde el sponsor mantiene la propiedad de los 1.0 XLM de reserva base.
   - Sin embargo, cualquier cliente (o atacante con cuentas de Telegram) puede enviar `"mode": "direct"` en el body POST. El servidor ejecuta [relay.ts:773-778](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L773-L778): `Operation.createAccount({ destination: body.address, startingBalance: config.relayBootstrapStartingBalanceXlm })` (por defecto **1.5 XLM** líquidos transferidos a la cuenta del usuario) y lo transmite directamente a Horizon ([relay.ts:801](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L801)).
   - El usuario puede hacer `accountMerge` inmediatamente y extraer el 100% de los 1.5 XLM líquidos (hasta 25 veces/día = **37.5 XLM/día** drenados de `RELAY_SPONSOR_SECRET`, mientras D1 solo registra un gasto ficticio de `"100000"` stroops = `0.01 XLM` por llamada en [relay.ts:699](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L699)).
2. **Vector B — Bloqueo Permanente (Permanent Lockout) en `mode: "sponsored_reserve"` bajo concurrencia o fallo de red del cliente:**
   - En [relay.ts:687-706](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L687-L706), el servidor inserta `bootstrap:tg:<net>:<tgId>` y `bootstrap:addr:<net>:<addr>` en `processed_alerts` y descuenta 1 unidad del presupuesto diario.
   - En [relay.ts:716-739](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L716-L739), el Worker lee `sponsorSequence` de Horizon `/accounts/${sponsorAddress}` **sin ningún mutex ni Durable Object**.
   - Si dos usuarios (A y B) llaman a `/v1/relay/bootstrap` en el mismo intervalo de cierre de ledger (~5 segundos), ambos Workers leen el **mismo `sponsorSequence = N`** de Horizon y firman dos transacciones distintas con `seq = N + 1`.
   - En [relay.ts:789-796](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L789-L796), el servidor retorna `200 OK` con `{ sponsorSignedXdr }` **dejando las llaves `bootstrap:tg:*` y `bootstrap:addr:*` permanentemente grabadas en D1**.
   - Las PWAs de los usuarios A y B co-firman con su `keypair` ([wallet-context.tsx:2929-2936](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L2929-L2936)) y envían a Horizon. La TX de A entra en el ledger; la TX de B es rechazada por Horizon con `tx_bad_seq` (o falla por pérdida de conexión móvil / cierre de Mini App antes de 180s).
   - Cuando el usuario B reintenta activar su cuenta, `/v1/relay/bootstrap` rechaza en [relay.ts:688-690](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L688-L690) con `409 Conflict: "This Telegram account has already used its sponsored activation"`.
   - Como [repository.ts:1011](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L1011) excluye explícitamente `dedup_key NOT LIKE 'bootstrap:%'` de la limpieza de 30 días, **el usuario B y su dirección quedan bloqueados para siempre sin cuenta en Stellar**.

#### Por qué no lo detiene la validación actual
- `challengeMsg` no liga `mode`, y `BootstrapBodySchema` expone `mode: "direct"` públicamente sin restricción de configuración.
- El flujo `sponsored_reserve` hace commit definitivo del estado anti-replay en D1 *antes* de que la transacción co-firmada exista on-chain, y carece tanto de serialización de secuencia del sponsor como de recuperación idempotente si la cuenta sigue dando HTTP 404 en Horizon.

#### Corrección Mínima Quirúrgica
1. Ligadura criptográfica de `mode` en `challengeMsg` (`astrowallet-bootstrap:v1:${config.network}:${body.mode}:${body.address}:${body.timestamp}:${body.nonce}`) y deshabilitar `mode: "direct"` en Mainnet (o restringirlo por flag explícito `RELAY_ALLOW_DIRECT_BOOTSTRAP=false`).
2. En `/v1/relay/bootstrap`, serializar el uso de `sponsorAddress` mediante un lease en `ChannelPoolDO` (clave `sponsor:${sponsorAddress}`).
3. Si `claimedUser` o `claimedAddr` ya existen en `processed_alerts`, pero Horizon ya confirmó en el paso anterior ([relay.ts:635-657](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L635-L657)) que `confirmedUnfunded === true` (la cuenta dio `404 Not Found` en Horizon) **y** la entrada de `processed_alerts` tiene `created_at < nowSec - 180` (el `timeout(180)` de la TX anterior ya expiró en Stellar y es matemáticamente imposible que se ejecute), permitir re-firmar un nuevo `sponsorSignedXdr` para la misma `(telegramUserId, address)` sin volver a consumir presupuesto diario.

#### Test de Regresión Exacto (Vitest)
```typescript
// apps/server/src/audit-regression.test.ts
it("rejects mode downgrade to 'direct' when signature was bound to 'sponsored_reserve' and allows retry after 180s if still unfunded on Horizon", async () => {
  const sponsorKp = Keypair.random();
  const userKp = Keypair.random();
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = "bootstrap_nonce_12345";
  // Signed for sponsored_reserve:
  const msg = `astrowallet-bootstrap:v1:testnet:sponsored_reserve:${userKp.publicKey()}:${nowSec}:${nonce}`;
  const signatureBase64 = signChallengeMessage(userKp, msg);

  // Attempt to tamper mode -> "direct" must fail with 403
  const tamperRes = await app.request("/v1/relay/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${validSessionToken}` },
    body: JSON.stringify({
      address: userKp.publicKey(),
      mode: "direct",
      timestamp: nowSec,
      nonce,
      signatureBase64,
    }),
  });
  expect(tamperRes.status).toBe(403);
});
```

---

### [HALLAZGO-02] `P0-MAINNET-BLOCKER` — Ruptura de Integridad en `/v1/relay/submit`: `walletAuth` No Firma `authEntriesXdrBase64`, No Valida `sourceAccount`, y `feebump` Permite Operaciones Fuera de `RELAY_ALLOWED_CONTRACTS`

- **Severidad:** `P0-MAINNET-BLOCKER`
- **Ubicación exacta:**
  - [apps/server/src/routes/relay.ts:172-195](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L172-L195) (`walletAuth` hash e identidad)
  - [apps/server/src/routes/relay.ts:273-291](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L273-L291) (bucle de `decoded.operations` y llamada a `evaluateDecodedTransaction` sin contexto)
  - [apps/server/src/routes/relay.ts:359-392](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L359-L392) (validación de `authEntriesXdrBase64` en modo `soroban`)
  - [packages/security-shield/src/decoder.ts:249](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L249) (`op.soroban` solo definido para `invokeHostFunction`)
  - [packages/security-shield/src/decoder.ts:327-373](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L327-L373) (`decodeAuthEntryXdr` acepta `HashIdPreimage`)

#### Traza Técnica Paso a Paso
1. **`authEntriesXdrBase64` no está cubierto por la firma `walletAuth` en modo `soroban`:**
   - En [relay.ts:174-175](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L174-L175):
     `const rawPayload = body.mode === "soroban" ? body.funcXdrBase64 : body.signedTxXdrBase64;`
     `const expectedPayloadHash = await sha256Hex(rawPayload);`
   - `body.authEntriesXdrBase64` **no forma parte de `expectedPayloadHash`**, pero en [relay.ts:420](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L420) se envía directamente a OpenZeppelin Channels como `{ func: body.funcXdrBase64, auth: body.authEntriesXdrBase64 }`.
   - Además, en [relay.ts:375-392](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L375-L392), el servidor evalúa `evaluateSorobanInvocation(decodedAuth.invocation)` pero **nunca verifica que `decodedAuth.invocation.contractId` (ni sus `subInvocations`) pertenezcan a `config.relayAllowedContracts`**, ni que `decodedAuth.kind === "soroban_authorization_entry"` (ya que `decodeAuthEntryXdr` acepta un `HashIdPreimage` sin firma).
2. **`walletAuth.address` no está ligado a `decoded.sourceAccount` en modo `feebump`:**
   - En [relay.ts:180-193](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L180-L193), el servidor verifica que `w.address` esté en `linked_addresses` y haya firmado `expectedPayloadHash`.
   - Pero cuando `body.mode === "feebump"` ([relay.ts:238-326](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L238-L326)), el servidor **nunca verifica que `decoded.sourceAccount === body.walletAuth.address`** (ni que `op.source` pertenezca a `w.address`).
   - Como resultado, una sola cuenta vinculada `G_LINKED` puede actuar como proxy de patrocinio de gas para transacciones `signedTxXdrBase64` cuyo `sourceAccount` sea cualquier cuenta externa no vinculada `G_EXTERNAL`.
3. **Bypass de `RELAY_ALLOWED_CONTRACTS` en modo `feebump`:**
   - En [relay.ts:273-287](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L273-L287):
     ```typescript
     for (const op of decoded.operations) {
       if (op.soroban) {
         if (!op.soroban.contractId || !config.relayAllowedContracts.includes(op.soroban.contractId)) {
           return c.json({ error: "Contract in feebump is not on the relay allowlist" }, 403);
         }
       } else if (intentAuthRecord?.actionType === "claim") {
         return c.json({ error: "Claim intentAuth only permits Soroban ClaimEscrow operations" }, 403);
       }
     }
     ```
   - Si el request usa `walletAuth` (o un `intentAuth` cuyo `actionType !== "claim"`, p. ej. `pay`, `swap`, `sign_xdr`), **cualquier operación donde `op.soroban` sea `undefined` pasa libremente sin restricción**.
   - Según [decoder.ts:249](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L249), `op.soroban` solo se puebla cuando `type === "invokeHostFunction"`. Por tanto, operaciones Soroban costosas como `restoreFootprint` o `extendFootprintTtl` (sobre cualquier contrato de la red) y todas las operaciones Classic (`payment`, `pathPayment*`, `manageSellOffer`, `manageData`, `bumpSequence`, `changeTrust`, etc.) se reenvían a OZ Channels burlando `RELAY_ALLOWED_CONTRACTS`.
   - Incluso dentro de `invokeHostFunction`, solo se comprueba el `op.soroban.contractId` raíz, pero no los `contractId` dentro de `op.soroban.subInvocations`.
4. **Scan & Shield degradado en `relay.ts`:**
   - En [relay.ts:289-291](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L289-L291) y [relay.ts:359-364](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L359-L364), `evaluateDecodedTransaction` y `evaluateSorobanInvocation` se llaman sin `directoryEntries`, sin `verifiedAssets` y sin `memoRequiredDestinations`.
   - En [rules.ts:398-406](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/rules.ts#L398-L406), cuando `verifiedAssets` está vacío/indefinido, los activos protegidos falsos (ej. falso `USDC`) se degradan de `SPOOFED_PROTECTED_ASSET` (`blocksSigning: true`) a `UNVERIFIED_PROTECTED_ASSET_NO_REGISTRY` (`severity: "warning", blocksSigning: false`), permitiendo su paso por el relayer.

#### Por qué no lo detiene la validación actual
- `sha256Hex(rawPayload)` se calculó solo sobre `funcXdrBase64` en vez de concatenar canónicamente `funcXdrBase64` y `authEntriesXdrBase64`.
- La rama `else if (intentAuthRecord?.actionType === "claim")` dejó desprotegido el caso `!op.soroban` para todos los demás métodos de autenticación (`walletAuth` y otros `intentAuth`).

#### Corrección Mínima Quirúrgica
1. En modo `soroban`, calcular `rawPayload = [body.funcXdrBase64.trim(), ...body.authEntriesXdrBase64.map((e) => e.trim())].join(":")` (tanto en `relay.ts` como en el cliente si usa modo `soroban`), y enviar los strings `.trim()` a OZ Channels.
2. En modo `soroban`, exigir `decodedAuth.kind === "soroban_authorization_entry"` y validar recursivamente que todo `contractId` en `decodedAuth.invocation` y sus `subInvocations` esté en `config.relayAllowedContracts`.
3. En modo `feebump`, rechazar toda operación con `!op.soroban` (el relayer OZ Channels de AstroWallet está diseñado para patrocinar invocaciones a contratos de `RELAY_ALLOWED_CONTRACTS`), validar recursivamente `subInvocations`, y si se autenticó vía `walletAuth`, exigir `decoded.sourceAccount === body.walletAuth.address`.

#### Test de Regresión Exacto (Vitest)
```typescript
// apps/server/src/audit-regression.test.ts
it("rejects feebump relay when walletAuth address does not match inner transaction sourceAccount or op is non-allowlisted Classic", async () => {
  const linkedKp = Keypair.random();
  const unlinkedKp = Keypair.random();
  await repo.linkVerifiedAddresses({
    telegramUserId: "1001",
    accounts: [{ address: linkedKp.publicKey(), kind: "classic", label: "Main", verifiedSigHash: "h" }],
  });

  const innerTx = new TransactionBuilder(new Account(unlinkedKp.publicKey(), "100"), {
    fee: "100",
    networkPassphrase: "Test SDF Network ; September 2015",
  })
    .addOperation(Operation.manageData({ name: "spam", value: "1" }))
    .setTimeout(60)
    .build();
  innerTx.sign(unlinkedKp);
  const signedTxXdrBase64 = innerTx.toXDR();

  const payloadHash = await sha256Hex(signedTxXdrBase64);
  const nowSec = Math.floor(Date.now() / 1000);
  const nonce = "nonce_mismatch_123";
  const msg = `astrowallet-relay:v1:testnet:feebump:${payloadHash}:${nowSec}:${nonce}`;
  const signatureBase64 = signChallengeMessage(linkedKp, msg);

  const res = await app.request("/v1/relay/submit", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      mode: "feebump",
      signedTxXdrBase64,
      walletAuth: {
        address: linkedKp.publicKey(),
        timestamp: nowSec,
        nonce,
        payloadHash,
        signatureBase64,
      },
    }),
  });
  expect(res.status).toBe(403);
});
```

---

### [HALLAZGO-03] `P1-HIGH` — Secuestro y Bloqueo de `intentAuth` en `/v1/relay/submit`: Sin Ligadura a `claim_id`/Parámetros del Intent, Bloqueo `409` sin Fallback a `walletAuth`, y Ruptura de `split` / Re-ejecución tras 30 Días

- **Severidad:** `P1-HIGH`
- **Ubicación exacta:**
  - [apps/server/src/routes/relay.ts:132-195](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L132-L195) (evaluación de `intentAuth` y salto de `walletAuth` cuando `authorized === true`)
  - [apps/server/src/routes/relay.ts:302-326](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L302-L326) y [relay.ts:341-357](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L341-L357) (verificación de `claim` sin validar `claim_id` ni función por etapa)
  - [apps/server/src/routes/relay.ts:395-402](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L395-L402) (`claimAlertDedupKey("relay-intent:<intentId>:<status>")`)
  - [apps/pwa/src/state/wallet-context.tsx:625-651](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L625-L651) (envío simultáneo de `intentAuth` y `walletAuth`)
  - [apps/server/src/db/repository.ts:997-1013](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L997-L1013) (`purgeExpiredRecords`)

#### Traza Técnica Paso a Paso
1. **Falta de ligadura entre el XDR y `intent.payloadJson` / `claim_id`:**
   - Para un intent `claim`, el link de Telegram (que se comparte en chats o grupos) contiene públicamente `intentId` y `sig`.
   - En [relay.ts:302-326](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L302-L326) (`feebump`) y [relay.ts:341-357](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L341-L357) (`soroban`), el servidor solo verifica que el contrato invocado sea `config.claimEscrowContractId` (y si está expirado, que la función sea `refund_expired*`).
   - **No verifica que el primer argumento (`s.args[0]`) sea `deriveClaimId(intent.intentId)`**, ni que en estado `pending` la función sea `create_claim`, ni que en estado `signed` (no expirado) sea `claim`/`cancel_claim*`.
   - Cualquier observador del link en un grupo puede enviar una llamada inocua (p. ej. `extend_claim_ttl` o `get_claim` sobre cualquier `claim_id`) a `/v1/relay/submit` usando el `{ intentId, sig }` del link. Eso consume `relay-intent:<intentId>:signed` en `processed_alerts` ([relay.ts:396-400](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L396-L400)).
2. **Negación de servicio (409 Conflict) a usuarios con cuenta vinculada porque `walletAuth` se ignora si `intentAuth` es válido:**
   - La PWA ([wallet-context.tsx:644-650](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L644-L650)) envía **ambos** `walletAuth` e `intentAuth` en el mismo body JSON.
   - En [relay.ts:132-170](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L132-L170), `intentAuth` se evalúa primero y pone `authorized = true` **sin comprobar aún si `relay-intent:<intentId>:<status>` ya fue consumido**.
   - Debido a `if (!authorized && body.walletAuth)` en [relay.ts:172](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L172), el servidor **salta completamente `body.walletAuth`**.
   - Luego, en [relay.ts:395-400](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L395-L400), `claimAlertDedupKey(stageKey)` devuelve `false` y el servidor responde `409 Conflict: "Intent relay authorization already consumed"`, abortando la operación aunque el usuario envió un `walletAuth` válido y fresco con su propia cuenta vinculada (por ejemplo, si el primer intento de `claim` falló on-chain porque faltaba trustline, o si el remitente intenta `cancel_claim` / `refund_expired` después de un intento fallido de `claim`, ya que ambos comparten el mismo `status === "signed"`).
3. **Incompatibilidad con intents `split` multi-pagador y purga de 30 días:**
   - Un intent `split` permanece en `status = "pending"` hasta que pagan todos los participantes (`paidCount >= participantCount`, [intents.ts:876](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/intents.ts#L876)). La clave `relay-intent:<intentId>:pending` solo permite 1 uso: el 2.º participante recibe `409`.
   - En [repository.ts:997](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L997), `purgeExpiredRecords` conserva indefinidamente los `signed_intents` con `status = 'signed'`, pero en [repository.ts:1011](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/db/repository.ts#L1011) **borra** `processed_alerts` con `created_at < nowSec - 30 * 86_400` (incluyendo `relay-intent:<id>:signed`). Como `isExpiredSignedClaim` ([relay.ts:136,152](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L136)) pasa `intent.expiresAt - 1` a `verifyIntentToken` (anulando la expiración del token), cualquier claim expirado que haya quedado en estado `signed` en D1 vuelve a poder consumir presupuesto del relayer cada 30 días indefinidamente.

#### Por qué no lo detiene la validación actual
- `claimAlertDedupKey(stageKey)` se ejecuta en la línea 397 (después de haber descartado `walletAuth` en la línea 172), y la validación de payload de `claim` solo comprueba `contractId` pero no el `claim_id` (`args[0]`) ni la función permitida en cada etapa.

#### Corrección Mínima Quirúrgica
1. Si `body.walletAuth` está presente y es válido (cuenta vinculada + firma SEP-53 + nonce único), autenticar vía `walletAuth` sin consumir ni bloquearse por `claimedStageKey` de `intentAuth` (o hacer fallback a `walletAuth` cuando `claimAlertDedupKey(stageKey)` retorne `false`).
2. Cuando se autorice exclusivamente por `intentAuth`:
   - Exigir que `intent.actionType === "claim"` (o si es `sign_xdr`, que el hash de la TX coincida con `payload.unsignedXdr`).
   - Verificar que `op.soroban.args[0]?.toLowerCase() === (await deriveClaimId(intent.intentId)).toLowerCase()`.
   - En `status === "pending"`, permitir únicamente `functionName === "create_claim"`; en `status === "signed"` no expirado, únicamente `"claim"` o `"cancel_claim"` / `"cancel_claim_to"`; en `status === "signed"` expirado, únicamente `"refund_expired"` / `"refund_expired_to"`.

#### Test de Regresión Exacto (Vitest)
```typescript
// apps/server/src/audit-regression.test.ts
it("falls back to valid walletAuth when intentAuth stage key was already consumed and enforces claimId binding on intentAuth", async () => {
  // 1. Consume relay-intent:<intentId>:signed once
  // 2. Submit a second request with both the consumed intentAuth AND a fresh valid walletAuth from a linked account
  // Expect 200 OK via walletAuth fallback instead of 409 Conflict
});
```

---

### [HALLAZGO-04] `P1-HIGH` — Desincronización de Contabilidad en `relay_daily_usage`: `fee = 0` en `feebump` y Costo Fijo Ciego en `soroban` Permiten Drenar el Presupuesto Real de OZ Channels hasta 4,000x por Encima de D1

- **Severidad:** `P1-HIGH`
- **Ubicación exacta:**
  - [apps/server/src/routes/relay.ts:220-221](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L220-L221) (`estimatedFeeStroops = config.relayMaxFeeStroops`)
  - [apps/server/src/routes/relay.ts:257-271](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L257-L271) (cálculo de `estimatedFeeStroops` en `feebump`)
  - [packages/security-shield/src/decoder.ts:257](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L257) (`feeStroops: String(parsed.fee)`)

#### Traza Técnica Paso a Paso
1. **En modo `feebump`:**
   - `decodeTransactionEnvelope` ([decoder.ts:257](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L257)) extrae `feeStroops: String(parsed.fee)` de la transacción interna (`innerTx`).
   - En Stellar (CAP-15), una transacción interna firmada con `innerTx.fee = 0` (o `100` stroops) es 100% válida cuando es envuelta por el relayer (OpenZeppelin Channels) en una `FeeBumpTransaction`. Quien paga el fee real en la red Stellar es la cuenta `feeSource` de OZ Channels, la cual asigna su propio `outerMaxFee` (que cubre el `inclusionFee` con surge pricing para `(N_ops + 1)` operaciones más el `sorobanData.resourceFee` completo).
   - En [relay.ts:260-271](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L260-L271):
     ```typescript
     const parsedInnerFee = /^\d+$/.test(decoded.feeStroops) ? BigInt(decoded.feeStroops) : maxFeeAllowed;
     const hasSorobanOp = decoded.operations.some((op) => Boolean(op.soroban));
     const minAccountingFloor = BigInt(Math.max(hasSorobanOp ? 100_000 : 100, decoded.operations.length * 100));
     ```
   - **Caso 1 (Transacción Soroban con `innerTx.fee` bajo o manipulado):** Si un atacante construye una transacción Soroban cuyo `sorobanData.resourceFee` real en XDR es de `1_900_000` stroops pero pone `innerTx.fee = 100_000` (o una operación `restoreFootprint` donde `op.soroban` es `undefined`, por lo que `hasSorobanOp === false` y `minAccountingFloor === 100`), D1 solo descuenta `100` o `100_000` stroops, mientras OZ Channels reemplaza el fee externo para cubrir el `resourceFee` + inclusion fee real.
   - **Caso 2 (Transacción Classic de 5 operaciones con `innerTx.fee = 0`):** D1 solo descuenta `500` stroops (`5 * 100`). Con un presupuesto diario `RELAY_DAILY_BUDGET_STROOPS = 500_000_000` (50 XLM), D1 permite **1,000,000 de transacciones**, lo que en OZ Channels consume el fee externo real de 6 operaciones por transacción.
2. **En modo `soroban`:**
   - `relay.ts` no decodifica ni simula el costo de recursos de `funcXdrBase64`, por lo que deja `estimatedFeeStroops = config.relayMaxFeeStroops` (`2_000_000` stroops = 0.2 XLM por llamada).
   - Si el invocador ejecuta una llamada de 20,000 stroops reales, D1 le cobra 100x más (agotando el presupuesto diario de `500_000_000` en solo **250 llamadas** en todo el día para todos los usuarios). A la inversa, si la llamada simulada por OZ Channels en Mainnet cuesta `8_000_000` stroops (porque OZ Channels simula y arma la TX por su cuenta sin conocer `RELAY_MAX_FEE_STROOPS`), OZ Channels paga `8_000_000` stroops mientras D1 solo contabiliza `2_000_000`.

#### Por qué no lo detiene la validación actual
- `decodeTransactionEnvelope` solo lee `parsed.fee` del encabezado de `Transaction`, pero no extrae `innerTx.sorobanData.resourceFee` del XDR ni detecta `extendFootprintTtl` / `restoreFootprint` como operaciones Soroban.

#### Corrección Mínima Quirúrgica
1. En `decodeTransactionEnvelope` ([decoder.ts:174](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L174)), extraer también `sorobanResourceFeeStroops` desde `(innerTx as unknown as { sorobanData?: xdr.SorobanTransactionData }).sorobanData?.resourceFee()?.toString()` y marcar `hasSorobanOp` para `invokeHostFunction`, `extendFootprintTtl` y `restoreFootprint`.
2. En `relay.ts:257-271`, exigir que `max(BigInt(decoded.feeStroops), BigInt(decoded.sorobanResourceFeeStroops ?? "0")) <= maxFeeAllowed`, y contabilizar en D1 al menos `max(parsedInnerFee, parsedResourceFee + BigInt((decoded.operations.length + 1) * 10_000))` para reflejar el `outerFee` que OZ Channels compromete al hacer fee-bump.

#### Test de Regresión Exacto (Vitest)
```typescript
// apps/server/src/audit-regression.test.ts
it("rejects feebump transaction whose sorobanData.resourceFee exceeds RELAY_MAX_FEE_STROOPS even if innerTx.fee is 100", async () => {
  // Build a Soroban tx with inner fee = 100 but sorobanData.resourceFee = 5_000_000 (> 2_000_000 cap)
  // Submit to /v1/relay/submit -> expect 403 "Transaction fee exceeds relay ceiling"
});
```

---

### [HALLAZGO-05] `P1-HIGH` — Volatilidad de `ChannelPoolDO`, Liberación Prematura en Timeout, Reintento `tx_bad_seq` Erróneo en `feebump` y Pool Desactivado en `wrangler.toml`

- **Severidad:** `P1-HIGH`
- **Ubicación exacta:**
  - [apps/server/src/durable-objects/channel-pool.ts:16-28](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/durable-objects/channel-pool.ts#L16-L28) (`leases = new Map()` en memoria volátil)
  - [apps/server/src/routes/relay.ts:424-528](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L424-L528) (adquisición, reintento `tx_bad_seq` y liberación en `finally`)
  - [apps/server/wrangler.toml:40-65,95-120,151-177](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml#L151-L177) (`RELAY_CHANNEL_ACCOUNTS` ausente)

#### Traza Técnica Paso a Paso
1. **`ChannelPoolDO` está inactivo en producción (`wrangler.toml`):**
   - En [relay.ts:425](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L425): `const poolStub = c.env.CHANNEL_POOL && config.relayChannelAccounts.length > 0 ? ... : null;`.
   - En [wrangler.toml](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml), `CHANNEL_POOL` está declarado como binding en las 3 secciones (`default`, `testnet`, `mainnet`), pero **`RELAY_CHANNEL_ACCOUNTS` no está definido en ninguna sección**. `config.relayChannelAccounts` es `[]` y `poolStub` es siempre `null`.
2. **Malentendido del protocolo Stellar sobre `tx_bad_seq` en modo `feebump`:**
   - En Stellar (CAP-15), una `FeeBumpTransaction` **no tiene campo `seqNum` para el `feeSource` (la cuenta canal)**. El único número de secuencia que se verifica y consume en el ledger es el de `innerTransaction.sourceAccount` (la cuenta del usuario que ya firmó `signedTxXdrBase64`).
   - Por lo tanto, en modo `feebump`, un error `tx_bad_seq` devuelto por el relayer significa que **la secuencia de la cuenta del usuario en `signedTxXdrBase64` es inválida**.
   - Sin embargo, [relay.ts:496-506](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L496-L506) intercepta `/tx_bad_seq/i`, libera el canal 1, adquiere el canal 2 y **reenvía exactamente el mismo `signedTxXdrBase64`**, lo cual vuelve a fallar con `tx_bad_seq` el 100% de las veces en modo `feebump`.
   - Peor aún: si al intentar adquirir el canal 2 todos los demás canales están ocupados (`"errorStatus" in lease` == `429`), las líneas [relay.ts:507-512](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L507-L512) devuelven `502 Bad Gateway` en lugar de `429 Too Many Requests`.
3. **Volatilidad en RAM y liberación prematura tras `AbortSignal.timeout(10_000)`:**
   - En `ChannelPoolDO` ([channel-pool.ts:17](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/durable-objects/channel-pool.ts#L17)), `this.leases` vive únicamente en un `Map` en RAM (no usa `this.state.storage`). Aunque en `wrangler.toml:35` se declaró `new_sqlite_classes = ["ChannelPoolDO"]`, el constructor ([channel-pool.ts:20](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/durable-objects/channel-pool.ts#L20)) ignora `_state`.
   - Si Cloudflare desaloja o reinicia el DO (o hay un deploy), el `Map` se vacía a `0` mientras transacciones en modo `soroban` (donde la cuenta canal **sí** es `tx.sourceAccount` y consume `seqNum`) siguen en vuelo en Stellar Core (~5s de cierre de ledger).
   - Igualmente, si `fetchFn` en [relay.ts:476](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L476) aborta por `AbortSignal.timeout(10_000)` mientras OZ Channels ya transmitió la TX a Stellar Core, el bloque `finally` ([relay.ts:521-525](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L521-L525)) ejecuta `releaseChannel(lease.leaseId)` inmediatamente, entregando la misma cuenta canal al siguiente request concurrente y provocando colisión `tx_bad_seq`.

#### Por qué no lo detiene la validación actual
- Los tests unitarios de `ChannelPoolDO` prueban `/acquire` y `/release` en una misma instancia en memoria sin simular evicción de DO, timeouts de upstream con TX en vuelo, ni la diferencia entre `feebump` (secuencia del usuario) y `soroban` (secuencia del canal).

#### Corrección Mínima Quirúrgica
1. Solo reintentar en otro canal ante `tx_bad_seq` cuando `body.mode === "soroban"` (nunca en `body.mode === "feebump"`).
2. Si `submitWithChannel` lanza un error de timeout/red (estado incierto en mempool), **no llamar a `releaseChannel` en `finally`**, sino dejar que el lease expire por su TTL (o reducir `LEASE_TTL_MS` a `12_000` ms) y persistir los leases activos en `this.state.storage` (o SQLite del DO) para sobrevivir reinicios.

#### Test de Regresión Exacto (Vitest)
```typescript
// apps/server/src/audit-regression.test.ts
it("does not retry tx_bad_seq on a second channel in feebump mode because sequence belongs to innerTx.sourceAccount", async () => {
  let upstreamCalls = 0;
  const fetchFn: FetchLike = async () => {
    upstreamCalls += 1;
    return new Response(JSON.stringify({ error: "tx_bad_seq" }), { status: 400 });
  };
  // Configure 2 relayChannelAccounts and submit mode: "feebump"
  // Expect upstreamCalls === 1 (no futile retry on channel #2)
});
```

---

### [HALLAZGO-06] `P1-HIGH` — Riesgo de Archival Prematuro en `claim-escrow` (`Instance` y `EscrowedBalance` TTL vs `Claim` TTL) y Bloqueo de `refund_expired` en `stellar-core` (`isSimulationRestore`)

- **Severidad:** `P1-HIGH`
- **Ubicación exacta:**
  - [contracts/claim-escrow/src/lib.rs:9-17](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L9-L17) (constantes TTL)
  - [contracts/claim-escrow/src/lib.rs:76-82](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L76-L82) (`compute_claim_ttl_ledgers`)
  - [contracts/claim-escrow/src/lib.rs:106-140](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L106-L140) (`extend_ttl` de `EscrowedBalance` e `instance()`)
  - [packages/stellar-core/src/ledger/client.ts:544-549](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/ledger/client.ts#L544-L549) (`isSimulationRestore` lanza `NonRetryableSorobanError`)
  - [packages/stellar-core/src/dev-lab/index.ts:475-479](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/dev-lab/index.ts#L475-L479) (`isSimulationRestore` lanza `NonRetryableDevLabError`)

#### Traza Técnica Paso a Paso
1. **Inversión de TTL entre `Instance` y `DataKey::Claim`:**
   - En [lib.rs:15-17](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L15-L17):
     - `INSTANCE_TTL_THRESHOLD = 28_800 * 7 = 201_600` ledgers (~11.6 días a 5s/ledger, o 7 días a 3s/ledger).
     - `INSTANCE_TTL_EXTEND_TO = 28_800 * 30 = 864_000` ledgers (~50 días a 5s/ledger, o 30 días a 3s/ledger).
     - `MAX_CLAIM_DURATION_SECS = 30 * 86_400` (30 días).
   - Cuando se crea un claim con duración de 30 días (`2_592_000` s), `compute_claim_ttl_ledgers` ([lib.rs:76-82](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L76-L82)) calcula:
     `duration_ledgers = 2_592_000 / 3 = 864_000` + `CLAIM_TTL_BUFFER_LEDGERS (403_200)` = **`1_267_200` ledgers** (44 días conservadores).
   - Mientras que `DataKey::Claim(claim_id)` recibe un TTL de **`1_267_200` ledgers**, la instancia del contrato (`env.storage().instance()`) en [lib.rs:381-383](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L381-L383) solo se extiende a **`864_000` ledgers** (y únicamente si su TTL actual cayó por debajo de `201_600` ledgers).
   - Si el contrato tenía un TTL de instancia de `864_000` ledgers (30 días a 3s/ledger) cuando se creó el claim de 30 días, en el momento exacto en que `now > expires_at` (día 30) y `refund_expired` pasa a ser invocable, **el TTL de la instancia del contrato llega a 0 y la instancia del contrato se archiva** antes de que el remitente pueda llamar a `refund_expired`.
2. **Inversión de TTL entre `DataKey::EscrowedBalance(token)` y `DataKey::Claim`:**
   - En [lib.rs:114-116](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L114-L116), `increase_escrowed_balance` llama a:
     `env.storage().persistent().extend_ttl(&key, CLAIM_TTL_MAX_LEDGERS / 2, CLAIM_TTL_MAX_LEDGERS)` donde `threshold = 30 días (864_000)` y `extend_to = 60 días (1_728_000)`.
   - En Soroban (`env.storage().persistent().extend_ttl(key, threshold, extend_to)`), el host **no hace nada (no-op)** si el TTL actual de `key` es estrictamente mayor que `threshold`.
   - Si `EscrowedBalance(USDC)` tiene un TTL restante de `865_000` ledgers (30.03 días a 3s/ledger, justo por encima del threshold de `864_000`) y un usuario crea un nuevo `create_claim` con duración de 30 días (que requiere `1_267_200` ledgers de vida), `extend_ttl` en `increase_escrowed_balance` **es un no-op** porque `865_000 > 864_000`.
   - Como consecuencia, `EscrowedBalance(USDC)` expira y se archiva a los `865_000` ledgers, mientras el `DataKey::Claim` sigue vivo; cuando el usuario intenta hacer `claim` o `refund_expired` en el ledger `866_000`, `decrease_escrowed_balance` intenta leer la entrada archivada `EscrowedBalance(USDC)` y la transacción falla hasta que se restaure del archivo.
3. **La PWA y `stellar-core` no implementan auto-restore y abortan permanentemente:**
   - En [packages/stellar-core/src/ledger/client.ts:545-549](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/ledger/client.ts#L545-L549):
     ```typescript
     if (rpc.Api.isSimulationRestore(sim)) {
       throw new NonRetryableSorobanError(
         "Soroban archived state restore required before submission",
       );
     }
     ```
   - Si cualquiera de las entradas (`Instance`, `EscrowedBalance(token)`, `DataKey::Claim`, o la entrada `Balance` del contrato en el SAC del token) requiere restauración, `claimFromEscrow`, `cancelClaimEscrow` y `refundExpiredClaimEscrow` **lanzan `NonRetryableSorobanError`** sin construir ni enviar la operación `Operation.restoreFootprint({})`, dejando al usuario sin forma de recuperar sus fondos desde la app.

#### Por qué no lo detiene la validación actual
- Los 14 cargo tests en `contracts/claim-escrow/src/lib.rs` avanzan `li.timestamp` pero no avanzan `li.sequence_number` más allá de `INSTANCE_TTL_EXTEND_TO` (`864_000` ledgers) para verificar la supervivencia de la instancia y de `EscrowedBalance` frente a `DataKey::Claim`.

#### Corrección Mínima Quirúrgica
1. En `contracts/claim-escrow/src/lib.rs`:
   - Elevar `INSTANCE_TTL_THRESHOLD` a `CLAIM_TTL_MAX_LEDGERS / 2` (`864_000`) e `INSTANCE_TTL_EXTEND_TO` a `CLAIM_TTL_MAX_LEDGERS` (`1_728_000`, 60 días conservadores / ~100 días a 5s/ledger) para que la instancia siempre viva al menos tanto como el claim más largo más su buffer.
   - En `increase_escrowed_balance` y `decrease_escrowed_balance`, usar `threshold = CLAIM_TTL_MAX_LEDGERS - DAY_IN_LEDGERS_CONSERVATIVE` (o pasar `ttl_ledgers` del claim y asegurar `threshold >= ttl_ledgers`) para que `EscrowedBalance(token)` jamás tenga un TTL menor que un claim recién creado.
2. En `packages/stellar-core/src/ledger/client.ts:545`, cuando `rpc.Api.isSimulationRestore(sim)` sea `true`, ejecutar automáticamente una transacción `Operation.restoreFootprint({})` con `sim.restorePreamble` antes de re-simular y enviar la operación principal.

#### Test de Regresión Exacto (Cargo)
```rust
// contracts/claim-escrow/src/lib.rs (#[cfg(test)] mod test)
#[test]
fn test_instance_and_escrowed_balance_ttl_always_outlive_max_duration_claim() {
    let env = Env::default();
    env.mock_all_auths();
    env.ledger().with_mut(|li| {
        li.timestamp = 1_000;
        li.sequence_number = 100;
        li.min_persistent_entry_ttl = 100;
    });
    let expected_claim_ttl = compute_claim_ttl_ledgers(1_000, 1_000 + MAX_CLAIM_DURATION_SECS);
    assert!(
        INSTANCE_TTL_EXTEND_TO >= expected_claim_ttl,
        "INSTANCE_TTL_EXTEND_TO ({}) must be >= max claim TTL ({})",
        INSTANCE_TTL_EXTEND_TO,
        expected_claim_ttl
    );
}
```

---

### [HALLAZGO-07] `P0-MAINNET-BLOCKER` — Auditoría Smart Account (`C...`): Trampa de Bloqueo de Fondos al Activar `SMART_ACCOUNT_WASM_HASH`, Bypass de Vinculación de Contratos Arbitrarios y Desincronización de `credentialIdB64`

- **Severidad:** `P0-MAINNET-BLOCKER` (si se activa Smart Account en Mainnet en su estado actual)
- **Ubicación exacta:**
  - [apps/pwa/src/state/wallet-context.tsx:660-715](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L660-L715) (`toLinkedAccounts` fuerza `kind: "classic"` en todas las cuentas activas)
  - [apps/pwa/src/state/wallet-context.tsx:2773-2783,3000-3015](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L3000-L3015) (vinculación automática de `C...` contrafactual sin `credentialIdB64` y sin despliegue)
  - [packages/stellar-core/src/smart-account/index.ts:112-135,201-236](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/smart-account/index.ts#L112-L135) (`buildDeploySmartAccountOperation` y `buildUpdateContextRuleOperation` nunca cableados en la PWA)
  - [apps/server/src/routes/connect-verifier.ts:87-131](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect-verifier.ts#L87-L131) (bypass cuando `smartAccountWasmHash` es `undefined`)
  - [apps/server/src/routes/relay.ts:47,274-280,335](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L335) y [packages/security-shield/src/rules.ts:130-142](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/rules.ts#L130-L142) (bloqueo total de despliegue, administración y uso de cuentas `C...`)
  - [apps/server/src/routes/connect.ts:535-540](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect.ts#L535-L540) (`sign_auth_entry` rechaza direcciones `C...`)

#### Traza Técnica Paso a Paso
1. **Trampa de bloqueo irreversible de fondos (Counterfactual Fund-Locking Trap):**
   - Al activar `VITE_SMART_ACCOUNT_WASM_HASH` y `SMART_ACCOUNT_WASM_HASH`, `signConnectChallenge` ([wallet-context.tsx:3000-3015](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L3000-L3015)) deriva la dirección contrafactual CAP-46 `C...` (`deriveCounterfactualSmartAccount`) y la vincula en D1 (`linked_addresses` con `kind = 'smart'`, e incluso permite marcarla como `isDefault = true` si `preferredDefaultAddress === smart.contractAddress`).
   - El directorio público `/v1/identity/resolve` ([identity.ts:86,118](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/identity.ts#L86)) expone esa dirección `C...` (incluso como `primaryAddress`), y `buildAndSubmitPayment` ([client.ts:1102-1115](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/ledger/client.ts#L1102-L1115)) permite que otros usuarios envíen XLM o tokens SAC a cualquier dirección `C...` mediante `buildSacTransferOperation` (`transfer(from, to: C..., amount)`).
   - En Soroban, el Stellar Asset Contract (SAC) **permite transferir tokens a una dirección `C...` contrafactual aunque el contrato aún no esté desplegado en el ledger**.
   - Sin embargo, al inspeccionar todo el monorepo:
     - `buildDeploySmartAccountOperation` ([smart-account/index.ts:112](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/smart-account/index.ts#L112)) **no se llama en ningún archivo de `apps/pwa` ni de `packages/stellar-core/src/ledger/client.ts`** (solo existe en `smart-account/index.test.ts`). La PWA no tiene función ni botón para desplegar el contrato Smart Account on-chain.
     - `toLinkedAccounts` ([wallet-context.tsx:660-715](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L660-L715)) construye todas las cuentas locales del vault exclusivamente con `kind: "classic"` y `address: ClassicAddress`. La PWA tampoco puede seleccionar la cuenta `C...` como emisora ni construir `SorobanCredentials::Address` para que el contrato `C...` autorice envíos salientes via `__check_auth`.
   - **Impacto directo:** Cualquier fondo enviado a la dirección `C...` vinculada de un usuario queda **atrapado sin flujo de despliegue ni retiro en la PWA**.
2. **Incompatibilidad cruzada entre Smart Account, Scan & Shield, Relayer y AstroConnect:**
   - **Despliegue bloqueado por el Relayer:** `buildDeploySmartAccountOperation` genera un `HostFunction` de tipo `hostFunctionTypeCreateContractV2` (que no tiene `contractId`). En [relay.ts:335](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L335) (`soroban` mode) se exige `hostFn.type === "hostFunctionTypeInvokeContract"`, y en [relay.ts:276](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L276) (`feebump` mode) [decoder.ts:142](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L142) devuelve `contractId: undefined`, por lo que `!op.soroban.contractId` rechaza el despliegue con `403`.
   - **Administración de reglas bloqueada por Scan & Shield:** `buildUpdateContextRuleOperation` ([smart-account/index.ts:201](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/smart-account/index.ts#L201)) invoca la función `"update_context_rule"`. Pero en [packages/security-shield/src/rules.ts:130-142](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/rules.ts#L130-L142), `DANGEROUS_SOROBAN_FUNCTIONS` incluye `"update_context_rule"`, `"add_context_rule"`, `"add_signer"` y `"remove_signer"` con `severity: "malicious", blocksSigning: true`. Tanto `signRawXdrWithShield` en la PWA como `/v1/relay/submit` bloquean permanentemente cualquier operación de configuración de la Smart Account.
   - **Autenticación y llamadas bloqueadas por `RELAY_ALLOWED_CONTRACTS` y `ClassicAddressSchema`:** Cada usuario tiene una dirección `C...` contrafactual distinta, que por definición no está en la lista estática `RELAY_ALLOWED_CONTRACTS`, y `WalletAuthSchema.address` ([relay.ts:47](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L47)) junto con `/v1/connect/requests/:id/complete` (`sign_auth_entry`, [connect.ts:535](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect.ts#L535)) exigen `ClassicAddressSchema` (`G...`).
3. **Bypass de vinculación de contratos arbitrarios en `connect-verifier.ts` cuando `SMART_ACCOUNT_WASM_HASH` no está configurado en el servidor:**
   - En [apps/server/src/routes/connect-verifier.ts:109-123](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/connect-verifier.ts#L109-L123):
     ```typescript
     if (input.config.smartAccountWasmHash) {
       const expectedContract = await deriveCounterfactualContractAddress(...);
       if (expectedContract !== acc.address) { return { ok: false, status: 403, ... }; }
     }
     ```
   - En [wrangler.toml](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml) (`default`, `testnet`, `mainnet`), `SMART_ACCOUNT_WASM_HASH` **no está definido** (`input.config.smartAccountWasmHash === undefined`).
   - Como el `if (input.config.smartAccountWasmHash)` falla de forma abierta (*fail-open*), **cualquier usuario puede enviar un payload `kind: "smart"` a `POST /v1/intents/:id/connect` con la dirección `C...` de CUALQUIER contrato existente en Stellar** (por ejemplo, el contrato `ClaimEscrow`, un pool de Soroswap, o el SAC de USDC) firmando `${challengeMessage}:smart:${arbitraryContractId}` con su llave `G...`.
   - El servidor acepta la vinculación y registra en `linked_addresses` (tabla con `UNIQUE INDEX idx_linked_addresses_address ON linked_addresses(address)`) que ese contrato del ecosistema pertenece al usuario de Telegram atacante, contaminando `/v1/identity/resolve?q=<contractId>` y `ChainWatcherDO`.
4. **Desincronización de `credentialIdB64` entre WebAuthn Passkey y derivación contrafactual:**
   - `deriveCounterfactualSmartAccount` ([smart-account/index.ts:76](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/smart-account/index.ts#L76)) y `deriveCounterfactualContractAddress` ([decoder.ts:439](file:///Users/munay/dev/ASTRO/astrowallet/packages/security-shield/src/decoder.ts#L439)) incluyen `input.credentialIdB64 ?? "default"` en la semilla del salt SHA-256.
   - `enrollFingerprintUnlock` ([webauthn-fingerprint.ts:162](file:///Users/munay/dev/ASTRO/astrowallet/packages/stellar-core/src/vault/webauthn-fingerprint.ts#L162)) guarda `credentialIdB64` en IndexedDB (`loadBiometricRecord`), pero `wallet-context.tsx` ([líneas 2775 y 3001](file:///Users/munay/dev/ASTRO/astrowallet/apps/pwa/src/state/wallet-context.tsx#L3001)) **nunca pasa `credentialIdB64`**, derivando siempre con `"default"`. Si cualquier componente o verificador pasa el `credentialIdB64` real del passkey WebAuthn del usuario, obtiene una dirección `C...` completamente distinta.

#### Por qué no lo detiene la validación actual
- `connect-verifier.ts:109` fue escrito como `if (input.config.smartAccountWasmHash)` (*fail-open*) en lugar de rechazar submissions con `kind === "smart"` cuando `smartAccountWasmHash` no está configurado (*fail-closed*).
- Los helpers de `packages/stellar-core/src/smart-account/index.ts` fueron probados aisladamente en `smart-account/index.test.ts`, pero nunca se integraron en un flujo extremo a extremo de despliegue + firma `__check_auth` en `client.ts` / `wallet-context.tsx`.

#### Corrección Mínima Quirúrgica
1. **Fail-Closed inmediato en `connect-verifier.ts:88-123`:** Si un cliente envía una cuenta con `acc.kind === "smart"` y `!input.config.smartAccountWasmHash`, rechazar con `403 Forbidden: "Smart Account linking is disabled until SMART_ACCOUNT_WASM_HASH is configured"` en lugar de omitir la verificación contrafactual.
2. **No activar `VITE_SMART_ACCOUNT_WASM_HASH` / `SMART_ACCOUNT_WASM_HASH` en Mainnet** hasta que:
   - Exista el método de despliegue on-chain (`deploySmartAccount`) y retiro/transferencia autenticada por Guardian/Passkey (`__check_auth`) en `packages/stellar-core/src/ledger/client.ts` y `wallet-context.tsx`.
   - `signConnectChallenge` verifique en Soroban RPC (`getContractData` / `getLedgerEntries`) que el contrato `C...` ya está desplegado on-chain antes de permitir vincularlo como dirección receptora en `linked_addresses`.

#### Test de Regresión Exacto (Vitest)
```typescript
// apps/server/src/audit-regression.test.ts
it("rejects linking an arbitrary C... contract as a smart account when SMART_ACCOUNT_WASM_HASH is not configured", async () => {
  const guardianKp = Keypair.random();
  const arbitraryContractId = "CCWVGVBSHAFS73HCDRJ5MEFJPYKKG4WQFJ2LJPNIO2PU3U4X6PTDA4TA"; // ClaimEscrow contract
  const challengeMessage = "astrowallet-connect:v1:testnet:999:ch_1:1700000000:1700000600";

  const classicSig = signChallengeMessage(guardianKp, challengeMessage);
  const smartSig = signChallengeMessage(
    guardianKp,
    `${challengeMessage}:smart:${arbitraryContractId}`,
  );

  const res = await verifyConnectAccountSubmissions({
    config: { ...testConfig, smartAccountWasmHash: undefined },
    repo,
    telegramUserId: "999",
    challengeMessage,
    accounts: [
      { address: guardianKp.publicKey(), kind: "classic", label: "Guardian", signatureBase64: classicSig },
      {
        address: arbitraryContractId,
        kind: "smart",
        label: "Hijacked Contract",
        guardianAddress: guardianKp.publicKey(),
        signatureBase64: smartSig,
      },
    ],
  });
  expect(res.ok).toBe(false);
  if (!res.ok) {
    expect(res.status).toBe(403);
  }
});
```

---

### [HALLAZGO-08] `P2-MEDIUM` — `[env.mainnet]` en `wrangler.toml`: `RELAY_ALLOWED_CONTRACTS` y `CLAIM_ESCROW_CONTRACT_ID` Comentados Dejan `/v1/relay/submit` y Claim Links en `503` tras Despliegue

- **Severidad:** `P2-MEDIUM`
- **Ubicación exacta:**
  - [apps/server/wrangler.toml:166-168](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml#L166-L168) (`# CLAIM_ESCROW_CONTRACT_ID` y `# RELAY_ALLOWED_CONTRACTS` comentados en `[env.mainnet.vars]`)
  - [apps/server/src/routes/relay.ts:90-95](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/relay.ts#L90-L95) (`config.relayAllowedContracts.length === 0` devuelve `503`)
  - [apps/server/src/routes/intents.ts:633-638](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/src/routes/intents.ts#L633-L638) (`!escrowParsed.success` devuelve `503`)

#### Traza Técnica Paso a Paso
1. En [apps/server/wrangler.toml:166-168](file:///Users/munay/dev/ASTRO/astrowallet/apps/server/wrangler.toml#L166-L168), dentro de `[env.mainnet.vars]`:
   ```toml
   # Set CLAIM_ESCROW_CONTRACT_ID & RELAY_ALLOWED_CONTRACTS after Mainnet Gate 1/3 contract deployment:
   # CLAIM_ESCROW_CONTRACT_ID = "C..."
   # RELAY_ALLOWED_CONTRACTS = "C...,CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA,..."
   ```
2. Al estar comentados, `parseServerConfig` parsea `RELAY_ALLOWED_CONTRACTS` como `[]` y `CLAIM_ESCROW_CONTRACT_ID` como `undefined`.
3. Aunque el comportamiento es *fail-closed* (devuelve `503 Service Unavailable` en `/v1/relay/submit` y en `/v1/intents/:id/confirm` para `claim`), cualquier despliegue a `[env.mainnet]` sin haber desplegado e inyectado previamente el contrato `claim-escrow` (con `__constructor(Some(guardian_multisig))`) y los SACs canónicos de Mainnet (`XLM`, `USDC`, `EURC`, `USDT0`, `USDE`, `SUSDE`) dejará inoperativos los flujos de Claim Links y Relay en Mainnet.

#### Corrección Mínima Quirúrgica
- Antes del cutover a Mainnet, desplegar `contracts/claim-escrow` en Stellar Mainnet pasando `Some(guardian_address)` al `__constructor` ([lib.rs:149](file:///Users/munay/dev/ASTRO/astrowallet/contracts/claim-escrow/src/lib.rs#L149)), y poblar en `[env.mainnet.vars]` tanto `CLAIM_ESCROW_CONTRACT_ID` como `RELAY_ALLOWED_CONTRACTS` (incluyendo el contrato `claim-escrow` y los SAC de Mainnet) y `RELAY_CHANNEL_ACCOUNTS`.

---

## C) Veredicto Final del Bloque 1 (+ Smart Account)

### **VEREDICTO: `NO-GO` (Para Mainnet y para Activación de Smart Account hasta aplicar las correcciones P0/P1)**

#### Condiciones Obligatorias de Desbloqueo (`NO-GO` $\rightarrow$ `GO`):
1. **`[P0]` Cerrar `/v1/relay/bootstrap` ([HALLAZGO-01]):**
   - Incluir `body.mode` en el mensaje firmado SEP-53 `challengeMsg` y deshabilitar `mode: "direct"` en Mainnet para impedir el drenaje directo de 1.5 XLM líquidos por cuenta (37.5 XLM/día).
   - Serializar la lectura/incremento de `sponsorSequence` y permitir re-firmar `sponsorSignedXdr` si una llamada previa a `sponsored_reserve` expiró (>180s) y la cuenta sigue `404` (no financiada) en Horizon, eliminando el bloqueo permanente (`409`) de usuarios/direcciones.
2. **`[P0]` Blindar `/v1/relay/submit` ([HALLAZGO-02] y [HALLAZGO-03]):**
   - En modo `soroban`, incluir `authEntriesXdrBase64` en `expectedPayloadHash` de `walletAuth`, rechazar `HashIdPreimage` sin firma y verificar `RELAY_ALLOWED_CONTRACTS` sobre todas las entradas `auth` y `subInvocations`.
   - En modo `feebump`, exigir `decoded.sourceAccount === body.walletAuth.address` y rechazar operaciones fuera de `RELAY_ALLOWED_CONTRACTS` (`!op.soroban`) para todos los modos de autenticación.
   - Hacer fallback a `walletAuth` cuando `intentAuth` ya fue consumido (`409`) y ligar `intentAuth` de tipo `claim` estrictamente a `deriveClaimId(intent.intentId)` y a la función válida según el estado del intent.
3. **`[P0]` Bloquear Activación Prematura de Smart Account `C...` ([HALLAZGO-07]):**
   - Hacer *fail-closed* en `connect-verifier.ts:109` (rechazar `kind: "smart"` con `403` si `SMART_ACCOUNT_WASM_HASH` no está configurado, impidiendo el secuestro de contratos arbitrarios en `linked_addresses`).
   - Mantener `VITE_SMART_ACCOUNT_WASM_HASH` y `SMART_ACCOUNT_WASM_HASH` desactivados en Mainnet hasta cablear el despliegue CAP-46 (`buildDeploySmartAccountOperation`) y la firma `__check_auth` en la PWA y el relayer, evitando que los usuarios reciban fondos SAC en direcciones `C...` contrafactuales sin vía de retiro.
4. **`[P1]` Alinear Contabilidad de Fees, `ChannelPoolDO` y TTL de `claim-escrow` ([HALLAZGO-04], [HALLAZGO-05], [HALLAZGO-06]):**
   - Contabilizar `sorobanData.resourceFee` + piso de operaciones en `feebump`, evitar reintentos `tx_bad_seq` en `feebump`, elevar `INSTANCE_TTL_EXTEND_TO` / threshold de `EscrowedBalance` en `claim-escrow` por encima de `compute_claim_ttl_ledgers(30d)` (`1_267_200` ledgers) y manejar `isSimulationRestore` en `stellar-core`.
