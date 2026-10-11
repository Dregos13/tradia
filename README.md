# Tradia

App de escritorio (macOS, Windows, Linux) para trading con agentes: vigilancia
permanente del mercado, señales y paper trading. Construida con Electron +
TypeScript + React sobre electron-vite.

> Estado: fases 6-7. El motor evalúa estrategias al cierre de cada vela y
> ejecuta las señales aprobadas en una cuenta paper de Alpaca; la capa de IA
> clasifica el régimen de mercado, sirve un modelo ONNX con probabilidades
> calibradas, resume las noticias confirmadas y vigila la degradación de los
> modelos. El modo real existe pero arranca bloqueado: solo se activa tras
> cumplir la lista de comprobación y opera con techos fijos mínimos
> (`docs/dinero-real.md`).

## Requisitos

- Node.js >= 20.19 (recomendado: 24 LTS)
- npm >= 10

## Instalación

```bash
npm install
```

## Scripts

| Script                         | Qué hace                                                   |
| ------------------------------ | ---------------------------------------------------------- |
| `npm run dev`                  | Arranca electron-vite en modo desarrollo y abre la ventana |
| `npm run build`                | Typecheck + build de main, preload y renderer a `out/`     |
| `npm start`                    | Previsualiza la build (`electron-vite preview`)            |
| `npm run lint`                 | ESLint sobre todo el proyecto                              |
| `npm run typecheck`            | `tsc --noEmit`                                             |
| `npm test`                     | Pruebas unitarias con Vitest                               |
| `npm run test:e2e`             | Construye la app y ejecuta pruebas Electron con Playwright |
| `npm run format`               | Formatea con Prettier                                      |
| `npm run format:check`         | Comprueba el formato sin escribir                          |
| `npm run qa:alpaca-paper`      | Verificación manual contra una cuenta paper de Alpaca      |
| `npm run qa:alpaca-live-smoke` | Prueba de humo manual con importe mínimo en cuenta real    |
| `npm run eval:news-llm`        | Evalúa el LLM de noticias sobre el conjunto etiquetado     |
| `npm run dist`                 | Empaqueta el instalador del sistema actual a `release/`    |
| `npm run dist:mac`             | Empaqueta los dmg de macOS (x64 y arm64)                   |
| `npm run dist:win`             | Empaqueta el instalador nsis de Windows                    |
| `npm run dist:linux`           | Empaqueta AppImage y deb de Linux                          |

## Estructura

```
src/
  main/                 Proceso principal de Electron
    index.ts            Entrada: instancia única, ciclo de vida, hardening
    window.ts           Creación de la BrowserWindow
    security.ts         webPreferences de seguridad (contextIsolation, sandbox…)
    broadcast.ts        Envío de eventos a todas las ventanas
    resources.ts        resourcePath(): recursos fuera del asar
    services/           Servicios base (storage, secrets, settings,
                        notifications, tray, scheduler, connectivity,
                        logger) e initServices() en index.ts
    db/                 Apertura de SQLite y migraciones versionadas
    market/             Ingesta de velas, calendario NYSE, limpieza,
                        salud del dato y series macro
    news/               Fuentes, lector (poller), calendario y alertas
    strategies/         Biblioteca de estrategias versionadas
    backtest/           Motor, estrategias clásicas, estrés e informes
    risk/               Kill switch y pasarela única de riesgo
    signals/            Motor de señales al cierre de vela + paper
    journal/            Diario automático y exportación CSV
    delivery/           Canales de aviso (escritorio, Telegram, correo)
    routine/            Rutina diaria: preapertura, cierre, conciliación
    backup/             Copias de seguridad y restauración
    broker/             Broker paper (Alpaca paper / simulado E2E),
                        órdenes, conciliación e informe de desviación
    ai/                 Fase 6: regime/, prediction/ (ONNX), news/ (LLM)
                        y drift/ (salud y reentrenamiento)
    live/               Fase 7: lista de comprobación, broker real con
                        techos, prueba de humo y estado del escalado
  preload/
    index.ts            contextBridge: expone solo window.tradia
  renderer/             UI en React (src/renderer/index.html + src/)
    src/env.d.ts        Tipado global de window.tradia para el renderer
  shared/
    ipc.ts              Contrato IPC tipado: canales, tipos de dominio,
                        TradiaApi y guardas de validación
    ai.ts               Tipos y umbrales de la capa de IA (fase 6)
    live.ts             Tipos y techos fijos del modo real (fase 7)
e2e/                    Pruebas Playwright sobre la app compilada
ml/                     Pipeline de entrenamiento externo (Python) que
                        exporta el modelo ONNX y su ficha
resources/              Recursos en runtime (extraResources): icon.png,
                        tray/ y models/ (modelo ONNX servido por la app)
build/                  Iconos del empaquetado (icon.svg fuente, png/icns/ico)
```

## Empaquetado e instaladores

El empaquetado usa **electron-builder** (`electron-builder.yml`):

- `appId` `com.tradia.app`, `productName` `Tradia`, salida en `release/`.
- macOS: `dmg` para x64 y arm64 (icono `build/icon.icns`).
- Windows: `nsis` con asistente de instalación (icono `build/icon.ico`).
- Linux: `AppImage` y `deb` (icono `build/icon.png`).
- `resources/` se copia como `extraResources` a `process.resourcesPath/resources`;
  en código se accede con `resourcePath()` de `src/main/resources.ts`
  (la bandeja usa `resources/tray/tray-{estado}[-Template][@2x].png`).
- `better-sqlite3` usa sus binarios precompilados N-API (`prebuilds/`), que
  Electron carga directamente sin recompilar (`npmRebuild: false`); sus `.node`
  se desempaquetan del asar (`asarUnpack`). No hay rebuild con node-gyp, que
  además falla en rutas con espacios (nodejs/node-gyp#65).

Para generar el instalador del sistema en local:

```bash
npm install        # no hay rebuild nativo: better-sqlite3 usa sus prebuilds
npm run dist       # o dist:mac / dist:win / dist:linux
```

Los instaladores salen **sin firmar**: macOS pedirá confirmar la apertura por
Gatekeeper y Windows mostrará el aviso de SmartScreen. En local, si hay un
certificado de desarrollador instalado y no se quiere firmar, exportar
`CSC_IDENTITY_AUTO_DISCOVERY=false`. La firma y notarización reales quedan
fuera de esta fase.

### CI

`.github/workflows/ci.yml` compila, pasa lint y pruebas y genera los
instaladores en `macos-latest`, `windows-latest` y `ubuntu-latest`, con
`CSC_IDENTITY_AUTO_DISCOVERY=false` (sin firma). Los artefactos se suben como
`tradia-<os>` con `actions/upload-artifact` y usan caché de npm. En Linux,
Playwright ejecuta las pruebas Electron bajo `xvfb-run`.

### Pruebas E2E

`npm run test:e2e` crea la build y ejecuta `e2e/electron.spec.ts` mediante el
controlador `_electron` de Playwright. Cada caso usa y elimina un `userData`
temporal; comprueba el aviso inicial y su persistencia, notificaciones y
preferencias, latido en segundo plano y pausa, recuperación de la simulación
offline, ausencia de claves legibles y las protecciones del renderer.

Los ganchos de prueba (`TRADIA_E2E`, `TRADIA_E2E_USER_DATA`, la flag
`--tradia-e2e` que el proceso principal pasa al preload y el latido acortado
de 250 ms) solo se activan cuando `isE2eEnabled` confirma que la app **no está
empaquetada**: una variable de entorno no cambia nada en producción.

## Seguridad

- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`
  (ver `src/main/security.ts`, cubierto por pruebas).
- CSP estricta en `src/renderer/index.html` (sin `unsafe-eval`; scripts solo `'self'`).
- Instancia única con `requestSingleInstanceLock`.
- `window.open` denegado y navegación bloqueada fuera de la app.
- El renderer solo ve `window.tradia`; las claves de API no tienen canal de
  lectura (`secrets.setKey/hasKey/deleteKey` únicamente) y se guardarán
  cifradas con `safeStorage`, nunca en texto plano.

## Contrato IPC

Todos los canales están tipados en `src/shared/ipc.ts`:

- `connectivity`: `get-state`, `check-now`, evento `changed`.
- `notifications`: `send`, `test`, `get-prefs`, `set-prefs`.
- `settings`: `get`, `set` (autostart y aceptación del aviso).
- `secrets`: `set-key`, `has-key`, `delete-key` (sin `get` desde el renderer).
- `agents`: `pause`, `resume`, `get-state`, eventos `changed` y `heartbeat`.
- `watchlist`: `list`, `add`, `remove`, `add-universe`.
- `market`: `get-bars`, `refresh-now`, evento `updated` y el canal de
  desarrollo `advance-clock` (solo sin empaquetar).
- `macro`: `get-series`.
- `data-status`: `get`, evento `changed` y el canal de desarrollo
  `simulate-provider-failure` (solo `TRADIA_E2E` y sin empaquetar).
- `news`, `sources`, `calendar`, `alerts`: feed de noticias, fuentes,
  calendario económico y avisos.
- `strategies`, `backtest`: biblioteca versionada, ejecuciones, informes
  y comparación con/sin filtro de régimen.
- `risk`, `kill-switch`: límites, vetos, cautela y parada de emergencia.
- `signals`: emisión al cierre de vela y `evaluate-now` (E2E).
- `journal`, `delivery`, `routine`, `backup`, `logs`: diario, canales de
  aviso, rutina diaria, copias y registros.
- `broker`, `orders`, `reconcile`, `deviation`: cuenta paper, órdenes,
  conciliación e informe real vs backtest.
- `providers`: `test-connection` («Probar conexión» de Tiingo y FRED en
  Ajustes) y el gancho de desarrollo `simulate-test` (solo `TRADIA_E2E` y
  sin empaquetar).
- `ai`: `regime-overview`, `predictions`, `model-card`, `news-analysis`,
  ajustes del LLM (`get/set/test-llm`), `health`, `retrain-proposals`,
  `resolve-retrain` y evento `changed` (ver `docs/ia.md`).
- `live`: `checklist`, `state`, `declare`, `set-limits`, `connect`,
  `activate`, `deactivate`, `test-kill-switch`, `smoke-test`, `scaling`
  y evento `changed` (ver `docs/dinero-real.md`).
- `testing` (solo `TRADIA_E2E` sin empaquetar): ganchos de simulación —
  `ai:simulate-regime`, `ai:simulate-drift`, `broker:seed-weeks`,
  `live:seed-progress`, `live:use-simulated-broker`, entre otros.

### Datos de mercado

El servicio de mercado (`src/main/market/ingestion.ts`) descarga 5 años de
velas diarias OHLCV al añadir un ticker a la lista de seguimiento (máx. 25)
y luego actualiza de forma incremental desde la última vela guardada. Cada
lote pasa por la limpieza (`src/main/market/cleaning/`: deduplicado, huecos,
valores anómalos y ajuste hacia atrás por splits y dividendos) y se guarda
versionado en SQLite (`data_batches`, `bars`, `corporate_actions`,
`quality_flags`), con la salud del dato en `data_status`.

**Proveedor**: se usa Tiingo (EOD diario; cuota ~50 símbolos/hora y 1000
peticiones/día, respetada por el limitador local) cuando hay una clave
guardada en Ajustes → Proveedores de datos (`secrets.setKey('tiingo', …)`;
la clave viaja en la cabecera `Authorization`, nunca en la URL ni en los
logs). Sin clave no hay proveedor y la app muestra el estado vacío —
nunca se sirven velas ni series simuladas como si fueran reales. Con
`TRADIA_E2E=1` y **sin empaquetar** se usa un adaptador simulado
determinista rotulado «Datos simulados».

**Probar conexión** (`src/main/providers/`): el botón de Ajustes hace una
petición mínima real con la clave guardada —la última cotización de SPY en
Tiingo y la observación más reciente de VIXCLS en FRED— y clasifica el
resultado en `ok` (con la fecha del último dato), `sin-clave`,
`clave-rechazada`, `cuota`, `sin-red` o `error`, con el motivo legible y
la latencia; la clave nunca aparece en el resultado ni en los logs. Cada
prueba actualiza `provider:<id>` en `data_status` (`ok` → `fiable`,
`sin-clave` → sin estado, `clave-rechazada` → `no-fiable`, el resto
acumula fallos como una pasada de ingesta). Desde la terminal:
`TIINGO_API_KEY=… FRED_API_KEY=… npm run qa:providers` ejecuta la misma
comprobación y muestra estado, fecha y latencia sin imprimir la clave
(sin variables termina con el mensaje de uso y código distinto de 0). En
modo E2E el sondeo usa los proveedores simulados y el canal
`providers:simulate-test` fuerza el estado de la próxima prueba (se
consume una vez).

**Horario de la actualización diaria**: se ejecuta al cierre de NYSE más un
margen de 75 minutos (16:00 ET + 75 min ≈ 21:15 UTC, normalmente **23:15 en
Madrid**; ~22:15 en las semanas de desfase de horario entre EE. UU. y
Europa —mediados de marzo y finales de octubre—, calculado con `Intl` y las
zonas IANA en `src/main/market/calendar.ts`). Si la pasada queda incompleta
reintenta cada 30 minutos, hasta 4 veces. Al arrancar la app y al volver de
la suspensión (`powerMonitor` resume) se recuperan los cierres perdidos, y
con `connectivity` en «sin conexión» no se llama al proveedor.

**Gancho de desarrollo** (solo sin empaquetar): el canal
`market:advance-clock` adelanta el reloj interno del servicio y reevalúa el
trabajo pendiente al instante, sin esperar al horario real. En modo E2E se
expone como `window.tradia.testing.advanceMarketClock(ms)` y devuelve
`{ now }` con el nuevo instante.

**Salud del dato** (`src/main/market/health.ts`): la vigilancia evalúa cada
ticker y cada serie macro cada 15 minutos y en cada cambio de estado.
Estados: `fiable`, `actualizando` (lo escriben ingesta y macro mientras
refrescan), `desactualizado` (falta la vela de una sesión esperada pasadas
12 h desde su hora de actualización —la primera sesión que falta marca el
plazo—; en macro se pide la observación esperada según su frecuencia) y
`no-fiable` (3 fallos seguidos del proveedor o un valor anómalo grave en el
último lote; solo lo levanta un refresco con éxito). Cada estado se guarda
en `data_status` y se emite por `data-status:changed`. Al empeorar se
notifica con nivel `alerta` (desactualizado) o `critica` (no fiable),
agrupando repeticiones como máximo una vez cada 6 h; al recuperarse el dato
se envía un aviso `info`.

**Gancho de desarrollo** (solo `TRADIA_E2E` y sin empaquetar): el canal
`data-status:simulate-provider-failure` activa el fallo persistente de los
proveedores simulados de mercado y macro y fuerza una pasada, para ver las
insignias y la notificación como en un fallo real. Se expone como
`window.tradia.testing.simulateProviderFailure(failing)` y devuelve los
estados del dato resultantes.

### IA predictiva y modo real

La capa de IA (`src/main/ai/`, ver `docs/ia.md`) corre en segundo plano
sobre las velas y los titulares que ingiere la app: clasifica el régimen
de mercado por activo y de conjunto (referencia SPY), sirve el modelo
ONNX entrenado fuera de la app (artefactos de `resources/models/`,
pipeline en `ml/`), resume con LLM o léxico local los titulares
confirmados y vigila el drift de datos y resultados con propuestas de
reentrenamiento trimestral. Todo ajusta la confianza de las señales —
que siempre pasan por el motor de riesgo — y nada de ello crea órdenes.

El modo real (`src/main/live/`, ver `docs/dinero-real.md`) permanece
bloqueado hasta completar la lista de comprobación de la sección 18 del
plan (evaluada en el proceso principal) y confirmar por escrito unos
límites dentro de los techos fijos de la fase. Las claves live usan una
ranura cifrada separada y se exigen sin permiso de retirada.

### Renderer y simulación

La estructura de interfaz vive en `src/renderer/src`: `App.tsx` gestiona Inicio/Ajustes,
`hooks/useSystemState.ts` escucha el contrato IPC y `components/SystemStatus.tsx`
compone la barra de estado. `tokens.ts` traduce directamente el JSON aprobado de
`.orquesta/design/fase-0-1/tokens.json` a variables CSS con tema del sistema.

Electron usa siempre `window.tradia` del preload. Para previsualizar en un navegador
sin preload, iniciar `VITE_TRADIA_SIMULATED=true npm run dev` y abrir la URL local de
Vite. La simulación se identifica por el indicador «Comprobando conexión» y no
emite notificaciones nativas ni almacena claves. En pruebas se instala explícitamente
`createSimulatedAdapter().api` en `window.tradia`; sus métodos `emitConnectivity`,
`emitAgents` y `emitHeartbeat` permiten controlar los estados sin datos de mercado
inventados. La simulación nunca se activa en una compilación de producción.

Los controles de Ajustes, el bloqueo del aviso de riesgo y el banner de desconexión
se integran en las siguientes tareas de frontend.

### Aviso de riesgo

En una instalación limpia, la interfaz permanece bloqueada hasta aceptar el
aviso vigente (`src/shared/riskDisclaimer.ts`, texto de `docs/alcance.md` §7.4).
`settings:set` guarda la versión y una fecha ISO generada en main en una
transacción SQLite. El renderer no puede escribir la fecha. Para publicar un
texto nuevo, actualizar el documento, el texto compartido y
`RISK_DISCLAIMER_VERSION`: las versiones anteriores vuelven a pedir aceptación.
El aviso se consulta sin aceptar de nuevo en Ajustes > Legal; al volver se
restaura el foco del botón. Los errores de carga o guardado mantienen el bloqueo.

Para comprobar el primer arranque, usar una carpeta temporal con
`npm run build` seguido de
`npx electron . --user-data-dir=/ruta/temporal/tradia` o una instalación de
prueba sin datos previos. No borrar el `userData` habitual con datos personales.
