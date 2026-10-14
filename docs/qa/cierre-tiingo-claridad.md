# Cierre · hallazgos de E2E y perfiles (Tiingo sin cobertura y claridad)

_Ronda de correcciones `fe-correcciones-pruebas` · 13-10-2026 · rama `orquesta/hay-un-problema-tiingo-no-devuelve-datos-0c9aa9`._

Fuentes: [`e2e-ticker-sin-cobertura.md`](e2e-ticker-sin-cobertura.md) (H1–H3, prefijo **E**) y
[`perfiles-tiingo-claridad.md`](perfiles-tiingo-claridad.md) (H1–H7, prefijo **P**).

La mayor parte se corrigió en dos tareas anteriores de la misma ronda: `7eefc97e`, «Quitar un
activo sin cobertura borra su aviso», y `54e8337b`, «Un aviso por activo, “Precios” al día y
textos sin jerga». Esta tarea cierra la mitad pendiente de E-H2: con datos atrasados el aviso
seguía duplicado. También comprueba que cada corrección tiene una prueba que fallaba antes.

## Estado por hallazgo

| Hallazgo | Severidad | Estado | Archivos tocados | Prueba que lo cubre |
| --- | --- | --- | --- | --- |
| E-H1 / P-H1 · tras «Quitar de la lista» el aviso de EUR no desaparece (tampoco tras reiniciar) | Alta | **Corregido** (`7eefc97e`) | `src/main/market/repository.ts` (`removeWatchlistTicker` borra `data_status` `ticker:X` en la misma transacción), `src/main/market/health.ts` (`freshness()` solo cuenta los `ticker:*` de la lista actual) | vitest: `repository.test.ts` «al quitar un activo borra su fila de data_status en la misma operación» y «…también limpia su fila huérfana»; `health.test.ts` «una fila ticker:X huérfana no entra en uncovered…» y «al quitar el activo su sin-cobertura sale del resumen…». Playwright: `e2e/quitar-activo-sin-cobertura.spec.ts` (sin publicar el resumen por IPC, incluye reinicio) y `e2e/ticker-sin-cobertura.spec.ts` caso 2 |
| E-H2 / P-H2 · el aviso aparece dos veces (franja global + bloque en línea de Inicio, Mercado e IA), con botones duplicados en el orden de Tab | Media | **Corregido**. Activo sin cobertura: `54e8337b`. Datos atrasados, no fiables o poniéndose al día: **esta tarea** | `src/renderer/src/components/DataFreshness.tsx`: la variante en línea pasa a ser un chip con icono y título, sin motivo, sin «Por qué ocurre», sin acciones y sin `role=status`. El aviso completo y sus acciones viven solo en la franja global (`ProviderBanner`), presente en todas las pantallas | vitest: `DataFreshness.test.tsx` «con datos atrasados la franja lleva el aviso y sus acciones una sola vez en cada pantalla» (nueva) y «un EUR sin cobertura se avisa una sola vez…». Playwright: `e2e/stale-data.spec.ts`, que en Inicio, Mercado e IA exige un solo «Actualizar ahora», un solo «Probar conexión», un solo «Por qué ocurre» y chips sin botones |
| P-H3 · «Precios · Simulado» pasa a «Sin evaluar» por un solo activo sin cobertura | Media | **Corregido** (`54e8337b`) | `src/renderer/src/components/dashboard/ConnectionBlock.tsx` (ignora las filas `sin-cobertura` al evaluar «Precios») | vitest: `DataFreshness.test.tsx` «“Precios” sigue “Disponible” cuando solo un activo no tiene cobertura» |
| P-H4 · el rechazo de EUR usa jerga («ETF», «calendario 24/5», «exposición parecida») y el título no dice «en Tiingo» | Baja | Corregido (`54e8337b`) | `market/Watchlist.tsx`, `UncoveredAssets.tsx` | `Watchlist.test.tsx`, `DataFreshness.test.tsx` «el detalle de EUR sin cobertura propone seguir EUR/USD sin jerga» |
| P-H5 · «Por qué ocurre» arrastra jerga | Baja | Corregido (`54e8337b`) | `UncoveredAssets.tsx` | La misma prueba de `DataFreshness.test.tsx` |
| P-H6 · aviso de datos atrasados con «Ver detalles» y una pausa sin contrastar con el motor | Baja | Corregido (`54e8337b`) | `DataFreshness.tsx` (`STALE_PAUSE_TEXT`, «Por qué ocurre») | `DataFreshness.test.tsx` «el aviso de datos atrasados usa “Por qué ocurre”…»; `e2e/stale-data.spec.ts` |
| P-H7 · dos acciones en «Siguiente paso» de un conector que funciona | Baja | Corregido (`54e8337b`) | `ProviderConnectionResult.tsx` | `ProviderConnectionResult.test.tsx`; `e2e/provider-connection.spec.ts` |
| E-H3 · el `reason` de `coverage()` y de `freshness().uncovered` dice «ticker 'EUR' no existe» | Baja | **Descartado** | — | Ese texto solo lo produce el proveedor simulado de E2E (`src/main/market/providers/simulated.ts:236`); el conector real de Tiingo no lo usa. Además, el renderer no muestra nunca el `reason` de un activo sin cobertura: `UncoveredAssets.tsx` y Conectores componen su propia frase («EUR no está disponible en Tiingo»). No lo ve ninguna persona usuaria |

Todos los hallazgos de severidad alta y media están corregidos.

## «Fallaba antes y pasa ahora»

Lo he comprobado sustituyendo temporalmente el código de producción por la versión anterior a
cada corrección y lanzando la prueba. Después he restaurado el código.

| Corrección | Código anterior | Resultado con el código anterior | Resultado ahora |
| --- | --- | --- | --- |
| E-H1 / P-H1 | `repository.ts` y `health.ts` de `3d3296da` | las 4 pruebas vitest de arriba fallan | pasan |
| P-H2 (sin cobertura), P-H3, P-H6 | `DataFreshness.tsx` y `ConnectionBlock.tsx` de `7eefc97e` | fallan las 3 pruebas vitest | pasan |
| E-H2 (datos atrasados, esta tarea) | `DataFreshness.tsx` de `54e8337b` | falla la prueba vitest nueva; en `e2e/stale-data.spec.ts` falla `chip.getByRole('button')).toHaveCount(0)` porque el chip de Mercado tenía botones | pasan |
| E-H1 en E2E | antes de `7eefc97e` | `ticker-sin-cobertura.spec.ts` caso 2 falla en `expect(banner).toHaveCount(0)` (informe E2E) | pasa |

## Pruebas actualizadas en esta tarea

Hasta ahora, varias pruebas de `DataFreshness.test.tsx` probaban las acciones de la variante en
línea montada sola, una situación que en la app no existe porque la franja está siempre. Esas
pruebas montan ahora la franja (`variant="banner"`), o la franja y el chip juntos, como en la app.
Son estas: progreso de la puesta al día, las tres N2 de «Actualizar ahora» y la de EUR/USD
desactualizado. La prueba «banner, Inicio, Mercado, Macro e IA…» exige ahora el motivo y las
acciones solo en la franja, y en cada pantalla un chip con el mismo título y sin botones.

## Verificación

`npm test`, `npm run lint`, `npm run typecheck`, `npm run format:check` y `npm run test:e2e` en
verde (cifras en el resumen de la entrega). Las capturas de `docs/qa/capturas` que regenera la
batería E2E se han revertido, como en las tareas anteriores.

## Fuera de esta tarea

- Las comprobaciones con clave real de Tiingo, con el instalador y la revisión visual en macOS,
  Windows y Linux corresponden a la persona usuaria.
- La variante en línea sigue mostrando su propio estado en dos casos que no venían en los
  informes: cuando no se puede leer el resumen (con «Reintentar») y cuando no hay conexión con
  todo al día.
