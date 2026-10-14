# Auditoría de la ronda de correcciones de E2E y perfiles

Codex · Frontend · 14-10-2026. Revisión de `9943e55f` y de la entrega provisional
`0c9aa91c-fe-correcciones-pruebas-v1`, contrastada con el código actual de la rama.

## Resultado de la revisión

La corrección de los avisos duplicados es adecuada: `ProviderBanner` concentra el detalle
y las acciones; Inicio, Mercado e IA conservan un indicador de estado sin controles ni
regiones vivas duplicadas. No necesita otro cambio de producción en esta auditoría.
El componente mantiene los tokens del proyecto y no consulta archivos de Orquesta.

Los estados de error al leer el resumen y de desconexión conservan su tratamiento anterior,
tal como declaraba la entrega. La prueba E2E de reconexión comprueba la instantánea y su
fecha; esos estados no se han eliminado para hacer pasar la comprobación de duplicados.

## Correcciones de cobertura

- Nueva `DataFreshnessDeduplication.test.tsx`: monta la franja junto a Inicio, Mercado e IA
  para los estados `stale`, `unreliable` y `catching-up`. Exige tres indicadores, un único
  detalle global, las acciones correspondientes y ausencia de botones, enlaces y anuncios
  en cada indicador. Solo `stale` muestra el texto que describe las guardas de frescura.
- `e2e/stale-data.spec.ts`: exige exactamente un indicador por pantalla antes de recorrerlo;
  así la prueba ya no puede pasar por un conjunto vacío. Comprueba también que el indicador
  no contiene enlaces ni regiones `status`, además de botones.

Las guardas se contrastaron en `signals/engine.ts` (última vela frente a sesión esperada),
`ai/prediction/service.ts` y `ai/regime/service.ts`: una vela atrasada no genera nuevos
cálculos para ese activo; los resultados anteriores se conservan. El E2E comprueba la
ausencia de nuevas señales y predicciones, y la recuperación de los tres servicios.

## Accesibilidad y alcance

Se recalcularon por luminancia sRGB los pares de contraste declarados en los tokens de
claridad, conexión y frescura: 32 por tema, ninguno inferior a 4,5:1; mínimos de 5,40:1
en claro y 5,62:1 en oscuro. La batería Electron incluye navegación con teclado, foco
tras retirar o sustituir EUR, temas claro y oscuro, ventana estrecha y zoom al 200 %.
El cálculo de tokens no sustituye una inspección visual del instalador en cada sistema.

La ficha de proyecto se mantiene: Electron en escritorio, EUR/USD en cartera simulada
interna y sin cambios en bróker, cortos, fuentes de noticias ni contratos IPC.
Los informes originales contienen resultados históricos: el descarte de la frase técnica
del proveedor simulado no describe el código final, cuyo backend ya normaliza los motivos.
La revisión paralela de EUR/USD y Conectores tiene sus propios cambios de producción;
esta auditoría modifica únicamente las dos pruebas citadas y este informe.

## Verificación

- `npm install && npm test`: verde en la primera ejecución (3060 pruebas).
- `npm test` al terminar los cambios: **204 archivos y 3076 pruebas en verde** (59,72 s).
- `npm run lint`, `npm run typecheck` y `npm run format:check`: **verde**.
- `npm run test:e2e`: **71 pruebas en verde**, incluidos los dos casos de
  `stale-data.spec.ts` con las aserciones reforzadas (8,1 min).
- `git diff --check`: verde.

Una ejecución intermedia de Vitest agotó los 120 s de la prueba de semilla de backtests
(`src/main/backtest/service.test.ts`) mientras coincidían dos baterías de Electron y otra
de Vitest. Al finalizar esa carga, la batería completa pasó sin modificar la prueba,
sus tiempos ni la configuración. La primera comprobación de formato coincidió con
archivos aún en edición en la revisión paralela; la comprobación final pasa.

La revisión paralela añadió después `e2e/connector-refresh-freshness.spec.ts` y lanzó
otra batería completa sobre ese estado final. Sus resultados corresponden a su informe;
las 71 pruebas citadas aquí son las de la ejecución de esta auditoría. Las capturas
regeneradas automáticamente no forman parte del cambio entregado.
