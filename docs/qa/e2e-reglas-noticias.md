# E2E · estrategias propias, aviso de la suscripción y regresión completa

Fecha: 2026-10-12 · macOS (Darwin 27), app Electron compilada (`npm run build`) con los ganchos
deterministas de `TRADIA_E2E`: mercado simulado, reloj anclado y sin red real.

## Qué se ha añadido

| Spec                                            | Perfil                       | Recorrido                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e2e/custom-strategy.spec.ts`                   | Profesional independiente    | Alta por la interfaz con un error en la Entrada (`sma(lentx)`) → el campo se marca en vivo con el motivo y la posición. «Crear estrategia» por teclado no guarda: aparece el resumen «Hay 1 error» y el foco vuelve al campo. Se corrige a `cruza_arriba(sma(rapida), sma(lenta))` → «Reglas válidas». Ya en la ficha: estrés (2008, 2020 y 2022), backtest con operaciones y 8 métricas, el informe en «Historial de backtests · v1», el paso a **Paper** y, tras cierres de vela simulados, una señal de **compra** de la propia, con stop, en «Señales vivas» de Inicio. |
| `e2e/custom-strategy.spec.ts`                   | Responsable de equipo        | Propia heredada con reglas no ejecutables: la ficha muestra «Estas reglas no se pueden ejecutar: … Entrada, caracteres …» antes de lanzar nada. «Lanzar backtest» y «Ejecutar pruebas de estrés» quedan con `aria-disabled` y pulsarlos con Enter no crea ningún informe. El IPC rechaza con `[reglas-invalidas]`.                                                                                       |
| `e2e/news-sentiment.spec.ts` (prueba nueva)     | Responsable de equipo        | Recorre el proceso principal de verdad, **sin dobles del IPC**. Usa una CLI falsa de Claude Code (el fixture `fake-claude-cli.mjs`) con un TMPDIR propio. En Ajustes solo hay 2 proveedores. Se elige «Suscripción (Claude Code)», se indica la ruta y se pulsa «Probar de nuevo»: aparece «sesión no iniciada» con el paso `claude` y `/login`, y llega **una** notificación «Tradia usa el analizador local». Noticias muestra el mismo motivo, y reintentar sin sesión no repite la notificación. Con la CLI respondiendo, «Probar de nuevo» da «Suscripción recuperada», `newsStatus` vuelve a `ok` y llega una sola notificación de recuperación. |

La prueba anterior de noticias, que cambia `ai:news-status` por un doble, se conserva: cubre el foco, el tema oscuro y los colores AA.

## Resultados

| Comando                                                                                       | Resultado                                |
| --------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `npm run build`                                                                               | OK (typecheck incluido)                   |
| `npx playwright test e2e/custom-strategy.spec.ts e2e/news-sentiment.spec.ts --repeat-each=3` | **18 passed (2,8 min)**: 6 pruebas × 3    |
| `npm run test:e2e` (batería completa)                                                         | **54 passed (4,4 min)**, sin fallos ni reintentos (`retries: 0`) |
| `npx eslint` y `npx prettier --check` sobre las dos specs                                     | OK                                       |
| Saltos en `src` y `e2e` (`skip`, `only`, `fails`, `fixme`, `todo`)                            | Ninguno. Solo hay dos menciones en comentarios de `__audit__` |
| `git ls-files .venv-ml`                                                                       | Vacío                                    |

Extracto de la batería completa:

```
  ✓  50 e2e/strategies-backtest.spec.ts:28:5 › biblioteca, versiones, backtest completo, sobreajuste, prueba final y crisis (27.9s)
  ✓  51 e2e/strategies-backtest.spec.ts:336:5 › reglas antiguas: motivo previo, acciones bloqueadas y corrección por teclado (2.8s)
  ✓  52 e2e/strategies-backtest.spec.ts:439:5 › estrategia propia con corto: validación por campo, backtest y operación en historial (4.8s)
  ✓  53 e2e/strategies-library.spec.ts:8:5 › biblioteca, edición versionada y ventana de 700 px (36.9s)
  ✓  54 e2e/strategy-stress.spec.ts:8:5 › las cuatro fichas muestran crisis, fuente y capital sin desbordamiento (6.9s)

  54 passed (4.4m)
```

La batería completa regenera las capturas que ya estaban versionadas en `docs/qa/capturas/`. Se han restaurado con `git checkout`, porque su contenido no cambia, y solo quedan las capturas nuevas de abajo.

## Capturas (docs/qa/capturas/)

- `reglas-propias-error-en-vivo.png`: Entrada marcada con «“lentx” no es un campo, un indicador ni un parámetro de la ficha · caracteres 31–35».
- `reglas-propias-estres.png`: las tres crisis guardadas de la propia.
- `reglas-propias-informe.png`: informe del backtest lanzado desde la ficha.
- `reglas-propias-historial.png`: el informe enlazado en «Historial de backtests · v1».
- `reglas-propias-senal-panel.png`: «Señales vivas» con «SPY ↑ Compra · Cruce rápido propio E2E · v1».
- `reglas-propias-no-ejecutables.png`: el aviso previo y el lanzador desactivado.
- `suscripcion-sin-sesion-ajustes.png`, `suscripcion-sin-sesion-noticias.png`, `suscripcion-recuperada-noticias.png`.

## Hallazgos

### F1 · La ficha no confirma el cambio de estado y el foco se pierde (baja · frontend)

- **Pasos:** Estrategias › una ficha › «Nuevo estado» = Paper › «Cambiar estado».
- **Esperado:** el aviso «Estado actualizado» (`role="status"`, StrategyDetail.tsx:267) y el foco dentro de la ficha.
- **Observado:** el estado sí cambia (insignia «● Paper» y entrada «Investigación → Paper» en el registro), pero el aviso no aparece nunca. `changeStatus` llama a `detail.reload()` sin modo de fondo (`StrategiesPage.tsx:119-122`). `useIpcList` pone `loading: true` y `StrategiesPage.tsx:85` cambia la ficha por «Cargando ficha…». `StrategyDetail` se desmonta, pierde el mensaje y deja el foco del teclado en `body`.
- **Evidencia:** primera ejecución de `custom-strategy.spec.ts`, con la espera de `getByRole('status').filter({ hasText: 'Estado actualizado' })` a 5 s, y el árbol de accesibilidad del `error-context.md` (botón «Cambiar estado» deshabilitado, sin estado visible). Ese era el resultado de la primera ejecución. La spec actual comprueba también el aviso «Estado actualizado» y el foco en «Nuevo estado» (`e2e/custom-strategy.spec.ts:127-132`).

**Cerrado y revisado el 13-10-2026.** La relectura de fondo conserva la ficha. La revisión de Codex añade el caso de historial fallido: aplica primero la estrategia devuelta por `setStatus`, descarta las lecturas anteriores al guardado y muestra un error recuperable sin desmontar la ficha (`StrategiesPage.tsx:83-139`, `useStrategies.ts:56-71`, `useIpcList.ts:38-47`). `StrategiesPage.test.tsx` cubre historial retenido, historial fallido con lectura anterior pendiente y fallo del guardado con reintento. La evidencia completa de esta revisión está en `docs/qa/audit-fe-correcciones.md`.

### Observaciones (no son fallos de esta misión)

- **O1 · Una propia solo larga emite «Venta» desde su regla de salida aunque no tenga posición.** Riesgo la veta («sin stop de protección», «beneficio/riesgo por debajo del mínimo»), así que no hay operación. Ocurre igual en las clásicas (`e2e/signals-dashboard.spec.ts` lo da por esperado). Ensucia el panel: se ve en `reglas-propias-senal-panel.png` de la primera ejecución. Decide Backend o Producto.
- **O2 · Con `Objetivo: ninguno` la compra siempre se veta** por «Beneficio/riesgo por debajo del mínimo». Es coherente con el motor de riesgo. Aun así, el mensaje de be-senales-propias proponía «ninguno» como ejemplo de ficha que emite. Conviene que la ayuda del editor avise de que, sin objetivo, Riesgo no aprobará las señales.

## Criterios de aceptación que toca esta tarea

| Criterio                                                                                    | Estado | Evidencia                                                                     |
| ------------------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------- |
| 1 · Una propia válida lanza backtest y estrés, y el informe queda en el historial; con reglas no ejecutables se ve el motivo y el lanzador queda desactivado | Cumple | `e2e/custom-strategy.spec.ts` (las 2 pruebas)                                 |
| 2 · Equivalencia con `sma-cross`                                                            | Fuera del E2E | Prueba unitaria `src/main/backtest/strategies/custom.test.ts:73`              |
| 3 · Solo 2 proveedores; con fallo, motivo y paso en Noticias y Ajustes y una sola notificación | Cumple para «sin sesión» | `e2e/news-sentiment.spec.ts`, prueba «sin sesión de Claude Code…». «CLI no encontrada» y «tope diario» están cubiertos por pruebas unitarias, no en E2E |
| 5 · `npm run test:e2e` en verde y sin saltos                                               | Cumple | 54/54 · grep vacío                                                             |

## No comprobado (lo impide el entorno, no es fallo del producto)

- La CLI real de Claude Code con `/logout` y `/login`: es una comprobación del usuario.
- Windows y Linux: solo se ha ejecutado en macOS. La rama `claude.cmd` de la prueba nueva está escrita pero no se ha ejecutado.
- Lector de pantalla real y auditoría axe.
