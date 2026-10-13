# Revisión de la ronda de correcciones de Frontend

Codex · 13-10-2026 · macOS · Electron. Revisión de la entrega provisional
`7d9830c6-fe-correcciones-v1.md`, del commit `f0bf2226` y de los cambios de
renderer incluidos en `fba1645b`. No se han hecho commits, push ni cambios de rama.

## Resultado de la revisión

La corrección provisional de F1 conserva el aviso y el foco cuando la consulta
posterior termina correctamente. Los cambios de las aserciones de foco mantienen
las mismas expectativas y esperan sus efectos con `waitFor`. La comprobación de
`FirstStepsCard` espera el efecto que borra la marca de ocultación. En la rutina
diaria, `.first()` acepta varias conciliaciones válidas; siguen comprobándose los
tres tipos de resumen y las tres notificaciones de cada canal.

Faltaba cubrir una consulta posterior fallida: el estado ya estaba guardado, pero
`detail.error` desmontaba la ficha. Se perdían el aviso y el foco, y el estado que
mostraba el renderer dependía exclusivamente de una segunda consulta.

## Corrección adicional de F1

- `src/renderer/src/hooks/useIpcList.ts:38`: actualización de la caché con el
  resultado de una acción, invalidando las lecturas iniciadas antes de guardarla.
- `src/renderer/src/hooks/useStrategies.ts:56`: aplica la estrategia que devuelve
  el contrato existente de `strategies.setStatus`, sin inventar estados ni datos
  del historial.
- `src/renderer/src/components/strategies/StrategiesPage.tsx:83`: conserva la ficha
  cargada durante la relectura. Si falla, muestra un aviso recuperable con
  «Reintentar ficha» sin desmontarla. La carga inicial y los errores sin datos
  siguen usando sus estados de carga/error.
- `src/renderer/src/components/strategies/StrategiesPage.test.tsx:153`: mantiene
  el caso del historial retenido y comprueba que Paper aparece antes de soltarlo.
- `StrategiesPage.test.tsx:178`: historial fallido con una lectura anterior
  pendiente, confirmación de Paper, aviso de guardado, foco, lanzador de cambio
  desactivado y reintento del historial sin otro guardado.
- `StrategiesPage.test.tsx:232`: fallo del propio guardado, sin falso éxito,
  selección y foco conservados, y reintento correcto.
- `StrategiesPage.test.tsx:97`: el recorrido de alta/versionado pega los datos
  mediante `userEvent` en lugar de introducir cientos de pulsaciones. El caso
  agotó los 5 segundos bajo la carga concurrente; se conservan las aserciones y
  la validación por pulsación sigue cubierta en `RuleEditor`.
- `docs/qa/e2e-reglas-noticias.md`: aclara que la observación de F1 era histórica;
  la E2E actual comprueba el aviso y el foco.

La primera prueba nueva falló antes del arreglo por ausencia de «Estado
actualizado»: `/tmp/tradia-audit-fe-regression-before.log`. Las nuevas regresiones
pasan con el arreglo (`/tmp/tradia-audit-fe-regression-focused.log`). El filtro de
esa ejecución seleccionaba solo tres casos; no introduce marcadores para saltar
pruebas en el código.

## Contraste con los criterios de la misión

Los puntos H1–H5, P1–P4, P7, modo por orden, entorno ML, evaluación de noticias y
aviso previo del backtest ya tienen estado y evidencia en
`docs/qa/estado-pendientes.md`. Se revisaron los contratos y la cobertura existente:

- Estrategias propias: la validación previa gobierna backtest y estrés; las reglas
  inválidas explican el motivo. Las specs `custom-strategy` y `strategies-backtest`
  cubren ejecución e historial. `backtest/strategies/custom.test.ts` y
  `backtest/service.test.ts` cubren la equivalencia con `sma-cross`.
- Noticias: `AiSettings.tsx` ofrece solo Suscripción y Analizador local. Los avisos
  comparten el motivo y el paso de recuperación; `news-sentiment.spec.ts` recorre
  la caída de sesión, aviso único y recuperación con la CLI de pruebas.
- Dinero real: no se alteran la puerta ni el motor de riesgo. La cobertura existente
  comprueba los límites del corto de 100 USD/orden, 200 USD totales, una posición
  y stop máximo del 5 %. No se realizan operaciones reales durante esta revisión.
- `docs/tareas-del-usuario.md` no solicita una API de IA de pago; la evaluación
  usa la sesión de Claude Code o el analizador local. No se añaden tareas manuales
  ni dependencias.

Las otras tres revisiones concurrentes de Frontend mantienen sus propios cambios:
límites del corto, nombre/columnas y ayuda «Sin objetivo». La primera batería
completa detectó una regresión en la nueva spec de nombre/columnas: el filtro
`has: link` incluía el localizador de la tabla dentro de la búsqueda relativa a
una fila. Se corrigió únicamente ese localizador con un enlace relativo a la
fila (`e2e/strategy-name-and-columns.spec.ts:78`). Conserva la comprobación de
métricas y las medidas de las columnas. La misma ejecución tuvo un timeout al
aceptar el aviso de riesgo en Macro, durante el solapamiento de tres suites de
Electron; se repite la batería sin ese solapamiento para verificarlo.

## Verificación final

| Comando / comprobación | Resultado |
| --- | --- |
| `npm run typecheck` | Verde |
| `npm run lint` | Verde |
| `npm run format:check` | Verde |
| `npm test` | 192 archivos, 2.719/2.719 pruebas |
| `npm run test:e2e` | 55/55, sin reintentos, 4,4 min |
| `npx vitest run src/renderer/src/components/strategies/StrategiesPage.test.tsx` | 13/13 |
| `npm run eval:news-llm -- --provider local` | 128/128 en activo y sentimiento; supera los umbrales, sin coste de API |
| `git ls-files .venv-ml` | Vacío; tampoco existe el directorio |
| Búsqueda de `it.fails`, `.skip(`, `fixme` y `.only(` en `src` y `e2e` | Vacía |
| Inspección AST de las aserciones `toHaveFocus()` del renderer | 115/115 dentro de `waitFor` |

Logs en `/tmp/tradia-audit-fe-{typecheck,lint,format,test,regression-after,eval}.log`.

La segunda batería completa pasó sin otras suites de Electron ejecutándose en
paralelo. Registro: `/tmp/tradia-audit-fe-e2e-final.log`; la primera ejecución
con sus dos fallos se conserva en `/tmp/tradia-audit-fe-e2e.log`.

Orquesta incorporó los cambios de esta revisión en `3c89642c` mientras corrían
las comprobaciones. También incorporó seis capturas regeneradas por las suites.
Al terminar se restauraron los PNG de `docs/qa/capturas/` a `983ca089`, el estado
al comenzar la revisión; no se tocan las capturas nuevas de `test-results/`.
Esta revisión no ha creado commits.
