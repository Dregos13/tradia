# Estado de los puntos pendientes del objetivo

_Claude · Predeterminado (Testing) · 12-10-2026 · rama `orquesta/completa-estas-partes-sin-hacer-y-compru-7d9830` sobre `0fdc6eb8` («Notificación del sistema al arrancar sin la CLI de Claude»), con todas las correcciones de código ya en commit. Cada archivo:línea de este documento se ha comprobado con `sed -n` o `grep -n` sobre ese commit_

## Veredicto

- **Todos los puntos del objetivo están hechos.** Cada uno tiene su código y su prueba de regresión, y esas pruebas pasan en esta rama (§2).
- **Hecho también lo que antes figuraba como pendiente fuera de la lista:**
  - **API de pago retirada.** Ajustes › Análisis de noticias solo ofrece «Suscripción (Claude Code)» y «Analizador local» (`src/renderer/src/components/settings/AiSettings.tsx:171-172`). `scripts/eval-news-llm.mjs:16-17` la da por retirada y solo admite `['local', 'suscripcion']` (`:27`). Una clave antigua se borra sola al arrancar (`src/main/ai/__audit__/sin-api.audit.test.ts:184`, `:257`, `:421`).
  - **Backtest, estrés y señales de las estrategias propias.** La propia con `cruza_arriba(sma(rapida), sma(lenta))` lanza backtest y estrés desde su ficha y el informe queda en el historial (`e2e/strategies-backtest.spec.ts:28`, regla en `:147`). Da las mismas operaciones que la clásica «sma-cross» (`src/main/backtest/strategies/custom.test.ts:73`, `src/main/backtest/service.test.ts:534`).
  - **Aviso de la suscripción.** Si la suscripción falla, Noticias y Ajustes muestran el motivo y el paso (`src/shared/newsSubscription.ts:9`, `:13`) y llega una sola notificación del sistema, también al arrancar sin la CLI (fila «Notificación al arrancar sin CLI»).
- **E1 y E2 (§4) están cerrados:** `ml/README.md:21-25` usa `~/.venvs/tradia-ml`, fuera del repositorio, y `.gitignore:12-13` ignora `ml/data/*` salvo `synthetic.csv`.
- `docs/tareas-del-usuario.md` no tiene ningún paso con la API de pago y ya recoge el corto con dinero real en Alpaca, la prueba con `/logout`, `claude.cmd` en Windows y actualizar `main` y lanzar la CI.

No he tocado código de `src` ni de `e2e`.

## 1. Estado de cada punto

Origen de las etiquetas:

- H1–H5: `docs/qa/fase-6-7-auditoria.md`.
- P1–P4 y P7: `docs/qa/fase-6-7.md`.

| Punto | Estado | Evidencia en el código | Prueba que lo cubre (en verde en esta rama) |
| --- | --- | --- | --- |
| **H1** · evidencia sembrada (`live.evidence`) aceptada fuera de E2E | **Hecho** | `src/main/live/service.ts:551`: la evidencia solo se lee si `allowSeededEvidence()` devuelve `true`; si no, `{}`. `src/main/live/index.ts:142`: `allowSeededEvidence: () => e2eEnabled` | `src/main/live/__audit__/live.audit.test.ts:379` «HALLAZGO H1 · fuera de E2E, una evidencia «live.evidence» manipulada en la base no cumple los requisitos automáticos»; `:630` «una copia con live.evidence, la lista cumplida y el modo «activo», restaurada en la app empaquetada, no deja el dinero real activo» |
| **H2** · orden de mercado por encima del techo por orden | **Hecho** | `src/main/live/orderGuard.ts:155` (`LIVE_ORDER_PRICE_MARGIN = 0.05`); `:215-216` (la compra sale limitada a `min(techo/cantidad, referencia × 1,05)`); `:317-322` (la entrada en corto con el margen de hueco no puede superar el límite por orden en corto) | `live.audit.test.ts:554` «HALLAZGO H2 · una orden de mercado no puede ejecutarse por encima del techo por orden»; `:704` «con una referencia muy desfasada a la baja, la compra sale limitada…»; `:721` «HALLAZGO C4 · con el corto habilitado la entrada en corto sale como stop a la referencia…» |
| **P7** · cordura de la prueba de humo (−8.278 pb, precio ajeno) | **Hecho** | `src/main/live/smoke.ts:191` (`LIVE_SMOKE_MAX_SLIPPAGE_BPS = 300`); `:488` (límite = referencia × (1 + 300 pb)); `:575-580` (más de 300 pb da la prueba por fallida) | `src/main/live/smoke.test.ts:303` «con un cierre desfasado no se envía ninguna orden al broker»; `:587` «un slippage absurdo frente a la referencia da la prueba por fallida y suspende»; `:619` «un nocional ejecutado por encima del mínimo con margen…»; `live.audit.test.ts:756` «con el último cierre de SPY de hace semanas no envía ninguna orden real» |
| **P1** · carrera de `useLiveChecklist` que impide activar el dinero real | **Hecho** | `src/renderer/src/components/live/useLiveChecklist.ts:129-136`: `save()` aplica `setLimits(saved.limits)` (`:134`) antes de la relectura, y un `live:changed` concurrente ya no lo descarta | `src/renderer/src/components/live/ChecklistPage.test.tsx:392` «aplica saved.limits aunque live:changed llegue durante la relectura del guardado»; `:437` «conserva saved.limits si falla la lectura posterior al guardado»; `:420` «…nunca faltan 0 de 7»; E2E `e2e/live-gate.spec.ts:152` «completa la lista, confirma los límites por escrito, activa y pasa la prueba de humo» |
| **P2** · «Ver ficha del modelo» llevaba a Inicio | **Hecho** | `src/renderer/src/components/ai/PredictionsTable.tsx:40-44`: un botón que enfoca `#ai-model-card` con `scrollIntoView`, sin `href` ni cambio de hash. `ModelCard.tsx:30`: `id="ai-model-card"` | `src/renderer/src/components/ai/AiPage.test.tsx:326` «abre la ficha con teclado, desplaza y enfoca sin cambiar el hash»; E2E `e2e/ai-regime-prediction.spec.ts:206` (el botón en `:268`) |
| **P3** · predicción vigente por activo | **Hecho** | `PredictionsTable.tsx:28-37`: la última por activo según el cierre, luego la hora de cálculo y luego el id. `:193`: tabla vigente. `:195-196`: «Histórico de predicciones (n)» plegado en `<details>` | `AiPage.test.tsx:345` «elige el último cierre por activo aunque el histórico llegue desordenado y se calcule después»; E2E `ai-regime-prediction.spec.ts:206` ««Predicción por activo» destaca la vigente de cada activo…» |
| **H3** · racha aislada a caballo de fin de mes | **Hecho** | `src/main/ai/drift/service.ts:536-553`: una revisión solo cuenta como mensual con ≥ `DEGRADE_MIN_REVIEW_GAP_DAYS` (`:551`) o con operaciones nuevas; si no, `sinMesReal` (`:553`) | `src/main/ai/__audit__/ai.audit.test.ts:926` «HALLAZGO H3 · dos revisiones en días consecutivos a caballo de fin de mes no cuentan como dos meses»; `src/main/ai/drift/service.test.ts:595`; `:631` (con operaciones nuevas sí cuenta) |
| **H4** · tickers del LLM sin activos ligados | **Hecho** | `src/main/ai/news/service.ts:414-428`: solo se guarda un ticker si está ligado al titular (`linked`, `:419`) o si `detectAssets` lo encuentra en el texto saneado (`mentioned`, `:420-422`); el filtro está en `:428` | `ai.audit.test.ts:301` «HALLAZGO H4 · sin activos ligados, el LLM no debe atribuir sentimiento a un ticker que el titular no menciona»; `:284` «con activos ligados, la respuesta del LLM no puede añadir otro ticker» |
| **H5** · titular desconfirmado sigue influyendo | **Hecho** | `src/main/ai/news/repository.ts:138`: `list` filtra siempre con `ni.confirmada = 1` | `ai.audit.test.ts:319` «HALLAZGO H5 · un titular desconfirmado después de analizarse deja de influir en las señales»; `:390` «la señal siguiente a la desconfirmación pierde el ajuste de confianza del titular» |
| **P4** · posponer un reentrenamiento sin rastro en el Diario | **Hecho** | `src/main/ai/drift/service.ts:973-981`: `posponer` exige una fecha futura. `:1007-1015`: registra en el Diario la fecha y el motivo sin «..» (`recordJournal`, `:1009`) | `drift/service.test.ts:719` «posponer exige fecha futura y la guarda con el motivo»; `:747` «…no deja «..» en el Diario»; `ai.audit.test.ts:852` «ai:resolve-retrain: posponer … deja su entrada en el Diario, sin «..»»; `:882` (no se pospone al pasado) |
| **Modo por orden en Órdenes** | **Hecho** | `src/renderer/src/components/orders/OrderModeBadge.tsx:4-8`: el modo sale de la orden y nunca del modo actual; sin modo se ve «—» («Modo sin registrar», `:21`). `OrdersPage.tsx:163-172` (filtro «Modo»), `:386-391` (columna «Modo») | `src/renderer/src/components/orders/OrdersPage.test.tsx:279` «cada orden conserva su modo histórico recibido y nunca se deduce del modo actual»; `:303` (mismo id en las dos cuentas y filtro de modo); E2E `e2e/orders-live-mode.spec.ts:94` |
| **`.venv-ml` fuera del repositorio y en eslint/prettier** | **Hecho** | `git ls-files .venv-ml \| wc -l` → **0**; `ls .venv-ml` → «No such file or directory». `.gitignore:10` (`.venv-ml/`), `eslint.config.mjs:18` (`'.venv-ml/**'`), `.prettierignore:12` (`.venv-ml`). La guía ya no lo crea dentro: `ml/README.md:21-25` (E1 cerrado) | Comprobación por comando (§2.2) |
| **Clave de `eval:news-llm` documentada** | **Hecho** | Ya no hay clave de API: `--provider suscripcion` usa la sesión de Claude Code y `--provider local` no necesita nada. `docs/tareas-del-usuario.md:14-28` (reglas de las claves; `eval:*` no imprime ninguna), `:34-35` (los dos proveedores), `:89-92` (`CLAUDE_CLI_PATH` si `claude` no está en el PATH). `scripts/eval-news-llm.mjs:11-17` y `:27` | Revisión del documento y `grep` de §2.2; `sin-api.audit.test.ts:421` «nadie vuelve a leer la clave retirada ni a llamar a la API» |
| **Aviso del backtest aplazado en la ficha propia** | **Hecho** | `src/renderer/src/components/strategies/StrategyDetail.tsx:88-94` muestra `ExecutionNotice` antes de lanzar nada; `ExecutionNotice.tsx:23` dice «Estas reglas no se pueden ejecutar: <motivo>». La validación sale de `ruleValidation.ts:17` (`strategyExecution`). Las acciones quedan bloqueadas pero enfocables (`StressResults.tsx:188`, `aria-disabled`). El código `reglas-invalidas` cruza el IPC: `src/main/backtest/service.ts:1587` (`withBacktestErrorCode`), aplicado a los ocho manejadores (`:1639-1690`) | `RuleEditor.test.tsx:120` «la ficha explica reglas antiguas antes de pulsar y bloquea las tres acciones enfocables»; `:152` «ejecuta reglas válidas del adaptador…»; `src/main/backtest/service.test.ts:796` «conserva el code de BacktestError al cruzar el IPC ([code] motivo)»; E2E `e2e/strategies-backtest.spec.ts:336` «reglas antiguas: motivo previo, acciones bloqueadas y corrección por teclado» (`ipcError` en `:373`) |
| **Notificación al arrancar sin CLI** | **Hecho** | `src/main/ai/news/service.ts:586-597` (`start()`, una vez por proceso: si el proveedor guardado es la suscripción, está activada y no hay CLI, emite el estado y llama a `notifyFailure`, `:282-288`). `src/main/ai/news/index.ts:138`: `registerNewsAi` llama a `start()` antes de registrar los canales. En E2E no notifica (`:593`) | `src/main/ai/news/service.test.ts:595` «la CLI no encontrada se refleja como cli-no-encontrada y el arranque notifica UNA vez»; `:628` (volver a ok y una nueva caída notifican una vez cada uno); `:667`, `:683`, `:691` (sin aviso con el analizador local, con la suscripción sana o en E2E); `src/main/ai/news/index.test.ts:172` y `:194` (arranque real por `registerNewsAi`) |

Para lanzar solo las regresiones de la tabla:

```bash
npx vitest run src/main/live/__audit__/live.audit.test.ts src/main/live/smoke.test.ts \
  src/renderer/src/components/live/ChecklistPage.test.tsx src/renderer/src/components/ai/AiPage.test.tsx \
  src/main/ai/__audit__/ai.audit.test.ts src/main/ai/__audit__/sin-api.audit.test.ts \
  src/main/ai/drift/service.test.ts src/renderer/src/components/orders/OrdersPage.test.tsx \
  src/renderer/src/components/strategies/RuleEditor.test.tsx src/main/backtest/service.test.ts \
  src/main/backtest/strategies/custom.test.ts src/main/ai/news/service.test.ts src/main/ai/news/index.test.ts
```

## 2. Resultado de los comandos

### 2.1 Batería

Sobre `0fdc6eb8`, con el árbol limpio salvo los dos documentos de esta tarea:

| Comando | Resultado |
| --- | --- |
| Regresiones de la tabla (comando de §1) | **EXIT 0**: 13 archivos, **270/270** |
| `npm run typecheck` | **EXIT 0** |
| `npm run lint` | **EXIT 0** |
| `npm run format:check` | **EXIT 0** («All matched files use Prettier code style!») |
| `npm test` | **EXIT 0**: 192 archivos, **2.709/2.709** |
| `grep -rnE '\b(it\|test\|describe)\.(only\|skip\|fails)\(\|\.fixme\(' src e2e \| wc -l` | **0** |

`npm run test:e2e` no lo he lanzado en esta tarea: solo cambia documentación y lo ejecuta la verificación final.

### 2.2 Comprobaciones estáticas

| Comando | Resultado |
| --- | --- |
| `git ls-files .venv-ml \| wc -l` | **0** |
| `git check-ignore -v ml/data/velas.csv` | `.gitignore:12:ml/data/*` (ignorado; E2 cerrado) |
| `grep -n 'venv' ml/README.md` | Solo `~/.venvs/tradia-ml` (`:21-25`, `:43`, `:50`, `:64-65`, `:117`); ningún `.venv-ml` (E1 cerrado) |
| `grep -niE 'api de pago\|ANTHROPIC_API_KEY\|clave de la API' docs/tareas-del-usuario.md` | Una sola línea (`:10`), que dice que **no** se usa ninguna API de pago |
| `grep -niE 'corto\|logout\|claude.cmd\|EINVAL\|origin/main' docs/tareas-del-usuario.md` | Resultados en §0 (`origin/main`), §1 paso 5 (`/logout`), §4 paso 5 (`claude.cmd`, `spawn EINVAL`) y §7 (corto con dinero real) |

## 3. Sesiones por perfil

### Profesional independiente que organiza varios proyectos

Retoma el proyecto y quiere saber qué le queda por hacer a él.

1. Lee el Veredicto y `docs/tareas-del-usuario.md` de arriba abajo.
2. Sigue §3 de tareas para el entorno de ML y comprueba que `ml/README.md` dice lo mismo.
3. Busca en tareas qué hacer para operar en corto con dinero real.

- **Esperado:** las dos guías coinciden, el entorno va fuera del repositorio y el corto real tiene sus pasos y sus techos.
- **Observado:** coinciden (`~/.venvs/tradia-ml` en las dos; `ml/data/*` ignorado). §7 de tareas da la cuenta de margen de Alpaca con préstamo habilitado y ≥ 2 000 USD, los techos de 100 USD por orden, 200 USD de exposición, 1 posición y stop máximo del 5 %, que coinciden con `src/shared/live.ts:151-163` y con `LimitsForm.tsx:10-12`, `:66-74`.
- **Evidencia:** `grep` de §2.2; `sed -n 151,163p src/shared/live.ts`.

### Responsable de equipo que revisa entregas

Revisa que cada punto del objetivo tiene su cierre comprobable.

1. Abre cada archivo:línea de la tabla con `sed -n`.
2. Lanza las regresiones citadas.
3. Comprueba que tareas del usuario no tiene ningún paso con la API de pago y que el botón se cita con su nombre real.

- **Esperado:** cada referencia apunta al arreglo y las pruebas pasan.
- **Observado:** las referencias apuntan al arreglo; 270/270 en verde. El botón se cita como «Probar de nuevo» (`AiSettings.tsx:257`) en §1 paso 3 y en §4 paso 5.
- **Evidencia:** §1 y §2.

## 4. Hallazgos anteriores

### E1 · Cerrado · `ml/README.md` decía que se creara `.venv-ml` dentro del repositorio

Corregido en «Guía de ML con el entorno fuera del repositorio y velas reales ignoradas»: `ml/README.md:21-25` crea el entorno en `~/.venvs/tradia-ml` y explica que vive fuera del repositorio. Coincide con `docs/tareas-del-usuario.md` §3.

### E2 · Cerrado · las velas reales exportadas no estaban ignoradas

Corregido en la misma entrega: `.gitignore:12-13` (`ml/data/*` y `!ml/data/synthetic.csv`). `git check-ignore -v ml/data/velas.csv` → `.gitignore:12:ml/data/*`.

### P-3 y P-4 de `docs/qa/perfiles-reglas-noticias.md` · Cerrados

Este documento y `docs/tareas-del-usuario.md` se han reescrito sobre el código final. Las verificaciones anteriores de las tareas de frontend y de backend (editor de reglas, transporte del código `reglas-invalidas`, corto en la ficha, límites del corto) quedan en el historial de git de este archivo; su estado actual está en la tabla de §1.

## Verificación final

_Claude · Predeterminado (Testing) · 12-10-2026 · `HEAD` = `f0bf2226` («Ronda de correcciones de Frontend tras E2E y QA»), árbol limpio. Sin cambios en `src` ni en `e2e`: solo este documento. Las referencias de la tabla de §1 se han vuelto a comprobar con `sed -n` sobre `f0bf2226`; las que se habían movido con las rondas de correcciones (`ChecklistPage.test.tsx`, `StrategyDetail.tsx`, `RuleEditor.test.tsx`) ya están corregidas en la tabla._

**Veredicto: la rama es entregable.** Todos los comandos terminan en verde, `.venv-ml` está fuera del repositorio, no queda ningún salto real de pruebas y todos los hallazgos de los tres informes están corregidos o justificados.

### Comandos

| Comando | Resultado |
| --- | --- |
| `npm ci` | **EXIT 0** (avisos de `npm audit` y de `allowScripts`; ninguno bloquea) |
| `npm run typecheck` (`tsc --noEmit`) | **EXIT 0**, sin errores |
| `npm run lint` (`eslint .`) | **EXIT 0**, sin avisos |
| `npm run format:check` | **EXIT 0**: «All matched files use Prettier code style!» |
| `npm test` | **EXIT 0**: «Test Files 192 passed (192) · Tests 2710 passed (2710)», 37,5 s. Único aviso: `DEP0190` de `shell:true`, conocido y aceptado (rama `.cmd` de `claudeCli.ts`) |
| `npm run test:e2e` | **EXIT 0**: «54 passed (4.5m)», sin reintentos ni pruebas inestables |
| `npx playwright test e2e/custom-strategy.spec.ts e2e/live-gate.spec.ts --repeat-each=3` | **EXIT 0**: «12 passed (50.2s)»: las 4 pruebas, 3 veces cada una |
| `npm run eval:news-llm -- --provider local` | **EXIT 0**: activo 128/128 (umbral 90 %), sentimiento 128/128 (umbral 70 %), «Titulares analizados por el proveedor: 0 de 200 (sin coste de API)», «SUPERA los umbrales documentados» |
| `npm run eval:news-llm -- --provider api` | **EXIT 2**: «Proveedor desconocido «api». Uso: … --provider suscripcion\|local» (la API ya no existe) |
| `git ls-files .venv-ml \| wc -l` | **0** |
| `grep -rnE 'it\.fails\|\.skip\(\|fixme\|\.only\(' src e2e` (patrón fijado por el orquestador) | **Vacío.** Los dos comentarios que antes coincidían se han reescrito sin nombrar el marcador («Ningún hallazgo se marca como fallo esperado»): `src/main/backtest/__audit__/reglas.audit.test.ts:27` y `src/main/ai/__audit__/sin-api.audit.test.ts:22`. Ninguna prueba se salta |

`npm run test:e2e` reescribe unas 65 capturas de `docs/qa/capturas/`; se han restaurado con `git checkout -- docs/qa/capturas/` y el árbol queda limpio.

### Estado final de cada punto

| Punto | Estado | Evidencia |
| --- | --- | --- |
| H1 · evidencia sembrada fuera de E2E | **Hecho** | `src/main/live/service.ts:551`, `src/main/live/index.ts:142`; `live.audit.test.ts:379` |
| H2 · orden de mercado sobre el techo por orden | **Hecho** | `src/main/live/orderGuard.ts:155`, `:215`; `live.audit.test.ts:554`, `:721` (C4, corto) |
| H3 · racha a caballo de fin de mes | **Hecho** | `src/main/ai/drift/service.ts:551`; `ai.audit.test.ts:926` |
| H4 · tickers del LLM sin activos ligados | **Hecho** | `src/main/ai/news/service.ts:428`; `ai.audit.test.ts:301` |
| H5 · titular desconfirmado | **Hecho** | `src/main/ai/news/repository.ts:138`; `ai.audit.test.ts:319` |
| P1 · carrera de `useLiveChecklist` | **Hecho** | `useLiveChecklist.ts:134`; `ChecklistPage.test.tsx:392`, `:437`; E2E `live-gate.spec.ts:152` (3/3 con `--repeat-each=3`) |
| P2 · «Ver ficha del modelo» | **Hecho** | `PredictionsTable.tsx:40`; `AiPage.test.tsx:326` |
| P3 · predicción vigente por activo | **Hecho** | `PredictionsTable.tsx:28-37`; `AiPage.test.tsx:345` |
| P4 · posponer sin rastro en el Diario | **Hecho** | `drift/service.ts:1009`; `drift/service.test.ts:747`; `ai.audit.test.ts:852` |
| P7 · cordura de la prueba de humo | **Hecho** | `src/main/live/smoke.ts:191`; `smoke.test.ts:587` |
| Modo por orden en Órdenes | **Hecho** | `OrderModeBadge.tsx:4-8`; `OrdersPage.test.tsx:279`; E2E `orders-live-mode.spec.ts:94` |
| `.venv-ml` fuera del repo e ignorado | **Hecho** | `git ls-files .venv-ml` vacío; `.gitignore:10`, `eslint.config.mjs:18`, `.prettierignore:12`; `ml/README.md` usa `~/.venvs/tradia-ml` |
| Clave de `eval:news-llm` documentada | **Hecho**: ya no hay clave | `scripts/eval-news-llm.mjs:27` (`['local', 'suscripcion']`); `docs/tareas-del-usuario.md` «Resumen de comandos» y §1; ejecución con `--provider local` y `--provider api` arriba |
| Aviso del backtest aplazado en la ficha propia | **Hecho** | `StrategyDetail.tsx:88-94` + `ExecutionNotice.tsx:23`; `backtest/service.ts:1587` (`[reglas-invalidas]` cruza el IPC); `RuleEditor.test.tsx:120`; E2E `strategies-backtest.spec.ts:336` y `custom-strategy.spec.ts:175` (3/3) |
| **Estrategias propias** (backtest, estrés, historial, equivalencia, señales, corto) | **Hecho** | Equivalencia con `sma-cross`: `custom.test.ts:73`, `backtest/service.test.ts:534`. Recorrido completo: E2E `custom-strategy.spec.ts:56` (3/3) y `strategies-backtest.spec.ts:439` (corto) |
| Corto con dinero real con techos propios (100/200/1/5 %) | **Hecho** | `orderGuard.ts` y `live.audit.test.ts:721`; techos en `src/shared/live.ts` (`LIVE_FIXED_SHORT_CAPS`) |
| **Aviso de la suscripción** (motivo + paso + una notificación, también al arrancar sin CLI) | **Hecho** | `src/shared/newsSubscription.ts:9`, `:13`; `news/service.ts:586` (`start()`); `news/service.test.ts:595`, `index.test.ts:172`; E2E `news-sentiment.spec.ts` |
| **Retirada de la API de pago** | **Hecho** | Ajustes solo ofrece «Suscripción (Claude Code)» y «Analizador local» (`AiSettings.tsx:155`, `:171-172`); `sin-api.audit.test.ts:184`, `:257`, `:421` (la clave antigua se borra y nadie llama a la API) |
| **Limpieza** (`sessionDateLabel` único, `.venv-ml`, saltos de pruebas, Prettier) | **Hecho** | `format:check` en verde; grep de saltos vacío; `claudeCli.test.ts` y `news/service.test.ts` sin `skipIf` (helper `__fixtures__/installFakeCli.ts`) |

### Hallazgos de los tres informes

| Id | Informe | Estado final | Evidencia |
| --- | --- | --- | --- |
| R1 | `auditoria-reglas-noticias.md` | Corregido | `src/shared/strategyRules.ts:747-750`; `reglas.audit.test.ts:294` |
| Residual `parseStrategyRules(null)` | auditoría | Justificado | Cortado por `isStrategyRules` en IPC y `NOT NULL` en la base |
| Residual `secrets:set-key` | auditoría | Justificado | Nadie lee `news-llm-anthropic` y se borra al arrancar (`sin-api.audit.test.ts:257`) |
| `scaling.test.ts` sin formato | auditoría | Corregido | `format:check` en verde |
| F1 · ficha sin «Estado actualizado» ni foco | `e2e-reglas-noticias.md` | Corregido | `StrategiesPage.tsx:123`, `StrategyDetail.tsx:252`; `StrategiesPage.test.tsx:149`; E2E `custom-strategy.spec.ts:127` (3/3) |
| O1 · «Venta» sin posición en una propia solo larga | E2E | Justificado | Riesgo la veta con motivo; igual en las clásicas (`signals-dashboard.spec.ts:152`) |
| O2 · con `Objetivo: ninguno` Riesgo veta la compra | E2E | **Cerrado** (ver «Cierre de los dos fallos abiertos») | El comportamiento del motor de riesgo no cambia. La ayuda del objetivo avisa de que con «ninguno» (Sin objetivo) el motor de riesgo vetará la compra por la relación beneficio/riesgo: `src/renderer/src/components/strategies/RuleEditor.tsx:21-22`; prueba `RuleEditor.test.tsx:366`; comprobado en la app abierta |
| P-1 · nombre cortado a 120 | `perfiles-reglas-noticias.md` | Corregido | `StrategyNameAndLibrary.test.tsx:28`, `:41` |
| P-2 · cabeceras partidas en la biblioteca | perfiles | Corregido | `StrategyNameAndLibrary.test.tsx:83`, `:102` |
| P-3 · `estado-pendientes.md` desfasado | perfiles | Corregido | §1 reescrito; referencias revisadas otra vez en esta verificación |
| P-4 · faltaban tareas del usuario | perfiles | Corregido | `docs/tareas-del-usuario.md` §0, §1, §4 y §7 |
| Obs. · sin notificación al arrancar sin CLI | perfiles | Corregido | `news/service.ts:586`; `service.test.ts:595` |
| `FirstStepsCard` intermitente / `daily-routine` según la hora | regresión / fe-correcciones | **Cerrado** (ver «Cierre de los dos fallos abiertos») | `FirstStepsCard.tsx:81-86`, `FirstStepsCard.test.tsx:126-151`; `daily-routine.spec.ts:232`; 50/50 con carga, 2.711/2.711 y 54/54 |

### Sesiones por perfil

- **Profesional independiente que organiza varios proyectos.** Crea una propia con un error (`sma(lentx)`), lo corrige a `cruza_arriba(sma(rapida), sma(lenta))`, lanza estrés y backtest, ve el informe en el historial, pasa a Paper y ve su señal con stop. Completa la lista del dinero real y activa. Esperado y observado: todo pasa, 3 de 3 repeticiones (`custom-strategy.spec.ts:56`, `live-gate.spec.ts:152`). Además, `eval:news-llm --provider local` supera los umbrales sin ninguna clave.
- **Responsable de equipo que revisa entregas.** Abre una propia con reglas no ejecutables: ve el motivo antes de pulsar y backtest y estrés quedan bloqueados (`custom-strategy.spec.ts:175`, 3/3). Intenta activar el dinero real sin la lista completa, por la interfaz y por IPC directo: se rechaza (`live-gate.spec.ts:60`, 3/3). Recorre la tabla de puntos con `sed -n`: cada referencia apunta al arreglo.

### Lo que queda para el usuario (según `docs/tareas-del-usuario.md`)

Ninguna tarea usa la API de pago. En este orden:

0. Actualizar `main` con `origin/main` (`git merge --ff-only origin/main`) y lanzar la CI de la pull request desde la pestaña **Git**.
1. Iniciar sesión en Claude Code (`claude` → `/login`), revisar que las condiciones de la suscripción permiten este uso personal automatizado, ejecutar `npm run eval:news-llm -- --provider suscripcion` (esperado: «SUPERA los umbrales documentados»). Con la app abierta, hacer `/logout` y comprobar que llega **una** notificación y que Noticias avisa del analizador local; «Probar de nuevo» al volver.
2. Guardar las claves reales de Tiingo y FRED en Ajustes, pulsar «Probar conexión» y ejecutar `npm run qa:providers`.
3. Reentrenar el modelo con datos reales con el entorno `~/.venvs/tradia-ml`, fuera del repositorio.
4. Empaquetar (`npm run dist:mac` / `dist:win` / `dist:linux`) y abrir la app en las tres plataformas; en Windows, comprobar que `claude.cmd` responde sin `spawn EINVAL`.
5. Revisión legal y fiscal (CNMV/MiFID II e IRPF), plan de contingencia y varios meses de paper trading antes de marcar los requisitos manuales del dinero real.
6. Prueba de humo con dinero real (`npm run qa:alpaca-live-smoke`) con claves sin permiso de retirada, y cuadrarla con el panel de Alpaca.
7. Para el corto con dinero real: cuenta de margen de Alpaca con préstamo habilitado y ≥ 2 000 USD; los techos fijos son 100 USD por orden, 200 USD de exposición corta, 1 posición y stop ≤ 5 %.

### No comprobado en este entorno (no son fallos)

- Windows y Linux: solo se ha ejecutado en macOS. La rama `claude.cmd` corre aquí con `platform: 'win32'` inyectado, no en un Windows real.
- CLI real de Claude Code con sesión, notificación real de macOS tras `/logout`, claves reales y dinero real: son tareas del usuario.
- Lector de pantalla manual y auditoría axe.

## Cierre de los dos fallos abiertos (continuación)

_Claude · Predeterminado (Testing, sustituye a Copilot; entrega provisional hasta la revisión) · 13-10-2026 · `HEAD` = `d12b7734` («Prueba de FirstStepsCard estable con el equipo cargado»). Sin cambios en `src` ni en `e2e`. Cada archivo:línea de esta sección se ha comprobado con `grep -n` / `sed -n` sobre `d12b7734`._

**Veredicto: los dos fallos están cerrados y todas las puertas están en verde.** Queda una observación nueva y menor del editor (aviso «vacío» durante unos 200 ms tras insertar un ejemplo), descrita en `docs/qa/cierre-fallos-continuacion.md`. No afecta a O2 ni a ninguna puerta.

### Los dos fallos

| Fallo | Estado | Evidencia en el código | Ejecución repetida |
| --- | --- | --- | --- |
| **FirstStepsCard** «permite ocultar cuando todo está hecho y reaparece si se elimina una clave» falla de forma intermitente bajo carga | **Cerrado** | `src/renderer/src/components/onboarding/FirstStepsCard.tsx:81-86`: si faltan claves, borra «oculto» (`writeStorage(FIRST_STEPS_HIDDEN_KEY, null)`, `:83`) **antes** de `setConfig` (`:86`). Prueba `FirstStepsCard.test.tsx:126` con la respuesta controlada (`resolveStatuses`, `:137`) y la espera sobre DOM y `localStorage` (`:150`), sin pausas | **50/50** en bucle, una ejecución por proceso (`-t 'reaparece si se elimina una clave'`), con `npm test` en bucle a la vez: «BUCLE pass=50 fail=0». Además, `--repeats=49` (50 pasadas de los 6 casos) con otro `npm test` a la vez: «Tests 6 passed (6)», EXIT 0. Ese `npm test` simultáneo: 2.711/2.711 |
| **O2** · la ayuda del editor no avisaba de que con «Sin objetivo» Riesgo vetará la compra | **Cerrado** | `src/renderer/src/components/strategies/RuleEditor.tsx:21-22` (ayuda del campo `target`), el botón «Sin objetivo» inserta `ninguno` (`:55`). Prueba `RuleEditor.test.tsx:366` («avisa en la ayuda del objetivo de que sin objetivo el motor de riesgo vetará la compra») | En la app abierta (Electron con `TRADIA_E2E`): Estrategias › Nueva estrategia › «Sin objetivo». El campo queda en `ninguno` y su descripción accesible dice «Con «ninguno» (Sin objetivo) el motor de riesgo vetará la compra por la relación beneficio/riesgo.» y, a los 500 ms, «Válida». Captura: `docs/qa/capturas/cierre-o2-sin-objetivo.png` |

Nota sobre el comando: `npx vitest run … --repeat=50` lo rechaza Vitest 5.0.3 («CACError: Unknown option `--repeat`»). El equivalente es `--repeats=49`, que hace 50 pasadas en total. Vitest no publica el número de pasadas en su salida, así que el 50/50 se ha comprobado también con el bucle de 50 procesos.

### Puertas

Ejecutadas una a una sobre `d12b7734`, sin otras pruebas en marcha salvo donde se indica:

| Comando | Resultado |
| --- | --- |
| `npx vitest run src/renderer/src/components/onboarding/FirstStepsCard.test.tsx --repeats=49` + `npm test` a la vez | **EXIT 0**, «Tests 6 passed (6)». El `npm test` simultáneo: **EXIT 0**, 192 archivos, 2.711/2.711 |
| Bucle de 50 ejecuciones de la prueba + `npm test` en bucle | **50/50**. Observación: en la 2.ª vuelta del `npm test` de carga, con una carga media de 18 (dos baterías, 50 arranques de Vitest y el Playwright de otra tarea), dos pruebas ajenas pasaron del límite de 5 s: `src/main/market/ingestion.test.ts:481` (5,6 s; 0,6 s normalmente) y `StrategiesPage.test.tsx:97` (5,1 s; 0,9 s normalmente). Repetidas 10 veces cada una (`--repeats=9`): 34/34. Es saturación de la máquina, no un fallo del producto |
| `npm run typecheck` | **EXIT 0** (`tsc --noEmit`, sin errores) |
| `npm run lint` | **EXIT 0** (`eslint .`, sin avisos) |
| `npm run format:check` | **EXIT 0**: «All matched files use Prettier code style!» |
| `npx prettier --check src/main/live/scaling.test.ts` | **EXIT 0**: «All matched files use Prettier code style!». Los dos mensajes que pedían formatear este archivo ya no aplican |
| `npm test` (solo) | **EXIT 0**: «Test Files 192 passed (192) · Tests 2711 passed (2711)», 37,8 s |
| `npm run test:e2e` | **EXIT 0**: «54 passed (4.6m)». Las 65 capturas reescritas de `docs/qa/capturas/` se han restaurado con `git checkout` |
| `git ls-files .venv-ml \| wc -l` | **0** |
| `grep -rnE '\b(it\|test\|describe)\.(only\|skip\|fails\|skipIf\|runIf)\(\|\.fixme\(' src e2e \| wc -l` | **0** |
| `grep -niE 'api de pago\|ANTHROPIC_API_KEY\|--provider api' docs/tareas-del-usuario.md` | Solo `:10`, que dice que **no** se usa ninguna API de pago |

### Sesiones por perfil

- **Responsable de equipo que revisa entregas.** Repite la prueba intermitente 50 veces con el equipo cargado, lanza todas las puertas y comprueba cada archivo:línea con `grep -n`. Esperado: 50/50 y todo en verde. Observado: 50/50, todas las puertas en verde y las referencias coinciden.
- **Profesional independiente que organiza varios proyectos.** Crea una estrategia y pulsa «Sin objetivo». Esperado: la ayuda avisa del veto de Riesgo. Observado: lo avisa (captura de arriba). Durante unos 200 ms, el campo muestra en rojo «el campo de objetivo está vacío…» aunque ya contiene `ninguno` (`docs/qa/capturas/cierre-o2-aviso-transitorio.png`). Detalle en `docs/qa/cierre-fallos-continuacion.md`.

## C1 · Validación al insertar una regla (13-10-2026)

| Fallo | Estado | Evidencia | Verificación |
| --- | --- | --- | --- |
| C1 · aviso falso de «está vacío» durante 200 ms tras insertar un ejemplo | **Cerrado** | `src/renderer/src/components/strategies/StrategyForm.tsx:83` conserva las reglas y parámetros del resultado; `:101` oculta resultados desfasados; `:324` valida inmediatamente las inserciones. `RuleEditor.tsx:104` distingue escritura e inserción, y `:120` muestra «Comprobando…» durante la validación manual pendiente. | `RuleEditor.test.tsx:379`: reloj falso, «Sin objetivo» e «Insertar stop del 2 %» sobre campos vacíos muestran «Válida» sin avanzar el reloj ni anunciar vacío ni marcar `aria-invalid`; `:400`: escritura diferida 200 ms, retirada de errores anteriores y cancelación del resultado pendiente al insertar. 55/55 pruebas de estrategias; 2.714/2.714 en `npm test`. |

La ayuda de O2 se conserva sin cambios y su prueba sigue pasando (`RuleEditor.test.tsx:367`). Comprobado en Electron con `TRADIA_E2E`: Estrategias › Nueva estrategia › «Sin objetivo». Un observador del DOM registra tres cambios tras insertar, todos con `value: "ninguno"`, `invalid: "false"`, `result: "Válida"`. También se comprobó «Insertar stop del 2 %». Captura: [campo válido al insertar](capturas/cierre-c1-validacion-insercion.png). Registro de esta comprobación: `/tmp/tradia-c1-electron.log`.

Puertas de esta corrección: `typecheck`, `lint`, `format:check` y `npm test` en verde. `npm run test:e2e` en verde: 54/54 (4,9 min). Las capturas ajenas reescritas por la batería se han restaurado. `git ls-files .venv-ml` vacío; búsqueda de saltos prohibidos en `src` y `e2e` sin resultados. No se añaden tareas manuales ni dependencias.
