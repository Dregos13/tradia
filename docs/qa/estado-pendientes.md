# Estado de los puntos pendientes del objetivo

_Claude · Predeterminado (Testing, sustituye a Copilot) · 12-10-2026 · rama `orquesta/completa-estas-partes-sin-hacer-y-compru-7d9830` sobre `c3fe7286` (merge de la PR #10). Durante la tarea entró `f139475f` («Limpieza pendiente: sessionDateLabel único y .venv-ml en .prettierignore») y la batería se repitió sobre él_

## Veredicto

- **Los 14 puntos de la lista están hechos.** Cada uno tiene su código y su prueba de regresión, y esas pruebas pasan en esta rama.
- Hay **dos matices** que no cambian el estado de la lista, pero sí lo que queda por hacer:
  - **`.venv-ml` en `.prettierignore`:** en `c3fe7286` no estaba. Lo añadió la tarea de limpieza en `f139475f` (`.prettierignore:12`). Ya está **hecho**.
  - **`ml/README.md` sigue diciendo que se cree `.venv-ml` dentro del repositorio** (líneas 21-22, 42, 49, 63-64 y 116). Contradice `docs/tareas-del-usuario.md:116` y el objetivo. Lo dejo como hallazgo E1.
- Fuera de esta lista siguen sin hacer las partes que el plan asigna a otras tareas:
  - el backtest y las señales de las estrategias propias;
  - el aviso cuando falla la suscripción;
  - la retirada de la API de pago. `docs/tareas-del-usuario.md:32` y `:71-76` todavía documentan `--provider api` (criterio 6).
- **Comandos en verde:** `typecheck`, `lint`, `format:check`, `npm test` (2.510/2.510 en `c3fe7286` y 2.513/2.513 en el árbol) y `test:e2e` (**47 passed**). La única excepción fue un `typecheck` del árbol compartido, que falló una vez a mitad de la edición de otra tarea. Se repitió en `f139475f` con EXIT 0 (ver §2).
- `git ls-files .venv-ml | wc -l` → **0**. El `grep` de `it.fails`/`.only(`/`fixme`/`.skip(` en `src` y `e2e` → **0**.
- **Entorno:** `npm ci` hecho. El entorno de ML está en `~/.venvs/tradia-ml`, fuera del repositorio. `make_synthetic.py` y `train.py` terminan, y el `model.onnx` sale con el mismo SHA-256 que el versionado.

No he tocado código de `src` ni de `e2e`.

## 1. Estado de cada punto

Origen de las etiquetas:

- H1–H5: `docs/qa/fase-6-7-auditoria.md`.
- P1–P4 y P7: `docs/qa/fase-6-7.md`.

| Punto | Estado | Evidencia en el código | Prueba que lo cubre (en verde en esta rama) |
| --- | --- | --- | --- |
| **H1** · evidencia sembrada (`live.evidence`) aceptada fuera de E2E | **Hecho** | `src/main/live/service.ts:536`: la evidencia solo se lee si `allowSeededEvidence()`, y si no se usa `{}`. `src/main/live/index.ts:142`: `allowSeededEvidence: () => e2eEnabled` | `src/main/live/__audit__/live.audit.test.ts:370` «HALLAZGO H1 · fuera de E2E, una evidencia «live.evidence» manipulada en la base no cumple los requisitos automáticos»; `:612` «una copia con live.evidence, la lista cumplida y el modo «activo», restaurada en la app empaquetada, no deja el dinero real activo» |
| **H2** · orden de mercado por encima del techo por orden | **Hecho** | `src/main/live/orderGuard.ts:80` (`LIVE_ORDER_PRICE_MARGIN = 0.05`); `:120-124` (la compra sale limitada a `min(techo/cantidad, referencia × 1,05)`); `:186-199` (la venta que abre posición exige el margen de hueco por debajo del techo) | `live.audit.test.ts:539` «HALLAZGO H2 · una orden de mercado no puede ejecutarse por encima del techo por orden»; `:683` «con una referencia muy desfasada a la baja, la compra sale limitada…»; `:700` «HALLAZGO C4 · una entrada en corto…» |
| **P7** · cordura de la prueba de humo (−8.278 pb, precio ajeno) | **Hecho** | `src/main/live/smoke.ts:191` (`LIVE_SMOKE_MAX_SLIPPAGE_BPS = 300`); `:488` (límite = referencia × (1 + 300 pb)); `:573-580` (más de 300 pb da la prueba por fallida) | `src/main/live/smoke.test.ts:282` «con un cierre desfasado no se envía ninguna orden al broker»; `:566` «un slippage absurdo frente a la referencia da la prueba por fallida y suspende»; `:598` (nocional por encima del mínimo); `live.audit.test.ts:716` «con el último cierre de SPY de hace semanas no envía ninguna orden real» |
| **P1** · carrera de `useLiveChecklist` que impide activar el dinero real | **Hecho** | `src/renderer/src/components/live/useLiveChecklist.ts:129-135`: `save()` aplica `setLimits(saved.limits)` antes de la relectura, y un `live:changed` concurrente ya no lo descarta | `src/renderer/src/components/live/ChecklistPage.test.tsx:366` «aplica saved.limits aunque live:changed llegue durante la relectura del guardado»; `:411` «conserva saved.limits si falla la lectura posterior al guardado»; `:394` «…nunca faltan 0 de 7»; E2E `e2e/live-gate.spec.ts:141` «completa la lista, confirma los límites por escrito, activa y pasa la prueba de humo» |
| **P2** · «Ver ficha del modelo» llevaba a Inicio | **Hecho** | `src/renderer/src/components/ai/PredictionsTable.tsx:40-42`: es un botón que enfoca `#ai-model-card` con `scrollIntoView`, sin `href` ni cambio de hash. `ModelCard.tsx:30`: `id="ai-model-card"` | `src/renderer/src/components/ai/AiPage.test.tsx:326` «abre la ficha con teclado, desplaza y enfoca sin cambiar el hash»; E2E `e2e/ai-regime-prediction.spec.ts:206` «…«Ver ficha del modelo» lleva a la ficha» |
| **P3** · predicción vigente por activo | **Hecho** | `PredictionsTable.tsx:27-37`: la última por activo según el cierre, luego la hora de cálculo y luego el id. `:193`: tabla vigente. `:195-196`: «Histórico de predicciones (n)» plegado en `<details>` | `AiPage.test.tsx:345` «elige el último cierre por activo aunque el histórico llegue desordenado y se calcule después»; E2E `ai-regime-prediction.spec.ts:206` ««Predicción por activo» destaca la vigente de cada activo…» |
| **H3** · racha aislada a caballo de fin de mes | **Hecho** | `src/main/ai/drift/service.ts:535-545`: una revisión solo cuenta como mensual con ≥ `DEGRADE_MIN_REVIEW_GAP_DAYS` o con operaciones nuevas (`sinMesReal`) | `src/main/ai/__audit__/ai.audit.test.ts:941` «HALLAZGO H3 · dos revisiones en días consecutivos a caballo de fin de mes no cuentan como dos meses»; `src/main/ai/drift/service.test.ts:595` «dos revisiones a un día a caballo de fin de mes no cuentan como dos meses»; `:631` (con operaciones nuevas sí cuenta) |
| **H4** · tickers del LLM sin activos ligados | **Hecho** | `src/main/ai/news/service.ts:262-275`: solo se guarda un ticker si está ligado al titular o si `detectAssets` lo encuentra en el texto saneado | `ai.audit.test.ts:316` «HALLAZGO H4 · sin activos ligados, el LLM no debe atribuir sentimiento a un ticker que el titular no menciona»; `:299` «con activos ligados, la respuesta del LLM no puede añadir otro ticker» |
| **H5** · titular desconfirmado sigue influyendo | **Hecho** | `src/main/ai/news/repository.ts:138`: `list` filtra siempre con `ni.confirmada = 1` | `ai.audit.test.ts:334` «HALLAZGO H5 · un titular desconfirmado después de analizarse deja de influir en las señales»; `:405` «la señal siguiente a la desconfirmación pierde el ajuste de confianza del titular» |
| **P4** · posponer un reentrenamiento sin rastro en el Diario | **Hecho** | `src/main/ai/drift/service.ts:973-1012`: `posponer` exige una fecha futura y registra en el Diario la fecha y el motivo (`recordJournal`, `:1009`) | `drift/service.test.ts:719` «posponer exige fecha futura y la guarda con el motivo»; `:747` «posponer con un motivo acabado en punto no deja «..» en el Diario»; `ai.audit.test.ts:867` «ai:resolve-retrain: posponer … deja su entrada en el Diario, sin «..»» |
| **Modo por orden en Órdenes** | **Hecho** | `src/renderer/src/components/orders/OrderModeBadge.tsx:8`: el modo sale de la orden y nunca del modo actual. Sin modo se ve «—» («Modo sin registrar»). `OrdersPage.tsx:165-172` (filtro «Modo»), `:386-391` (columna «Modo») | `src/renderer/src/components/orders/OrdersPage.test.tsx:279` «cada orden conserva su modo histórico recibido y nunca se deduce del modo actual»; `:303` (mismo id en las dos cuentas y filtro de modo); E2E `e2e/orders-live-mode.spec.ts:86` «Órdenes muestra el modo de cada orden y las órdenes reales de la prueba de humo; el Diario las rotula como dinero real» |
| **`.venv-ml` fuera del repo y en eslint/prettier** | **Hecho** (prettier desde `f139475f`) | `git ls-files .venv-ml \| wc -l` → **0**; `.venv-ml` no existe en el worktree. `.gitignore:9` (`.venv-ml/`). `eslint.config.mjs:18` (`'.venv-ml/**'`). `.prettierignore:12` (`.venv-ml`), añadido en `f139475f` junto a `ml/__pycache__`; en `c3fe7286` faltaba. **Pero** `ml/README.md:21-22,42,49,63-64,116` sigue indicando crear `.venv-ml` dentro del repo (E1) | Comprobación por comando (§2); no hay prueba automática |
| **Clave de `eval:news-llm` documentada** | **Hecho** (con un matiz para el criterio 6) | `docs/tareas-del-usuario.md:10-24` (reglas de las claves: nunca en archivos y `eval:*` no imprime la clave); `:30-31` y `:61-64` (`--provider local` y `--provider suscripcion`, más `CLAUDE_CLI_PATH`); `scripts/eval-news-llm.mjs:12-19,37-47`. **Matiz:** `:32` y `:71-76` siguen documentando `--provider api` con `ANTHROPIC_API_KEY`, y el script lo acepta y lo elige por defecto si la variable existe (`eval-news-llm.mjs:37`). Lo retira la tarea de la API de pago | Revisión del documento; no hay prueba automática |
| **Aviso del backtest aplazado en la ficha propia** | **Hecho** | `src/renderer/src/components/backtest/BacktestLauncher.tsx:34`: `ExecutionNotice` («Sin implementación ejecutable: el backtest de estrategias propias llegará en la próxima fase») **antes** del formulario. `:74`: `fieldset` desactivado. `:39` y `:220-223`: el lanzamiento se bloquea también por `submit`. `StressResults.tsx:150,184`: lo mismo para el estrés. En el proceso principal, `src/main/backtest/service.ts:375` rechaza una estrategia sin implementación | `src/renderer/src/components/backtest/Backtest.test.tsx:274` «avisa y bloquea backtest y prueba final sin implementación, incluso con historial»; `src/renderer/src/components/strategies/StressResults.test.tsx:153` «avisa y bloquea estrés sin implementación ejecutable»; E2E `e2e/strategies-library.spec.ts:8` (aserciones `:64-72`: aviso visible y «Lanzar backtest», «Ejecutar prueba final» y «Ejecutar pruebas de estrés» desactivados) |

Para lanzar solo las regresiones de la tabla:

```bash
npx vitest run src/main/live/__audit__/live.audit.test.ts src/main/live/smoke.test.ts \
  src/renderer/src/components/live/ChecklistPage.test.tsx src/renderer/src/components/ai/AiPage.test.tsx \
  src/main/ai/__audit__/ai.audit.test.ts src/main/ai/drift/service.test.ts \
  src/renderer/src/components/orders/OrdersPage.test.tsx \
  src/renderer/src/components/backtest/Backtest.test.tsx src/renderer/src/components/strategies/StressResults.test.tsx
```

Resultado: ver §2.3.

## 2. Resultado de los comandos

### 2.1 Sobre `HEAD` limpio (`c3fe7286`, worktree temporal `/tmp/ep/head` con los mismos `node_modules`)

| Comando | Resultado | Duración |
| --- | --- | --- |
| `npm ci` (en el worktree de la tarea) | **EXIT 0**: 529 paquetes. Avisa de que 6 paquetes tienen scripts de instalación sin aprobar en `allowScripts` (better-sqlite3, onnxruntime-node, esbuild…). Aun así cargan: better-sqlite3 usa su `prebuilds/darwin-arm64.node`, y `require('onnxruntime-node')` y `esbuild` 0.25.12 funcionan | 4 s |
| `npm run typecheck` | **EXIT 0** | ≈5 s |
| `npm run lint` | **EXIT 0** | ≈5 s |
| `npm run format:check` | **EXIT 0** («All matched files use Prettier code style!») | ≈5 s |
| `npm test` | **EXIT 0**: 183 archivos, **2.510/2.510** | ≈55 s |

`test:e2e` no se repitió en `c3fe7286`: se ejecutó sobre el árbol de §2.2.

### 2.2 Sobre el árbol compartido de la tarea (con cambios sin commit de otras tareas)

En la carpeta de la misión trabajan a la vez otras tareas. Durante mi batería, la de limpieza tenía sin commit `.prettierignore`, `DataFreshness.tsx` y `DataFreshness.test.tsx` (el `sessionDateLabel` único). El E2E regeneró además 36 capturas de `docs/qa/capturas/*.png`, como en entregas anteriores; esos cambios quedan en el árbol.

| Comando | Resultado | Duración |
| --- | --- | --- |
| `npm run typecheck` | **EXIT 2** (transitorio): `TS2459: Module '"./DataFreshness"' declares 'sessionDateLabel' locally, but it is not exported` en `PredictionsTable.tsx:2`, `RegimePanel.tsx:2`, `ConnectionBlock.tsx:2`, `SignalsBlock.tsx:2`, `ProviderBanner.tsx:2` y `ProviderConnectionResult.tsx:3`. Lo provoca la edición a medias de la tarea de limpieza. En el `typecheck` que lanza `npm run build`, un minuto después, ya pasó | 5 s |
| `npm run lint` | **EXIT 0** | 5 s |
| `npm run format:check` | **EXIT 0** | 5 s |
| `npm test` | **EXIT 0**: 183 archivos, **2.513/2.513** | 54 s |
| `npm run test:e2e` (incluye `npm run build` → `typecheck`) | **EXIT 0**: **47 passed** (4,5 min); `typecheck` del build en verde | 278 s |
| Repetición sobre `f139475f`, con la limpieza ya en commit: `typecheck`, `lint` y `format:check` | **EXIT 0** los tres | — |

### 2.3 Comprobaciones estáticas y regresiones

| Comando | Resultado |
| --- | --- |
| `git ls-files .venv-ml \| wc -l` | **0** |
| `grep -rn 'it.fails\|\.only(\|fixme' src e2e` | **0 líneas** |
| `grep -rn '\.skip(' src e2e` | **0 líneas**. Solo quedan `describe.skipIf`/`it.skipIf(ON_WINDOWS)` en `src/main/ai/news/claudeCli.test.ts`, que en macOS se ejecutan |
| Regresiones de la tabla (comando de §1) | **EXIT 0**: 9 archivos, **177/177** |

## 3. Entorno

Instalado:

- **npm:** `npm ci` en el worktree de la tarea (Node v24.21.0, npm 11.19.0). Electron se descarga en el `postinstall` (`install-electron`, `node_modules/electron/dist/Electron.app`).
- **Entorno de ML:** `~/.venvs/tradia-ml`, fuera del repositorio.
  - Creado con `/usr/bin/python3` (Python 3.9.6 del sistema) y `pip install -r ml/requirements.txt`.
  - Quedan lightgbm 4.6.0, scikit-learn 1.6.1, onnxmltools 1.16.0, onnx 1.19.1, onnxruntime 1.19.2, numpy 2.0.2 y packaging 26.3.
  - Por dependencia transitiva entra también skl2onnx 1.20.0, que no está fijado en `requirements.txt`.
- **libomp:** ya estaba instalado con Homebrew (`libomp 23.1.3`). No hace falta nada más.

Comprobación del pipeline sobre datos sintéticos. Las salidas van a `/tmp` para no pisar `resources/models/` ni `ml/data/`, que están versionados:

```bash
~/.venvs/tradia-ml/bin/python ml/make_synthetic.py --out /tmp/ep/synthetic.csv
#   → EXIT 0 · 5400 filas (6 activos × 900 velas); byte a byte igual que ml/data/synthetic.csv
~/.venvs/tradia-ml/bin/python ml/train.py --data /tmp/ep/synthetic.csv --origin sintetico \
    --out /tmp/ep/models --no-activate --trained-at 2026-01-01T00:00:00Z
#   → EXIT 0 · train=2916 calibración=1050 prueba=1050
#     brier=0.196686 referencia=0.249797 logLoss=0.736175
#     apto para señales: False (Datos sintéticos · no apto)
#     model.onnx sha256=0cfda4e5…c906b6 (idéntico a resources/models/0.1.0/model.onnx)
```

El pipeline es reproducible: el `model.onnx` entrenado coincide byte a byte con el versionado.

No se ha creado ningún entorno virtual dentro del repositorio: `ls .venv-ml` → «No such file or directory».

## 4. Sesiones por perfil

### Profesional independiente que organiza varios proyectos

Prepara el equipo y comprueba si puede retomar el trabajo.

1. `npm ci` y la batería completa.
2. Sigue `docs/tareas-del-usuario.md` §3 para el entorno de ML: `~/.venvs/tradia-ml`, `make_synthetic.py` y `train.py`.
3. Repasa en la app (E2E) la predicción vigente por activo, «Ver ficha del modelo» y el aviso de la estrategia propia (`strategies-library.spec.ts`).

- **Esperado:** el entorno queda listo fuera del repositorio y las guías coinciden entre sí.
- **Observado:** el entorno queda listo. Pero `ml/README.md` sigue diciendo que se cree `.venv-ml` en la raíz del repositorio (E1). Además, el paso 2 de `docs/tareas-del-usuario.md` §3 exporta las velas reales a `ml/data/velas.csv`, que no está en `.gitignore` (E2): con commits automáticos acabaría en el repositorio.
- **Evidencia:** `/tmp/ep/pip.log`, `/tmp/ep/train.log`; `git check-ignore -v ml/data/velas.csv` → código 1 (no ignorado).

### Responsable de equipo que revisa entregas

Revisa que cada fallo del objetivo tiene su cierre comprobable.

1. Localiza cada etiqueta en su informe de origen.
2. Busca el código y la prueba de cada una.
3. Ejecuta la batería sobre `HEAD` limpio y sobre el árbol compartido.

- **Esperado:** las 14 filas con archivo:línea y prueba, y la batería en verde.
- **Observado:** las 14 filas están cerradas, con `.prettierignore` desde `f139475f`. `--provider api` sigue documentado (lo retira otra tarea). El único rojo fue el `typecheck` transitorio del árbol compartido, que no es de la rama.
- **Evidencia:** §1 y §2; registros en `/tmp/ep/*.log`.

## 5. Hallazgos

### E1 · Baja · Backend (documentación de ML): `ml/README.md` sigue diciendo que se cree `.venv-ml` dentro del repositorio

- **Pasos:** abrir `ml/README.md` y seguir «Requisitos».
- **Esperado:** el mismo entorno que `docs/tareas-del-usuario.md:116`, es decir `python3 -m venv ~/.venvs/tradia-ml`, y comandos con `~/.venvs/tradia-ml/bin/python`.
- **Observado:** `python3 -m venv .venv-ml` y `.venv-ml/bin/...` en las líneas 21-22, 42, 49, 63-64 y 116. Es justo lo que el objetivo pide sacar del repositorio. El `.gitignore` lo protege, pero la guía contradice la otra y la tarea del usuario.
- **Evidencia:** `grep -n '.venv-ml' ml/README.md`.

### E2 · Baja · Backend (repositorio): las velas reales exportadas para reentrenar no están ignoradas por git

- **Pasos:** seguir `docs/tareas-del-usuario.md` §3, paso 2: `export_candles.py --out ml/data/velas.csv`. Después, `git status`.
- **Esperado:** `ml/data/velas.csv` (o cualquier exportación real) ignorado, como `.venv-ml/`. Solo debería versionarse `ml/data/synthetic.csv`.
- **Observado:** `git check-ignore -v ml/data/velas.csv` devuelve 1 (no ignorado). En un worktree de Orquesta, donde los commits son automáticos, los datos de mercado del usuario acabarían en el repositorio.
- **Evidencia:** `.gitignore` solo tiene `.venv-ml/` y `ml/__pycache__/` en la parte de ML.
