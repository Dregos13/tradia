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
| **P1** · carrera de `useLiveChecklist` que impide activar el dinero real | **Hecho** | `src/renderer/src/components/live/useLiveChecklist.ts:129-136`: `save()` aplica `setLimits(saved.limits)` (`:134`) antes de la relectura, y un `live:changed` concurrente ya no lo descarta | `src/renderer/src/components/live/ChecklistPage.test.tsx:386` «aplica saved.limits aunque live:changed llegue durante la relectura del guardado»; `:431` «conserva saved.limits si falla la lectura posterior al guardado»; `:414` «…nunca faltan 0 de 7»; E2E `e2e/live-gate.spec.ts:152` «completa la lista, confirma los límites por escrito, activa y pasa la prueba de humo» |
| **P2** · «Ver ficha del modelo» llevaba a Inicio | **Hecho** | `src/renderer/src/components/ai/PredictionsTable.tsx:40-44`: un botón que enfoca `#ai-model-card` con `scrollIntoView`, sin `href` ni cambio de hash. `ModelCard.tsx:30`: `id="ai-model-card"` | `src/renderer/src/components/ai/AiPage.test.tsx:326` «abre la ficha con teclado, desplaza y enfoca sin cambiar el hash»; E2E `e2e/ai-regime-prediction.spec.ts:206` (el botón en `:268`) |
| **P3** · predicción vigente por activo | **Hecho** | `PredictionsTable.tsx:28-37`: la última por activo según el cierre, luego la hora de cálculo y luego el id. `:193`: tabla vigente. `:195-196`: «Histórico de predicciones (n)» plegado en `<details>` | `AiPage.test.tsx:345` «elige el último cierre por activo aunque el histórico llegue desordenado y se calcule después»; E2E `ai-regime-prediction.spec.ts:206` ««Predicción por activo» destaca la vigente de cada activo…» |
| **H3** · racha aislada a caballo de fin de mes | **Hecho** | `src/main/ai/drift/service.ts:536-553`: una revisión solo cuenta como mensual con ≥ `DEGRADE_MIN_REVIEW_GAP_DAYS` (`:551`) o con operaciones nuevas; si no, `sinMesReal` (`:553`) | `src/main/ai/__audit__/ai.audit.test.ts:926` «HALLAZGO H3 · dos revisiones en días consecutivos a caballo de fin de mes no cuentan como dos meses»; `src/main/ai/drift/service.test.ts:595`; `:631` (con operaciones nuevas sí cuenta) |
| **H4** · tickers del LLM sin activos ligados | **Hecho** | `src/main/ai/news/service.ts:414-428`: solo se guarda un ticker si está ligado al titular (`linked`, `:419`) o si `detectAssets` lo encuentra en el texto saneado (`mentioned`, `:420-422`); el filtro está en `:428` | `ai.audit.test.ts:301` «HALLAZGO H4 · sin activos ligados, el LLM no debe atribuir sentimiento a un ticker que el titular no menciona»; `:284` «con activos ligados, la respuesta del LLM no puede añadir otro ticker» |
| **H5** · titular desconfirmado sigue influyendo | **Hecho** | `src/main/ai/news/repository.ts:138`: `list` filtra siempre con `ni.confirmada = 1` | `ai.audit.test.ts:319` «HALLAZGO H5 · un titular desconfirmado después de analizarse deja de influir en las señales»; `:390` «la señal siguiente a la desconfirmación pierde el ajuste de confianza del titular» |
| **P4** · posponer un reentrenamiento sin rastro en el Diario | **Hecho** | `src/main/ai/drift/service.ts:973-981`: `posponer` exige una fecha futura. `:1007-1015`: registra en el Diario la fecha y el motivo sin «..» (`recordJournal`, `:1009`) | `drift/service.test.ts:719` «posponer exige fecha futura y la guarda con el motivo»; `:747` «…no deja «..» en el Diario»; `ai.audit.test.ts:852` «ai:resolve-retrain: posponer … deja su entrada en el Diario, sin «..»»; `:882` (no se pospone al pasado) |
| **Modo por orden en Órdenes** | **Hecho** | `src/renderer/src/components/orders/OrderModeBadge.tsx:4-8`: el modo sale de la orden y nunca del modo actual; sin modo se ve «—» («Modo sin registrar», `:21`). `OrdersPage.tsx:163-172` (filtro «Modo»), `:386-391` (columna «Modo») | `src/renderer/src/components/orders/OrdersPage.test.tsx:279` «cada orden conserva su modo histórico recibido y nunca se deduce del modo actual»; `:303` (mismo id en las dos cuentas y filtro de modo); E2E `e2e/orders-live-mode.spec.ts:94` |
| **`.venv-ml` fuera del repositorio y en eslint/prettier** | **Hecho** | `git ls-files .venv-ml \| wc -l` → **0**; `ls .venv-ml` → «No such file or directory». `.gitignore:10` (`.venv-ml/`), `eslint.config.mjs:18` (`'.venv-ml/**'`), `.prettierignore:12` (`.venv-ml`). La guía ya no lo crea dentro: `ml/README.md:21-25` (E1 cerrado) | Comprobación por comando (§2.2) |
| **Clave de `eval:news-llm` documentada** | **Hecho** | Ya no hay clave de API: `--provider suscripcion` usa la sesión de Claude Code y `--provider local` no necesita nada. `docs/tareas-del-usuario.md:14-28` (reglas de las claves; `eval:*` no imprime ninguna), `:34-35` (los dos proveedores), `:89-92` (`CLAUDE_CLI_PATH` si `claude` no está en el PATH). `scripts/eval-news-llm.mjs:11-17` y `:27` | Revisión del documento y `grep` de §2.2; `sin-api.audit.test.ts:421` «nadie vuelve a leer la clave retirada ni a llamar a la API» |
| **Aviso del backtest aplazado en la ficha propia** | **Hecho** | `src/renderer/src/components/strategies/StrategyDetail.tsx:87-93` muestra `ExecutionNotice` antes de lanzar nada; `ExecutionNotice.tsx:23` dice «Estas reglas no se pueden ejecutar: <motivo>». La validación sale de `ruleValidation.ts:17` (`strategyExecution`). Las acciones quedan bloqueadas pero enfocables (`StressResults.tsx:188`, `aria-disabled`). El código `reglas-invalidas` cruza el IPC: `src/main/backtest/service.ts:1587` (`withBacktestErrorCode`), aplicado a los ocho manejadores (`:1639-1690`) | `RuleEditor.test.tsx:118` «la ficha explica reglas antiguas antes de pulsar y bloquea las tres acciones enfocables»; `:150` «ejecuta reglas válidas del adaptador…»; `src/main/backtest/service.test.ts:796` «conserva el code de BacktestError al cruzar el IPC ([code] motivo)»; E2E `e2e/strategies-backtest.spec.ts:336` «reglas antiguas: motivo previo, acciones bloqueadas y corrección por teclado» (`ipcError` en `:373`) |
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
