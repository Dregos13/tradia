# Tradia

App de escritorio (macOS, Windows, Linux) para trading con agentes: vigilancia
permanente del mercado, señales y paper trading. Construida con Electron +
TypeScript + React sobre electron-vite.

> Estado: esqueleto de la fase 0-1. El contrato IPC y los servicios del proceso
> principal están definidos; las implementaciones llegan en las tareas
> siguientes del plan (ver `.orquesta/PLAN.md`).

## Requisitos

- Node.js >= 20.19 (recomendado: 24 LTS)
- npm >= 10

## Instalación

```bash
npm install
```

## Scripts

| Script               | Qué hace                                                   |
| -------------------- | ---------------------------------------------------------- |
| `npm run dev`        | Arranca electron-vite en modo desarrollo y abre la ventana |
| `npm run build`      | Typecheck + build de main, preload y renderer a `out/`     |
| `npm start`          | Previsualiza la build (`electron-vite preview`)            |
| `npm run lint`       | ESLint sobre todo el proyecto                              |
| `npm run typecheck`  | `tsc --noEmit`                                             |
| `npm test`           | Pruebas unitarias con Vitest                               |
| `npm run test:e2e`   | Construye la app y ejecuta pruebas Electron con Playwright |
| `npm run format`     | Formatea con Prettier                                      |
| `npm run dist`       | Empaqueta el instalador del sistema actual a `release/`    |
| `npm run dist:mac`   | Empaqueta los dmg de macOS (x64 y arm64)                   |
| `npm run dist:win`   | Empaqueta el instalador nsis de Windows                    |
| `npm run dist:linux` | Empaqueta AppImage y deb de Linux                          |

## Estructura

```
src/
  main/                 Proceso principal de Electron
    index.ts            Entrada: instancia única, ciclo de vida, hardening
    window.ts           Creación de la BrowserWindow
    security.ts         webPreferences de seguridad (contextIsolation, sandbox…)
    broadcast.ts        Envío de eventos a todas las ventanas
    services/           Un servicio por archivo; cada tarea edita el suyo
      index.ts          Registro: initServices() + ServiceContext
      storage.ts        SQLite local (stub → tarea storage-db)
      secrets.ts        Claves de API cifradas con safeStorage (stub → storage-db)
      settings.ts       Ajustes: autostart y aviso de riesgo (stub → storage-db)
      notifications.ts  Notificaciones nativas por niveles (stub → notifications-service)
      tray.ts           Bandeja, segundo plano e inicio automático (stub → tray-background)
      scheduler.ts      Planificador/latido de agentes y pausa de decisiones
      connectivity.ts   Vigilancia de conexión con espera exponencial (stub → connectivity-service)
  preload/
    index.ts            contextBridge: expone solo window.tradia
  renderer/             UI en React (src/renderer/index.html + src/)
    src/env.d.ts        Tipado global de window.tradia para el renderer
  shared/
    ipc.ts              Contrato IPC tipado: canales, tipos de dominio,
                        TradiaApi y guardas de validación
e2e/                    Pruebas Playwright (tarea e2e-tests)
build/                  Iconos del empaquetado (icon.svg fuente, png/icns/ico)
resources/              Recursos en runtime (extraResources): icon.png y tray/
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
- `better-sqlite3` se reempaqueta para el Electron de destino (`npmRebuild`)
  y sus `.node` se desempaquetan del asar (`asarUnpack`).

Para generar el instalador del sistema en local:

```bash
npm install        # postinstall ya ejecuta electron-builder install-app-deps
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
logs). Sin clave no hay proveedor y la app muestra el estado vacío. Con
`TRADIA_E2E=1` y **sin empaquetar** se usa un adaptador simulado
determinista rotulado «Datos simulados».

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
