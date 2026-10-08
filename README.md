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

| Script              | Qué hace                                                           |
| ------------------- | ------------------------------------------------------------------ |
| `npm run dev`       | Arranca electron-vite en modo desarrollo y abre la ventana         |
| `npm run build`     | Typecheck + build de main, preload y renderer a `out/`             |
| `npm start`         | Previsualiza la build (`electron-vite preview`)                    |
| `npm run lint`      | ESLint sobre todo el proyecto                                      |
| `npm run typecheck` | `tsc --noEmit`                                                     |
| `npm test`          | Pruebas unitarias con Vitest                                       |
| `npm run test:e2e`  | Pruebas de extremo a extremo con Playwright (pendiente, en `e2e/`) |
| `npm run format`    | Formatea con Prettier                                              |

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
```

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
