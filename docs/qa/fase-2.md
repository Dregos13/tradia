# QA · Fase 2 — Estrategias y backtest honesto

Prueba manual por perfiles en Electron con `TRADIA_E2E=1`, datos simulados y
almacenamiento temporal aislado. Las comprobaciones no usaron una clave real de
Tiingo ni instaladores.

## Profesional independiente que organiza varios proyectos

**Resultado: parcial; bloqueado al intentar comparar resultados propios.**

1. Acepté el aviso, abrí **Estrategias** y creé «Proyecto Atlas» y «Proyecto
   Boreal», cada una con hipótesis, reglas de entrada/salida/stop/objetivo,
   mercado SPY, periodo y régimen.
2. Edité ambas: la interfaz creó v2, pidió nota obligatoria, conservó v1 en el
   selector como solo lectura y registró la nota. Cambié Atlas a **Activa** y
   Boreal a **Paper**; ambos estados se reflejaron en sus fichas.
3. Intenté lanzar un backtest de entrenamiento y validación sobre SPY para la
   estrategia recién creada.

- **Esperado:** comparar informes de versiones propias con sus costes y métricas.
- **Observado:** la ejecución no se inicia: `No se pudo completar el backtest.
  Error invoking remote method 'backtest:run': BacktestError: la estrategia 5
  no tiene una implementación ejecutable registrada`. No se crea informe ni
  historial para la estrategia propia. Las estrategias clásicas sí pueden
  ejecutarse.
- **Evidencia:** `docs/qa/capturas/fase-2-backtest-estrategia-propia-error.png`;
  recorrido de Atlas/Boreal con `TRADIA_E2E` y salida
  `CREATION/VERSION/STATUS WALKTHROUGH PASSED FOR BOTH PROJECTS`.

También comprobé teclado y entradas límite: enviar el formulario vacío con
Enter queda bloqueado por validación requerida; la hipótesis larga se limita a
4.000 caracteres y no produce overflow horizontal en una ventana de 700 px.

## Responsable de equipo que revisa entregas

**Resultado: parcial; se puede auditar el informe, pero la ficha y un caso de
crisis no presentan toda la evidencia esperada.**

1. Abrí las fichas clásicas, incluida una estrategia ajena a los proyectos
   creados, e inspeccioné hipótesis, reglas, periodos, régimen, costes,
   historial y registro de cambios.
2. Revisé un informe de backtest sembrado, su fuente, costes y avisos de
   sobreajuste y sesgo de supervivencia. Los mensajes explican el motivo: caída
   del Sharpe fuera de muestra y ausencia de altas/bajas históricas del
   universo. En el informe se identifican `Datos simulados`, proveedor,
   periodo y costes.
3. Ejecuté y consulté resultados simulados para 2008, 2020 y 2022 de las cuatro
   estrategias clásicas.

- **Esperado:** poder identificar en la ficha la procedencia/periodo de la
  evidencia, entender los avisos metodológicos y revisar métricas de cada
  crisis.
- **Observado:** el registro de versiones incluye fecha y nota sobre qué cambió
  y por qué; la ficha muestra los costes asumidos y el informe da procedencia y
  costes concretos. Sin embargo, la ficha afirma literalmente «Procedencia y
  periodo del último resultado: no disponibles» y «Validación y temporalidad:
  no documentadas en el contrato actual», aunque hay resultados guardados. En
  Cruce de medias para 2020 la rentabilidad es 0 % y hay 0 operaciones, pero el
  drawdown aparece como «Sin datos».
- **Evidencia:** `docs/qa/capturas/fase-2-ficha-auditoria-1440.png`,
  `docs/qa/capturas/fase-2-informe-700.png` y
  `docs/qa/capturas/fase-2-crisis-700.png`. La regresión E2E verifica las
  cuatro fichas y los periodos de crisis; la lectura de datos simulados dio
  resultados guardados en cada estrategia.

## Criterios de aceptación

| # | Resultado | Evidencia y alcance |
|---|---|---|
| 1 | **Cumple** | `npm test`: 77 archivos y 941 pruebas pasaron. Incluye la auditoría anti-look-ahead para cuatro estrategias, el resultado sintético conocido y pruebas de métricas contrastadas manualmente. |
| 2 | **Cumple con limitación de auditoría** | `npm run test:e2e`: 15/15. En modo simulado aparecen las cuatro estrategias clásicas y las fichas incluyen hipótesis, reglas, mercados, periodos, régimen, costes y registro. La procedencia del resultado no se propaga a la ficha; ver hallazgo. |
| 3 | **Cumple** | Se crearon y editaron dos estrategias propias. Cada edición generó v2 con nota y v1 siguió consultable en solo lectura. Captura: `docs/qa/capturas/fase-2-versiones-estado-1440.png`. |
| 4 | **Parcial** | Para una estrategia clásica el E2E lanza backtest con comisión, mínimo, slippage y spread configurables; verifica ocho métricas, curva, operaciones, walk-forward, sensibilidad y Monte Carlo. Para una estrategia creada por el usuario, el motor rechaza la ejecución por falta de implementación registrada (hallazgo bloqueante). |
| 5 | **Parcial** | Las fichas muestran resultados simulados de las cuatro estrategias para 2008, 2020 y 2022, con fuente y número de operaciones. En el caso sin operaciones de Cruce de medias en 2020 el drawdown queda nulo y se muestra «Sin datos», no una métrica numérica. No se verificó con datos reales. |
| 6 | **Cumple** | `npm run lint`, `npm run typecheck`, `npm run build` y `npm run test:e2e` pasaron en este equipo. E2E: 15/15. |

## Hallazgos

### F2-QA-01 · Alta · Las estrategias creadas por el usuario no admiten backtest

- **Perfil:** Profesional independiente que organiza varios proyectos.
- **Pasos:** En modo `TRADIA_E2E`, crear una estrategia no clásica con SPY y
  reglas completas; abrir su ficha, fijar un periodo válido y pulsar **Lanzar
  backtest**.
- **Esperado:** guardar el resultado de la estrategia y poder comparar
  ejecuciones/versiones.
- **Observado:** error IPC: `la estrategia 5 no tiene una implementación
  ejecutable registrada`; no aparece informe ni historial.
- **Evidencia:** `docs/qa/capturas/fase-2-backtest-estrategia-propia-error.png`.
- **Impacto:** impide el flujo principal de backtest/comparación para las dos
  estrategias propias solicitadas. Requiere atención del rol responsable del
  motor/servicio de backtest.

### F2-QA-02 · Media · La ficha no identifica la procedencia del último resultado

- **Perfil:** Responsable de equipo que revisa entregas.
- **Pasos:** En modo simulado, abrir una ficha clásica con un backtest guardado
  y leer **Resumen de evidencia** y **Mercados y periodos**.
- **Esperado:** la ficha permite identificar fuente, periodo y temporalidad de
  la evidencia para auditar el resultado.
- **Observado:** la ficha presenta las cadenas «Procedencia y periodo del
  último resultado: no disponibles» y «Validación y temporalidad: no
  documentadas», aun cuando la biblioteca tiene métricas y el informe sí
  presenta proveedor, fuente, periodo y costes.
- **Evidencia:** `docs/qa/capturas/fase-2-ficha-auditoria-1440.png`.
- **Impacto:** obliga a salir de la ficha para resolver la procedencia y deja
  incompleta la lectura de auditoría solicitada al responsable de equipo.

### F2-QA-03 · Media · El estrés 2020 no muestra drawdown cuando no hay operaciones

- **Perfil:** Responsable de equipo que revisa entregas.
- **Pasos:** Abrir **Cruce de medias** → **Comportamiento en crisis** y ejecutar
  las pruebas simuladas; revisar el artículo 2020.
- **Esperado:** la rentabilidad, el drawdown y el número de operaciones deben
  tener un valor interpretable para cada crisis.
- **Observado:** 2020 muestra rentabilidad 0 %, 0 operaciones y drawdown
  «Sin datos» (resultado almacenado con drawdown nulo).
- **Evidencia:** `docs/qa/capturas/fase-2-crisis-700.png`; fuente/valores
  obtenidos de `window.tradia.stress.get` en modo simulado.
- **Impacto:** el informe de estrés no satisface el campo de drawdown requerido
  en esta condición límite.

## No comprobado en este equipo

No se usó una clave real de Tiingo; por tanto, quedan sin validar la procedencia
«datos reales» y la plausibilidad de cifras históricas. Tampoco se probaron
instaladores ni CI de macOS/Windows/Linux. Estas comprobaciones están reservadas
al usuario y no se consideran fallos del producto.
