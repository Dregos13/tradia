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

| Script               | Qué hace                                                           |
| -------------------- | ------------------------------------------------------------------ |
| `npm run dev`        | Arranca electron-vite en modo desarrollo y abre la ventana         |
| `npm run build`      | Typecheck + build de main, preload y renderer a `out/`             |
| `npm start`          | Previsualiza la build (`electron-vite preview`)                    |
| `npm run lint`       | ESLint sobre todo el proyecto                                      |
| `npm run typecheck`  | `tsc --noEmit`                                                     |
| `npm test`           | Pruebas unitarias con Vitest                                       |
| `npm run test:e2e`   | Pruebas de extremo a extremo con Playwright (pendiente, en `e2e/`) |
| `npm run format`     | Formatea con Prettier                                              |
| `npm run dist`       | Empaqueta el instalador del sistema actual a `release/`            |
| `npm run dist:mac`   | Empaqueta los dmg de macOS (x64 y arm64)                           |
| `npm run dist:win`   | Empaqueta el instalador nsis de Windows                            |
| `npm run dist:linux` | Empaqueta AppImage y deb de Linux                                  |

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
`tradia-<os>` con `actions/upload-artifact` y usan caché de npm.

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
