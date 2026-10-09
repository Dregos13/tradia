# Diseño de fase 2 · Estrategias y backtest honesto

La especificación visual detallada, los estados y las maquetas autocontenidas están en `.orquesta/design/f3c20a11/`; existe una copia de referencia en `.orquesta/design/fase-2/`. La implementación solo debe importar `src/renderer/src/design/strategy.tokens.json`: `.orquesta/` nunca forma parte del runtime.

## Dirección y jerarquía

Esta fase extiende **Cuaderno cuantitativo**. La interfaz se lee como un expediente auditable, no como un terminal especulativo: primero hipótesis y evidencia, después resultado. El color no presenta rentabilidad como premio; identifica estados, series y riesgos. Todos los números usan cifras tabulares.

La navegación añade `Estrategias`. La biblioteca es una lista comparativa, la ficha conserva contexto y versiones, el formulario es una página (no modal), el lanzador aparece en la ficha y el informe tiene ruta propia. La acción primaria es `Lanzar backtest`; `Ejecutar prueba final` es separada, explícita y confirmada porque bloquea esa prueba para la versión.

## Vistas

### Biblioteca

- Encabezado: título, explicación breve, `Nueva estrategia` y filtros por estado.
- Una fila por estrategia: nombre y familia, versión, estado con símbolo + texto, rentabilidad, drawdown, Sharpe, operaciones, fuente del último backtest y fecha.
- Las cuatro semillas se llaman `Cruce de medias`, `Reversión RSI/Bollinger`, `Ruptura de rangos` y `Momentum entre activos`.
- Orden por defecto: actividad reciente. Permitir ordenar por nombre, estado o métrica; nunca colorear una fila completa por rentabilidad.
- Vacío: `Aún no hay estrategias` + `Crear estrategia`. Cargando: esqueletos con `aria-busy`. Error: causa y `Reintentar`.

### Ficha completa

- Cabecera: nombre, versión seleccionada, estado, fuente del último resultado y acciones `Editar` / `Lanzar backtest`.
- Resumen de evidencia: ocho métricas con etiqueta, valor, unidad y periodo. No ocultar valores nulos: usar `Sin datos`.
- Secciones: hipótesis; entrada, salida, stop y objetivo; mercados y temporalidad; entrenamiento, validación y fuera de muestra; régimen favorable y régimen en que falla; costes asumidos; parámetros; registro de cambios.
- El selector de versión actualiza la URL `#estrategias/<id>/v<n>` y la ficha completa. Las versiones antiguas muestran `Versión histórica · solo lectura`.
- `Comportamiento en crisis` muestra 2008, 2020 y 2022 con rentabilidad, drawdown, operaciones, comparación con SPY, fuente y minicurva con resumen textual. Si no hay resultados, `Ejecutar pruebas de estrés`.

### Crear y editar

- Página en dos columnas: navegación de secciones a la izquierda y campos a la derecha; bajo 700 px pasa a una columna.
- Secciones: Identidad, hipótesis, reglas, universo y periodos, régimen, costes, parámetros.
- Crear comienza en `Investigación`. En editar, cualquier cambio de reglas, parámetros o costes crea una versión nueva.
- `Nota del cambio` es obligatoria al editar, mínimo recomendado 12 caracteres. Error en línea: `Explica qué cambió y por qué; esta nota quedará en el historial.` El resumen antes de guardar dice `Se creará la versión v2; v1 seguirá disponible`.
- Cambiar solo el estado usa una acción independiente y no crea versión.

### Lanzador e informe

- Lanzador: periodo, universo, capital inicial, riesgo por operación, comisión porcentual y mínima, slippage, spread, parámetros, división 60/20/20 y semilla Monte Carlo. Valores iniciales: 10.000 USD; 0,05 % (mínimo 1 USD); 5 pb; 2 pb; 1.000 simulaciones.
- El coste estimado se resume antes de ejecutar. El texto aclara: señal al cierre de `t`, ejecución en apertura de `t+1`; si stop y objetivo ocurren en la misma vela, prevalece el stop.
- Progreso: etapa, porcentaje, elemento actual, tiempo transcurrido y `Cancelar`. La ventana continúa siendo operable.
- Informe: procedencia y alcance; ocho métricas; curva de capital; operaciones; ventanas walk-forward; sensibilidad; Monte Carlo; avisos; historial.
- Métricas obligatorias: rentabilidad, drawdown máximo, Sharpe, factor de beneficio, tasa de acierto, expectativa, racha perdedora máxima y número de operaciones.
- Heatmap: cada celda tiene valor visible y accesible. Incluir tabla alternativa; no comunicar el resultado solo por color.
- Monte Carlo: histograma o banda con P5/P50/P95, leyenda y tabla de percentiles. La prueba final muestra `Bloqueada sin ejecutar`, `Disponible` o `Ejecutada y bloqueada`.
- Avisos persistentes: sobreajuste con criterio concreto; sesgo de supervivencia residual; rendimientos pasados; `Datos simulados` o `Datos reales` siempre visible.

## Estados transversales

- **Vacío:** explica qué falta y ofrece una única siguiente acción.
- **Cargando:** conserva la geometría, `aria-busy="true"`, texto `Cargando…`; no anunciar cada esqueleto.
- **En progreso:** barra determinada cuando exista porcentaje; indeterminada solo al preparar datos. `role="status"` con anuncios por etapa, no por tick.
- **Error:** `role="alert"`, problema concreto, efecto y recuperación. No borrar valores introducidos en formularios.
- **Éxito:** confirmación breve (`Backtest guardado`) y enlace al informe; no depende de verde.
- **Sin permisos:** campos visibles en solo lectura, explicación `Necesitas permiso de edición` y acción para volver; nunca simular un error de red.

## Estados de estrategia

| Estado | Token | Señal secundaria | Uso |
| --- | --- | --- | --- |
| Investigación | `strategyStatus.research` | matraz | hipótesis aún en validación |
| Paper | `strategyStatus.paper` | documento con check | validación sin capital real |
| Activa | `strategyStatus.active` | círculo de reproducción | habilitada por el sistema |
| Degradada | `strategyStatus.degraded` | tendencia descendente | rendimiento fuera de tolerancia |
| Retirada | `strategyStatus.retired` | archivo | conservada para auditoría |

El texto completo siempre acompaña al color. `Paper` se presenta como `Paper` en espacios compactos y `Paper trading` en la ficha.

## Comportamiento a 700 px

- Punto de cambio: `@media (max-width: 700px)`; no se diseña como móvil táctil, sino como ventana de escritorio estrecha.
- La barra lateral pasa a cabecera con navegación horizontal desplazable; el contenido usa 20 px laterales.
- Acciones de cabecera se apilan y ocupan ancho disponible. Objetivos mínimos de 44 px.
- Biblioteca y tablas de operaciones/walk-forward se convierten en filas apiladas con `data-label`; se ocultan encabezados solo visualmente. No hay overflow horizontal del documento.
- Métricas: dos columnas; a menos de 460 px, una. Gráficos mantienen 280 px de alto y desplazan solo su área interna si fuese imprescindible.
- Formulario, ficha y lanzador pasan a una columna. La barra de acciones no es sticky si tapa contenido.

## Accesibilidad y contraste

- WCAG 2.2 AA. Texto normal ≥ 4,5:1 y texto grande/elementos gráficos ≥ 3:1. Pares mínimos verificados: `#566174`/`#FFFEFA` 6,20:1; investigación `#5B3B91`/`#EEE6FA` 6,99:1; paper `#1746C6`/`#E5EBFF` 6,47:1; activa `#126B4B`/`#DDF3E9` 5,59:1; degradada `#765500`/`#F5EAC2` 5,68:1; retirada `#4F5868`/`#E4E6E9` 5,74:1.
- Foco de 3 px con separación de 2 px; orden de foco igual al orden visual; `Esc` solo cierra popovers, no descarta formularios.
- Gráficos: título, resumen, leyenda textual y tabla de datos alternativa. SVG decorativos `aria-hidden`; gráficos informativos con nombre accesible.
- Toda fecha incluye año; porcentajes conservan signo; pérdidas no dependen del rojo. Los tooltips también funcionan con foco.
- Respetar `prefers-reduced-motion`; la animación de progreso queda sin transición.

## Contratos de implementación

- Mantener textos comprobables: `Nueva estrategia`, `Nota del cambio`, `Lanzar backtest`, `Ejecutar prueba final`, `Datos simulados`, `Datos reales`, `Posible sobreajuste`, `Sesgo de supervivencia`, `Comportamiento en crisis`.
- Tokens: consumir el JSON mediante el adaptador del renderer. No duplicar valores hexadecimales en componentes.
- Los datos de las maquetas son ilustrativos; la UI real nunca debe inventar resultados ausentes.
- Ningún archivo bajo `src/` puede importar o leer `.orquesta/`.
