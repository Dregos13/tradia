# E2E: cierre de los tres fallos del activo sin cobertura

Spec: `e2e/ticker-sin-cobertura.spec.ts`, bloque «Cierre de los tres fallos del activo sin cobertura» (app Electron real, proveedor simulado de `TRADIA_E2E`). Siembra: `TRADIA_E2E_UNCOVERED_TICKERS=''`, lista SPY + EUR, reabrir con la lista por defecto y adelantar el reloj un día (`openWithLegacyEur`). Los asserts que ya había no se han relajado.

## Resultado

| Hallazgo original                                                  | Caso                          | Resultado | Evidencia                                                    |
| ------------------------------------------------------------------ | ----------------------------- | --------- | ------------------------------------------------------------ |
| H1 · tras «Quitar de la lista» el aviso de EUR no desaparecía      | `H1: «Quitar EUR de la lista»…` | Resuelto  | `test-results/cierre-ticker-1-quitado.png`                   |
| H2 · el aviso salía dos veces en Mercado con acciones duplicadas   | `H2: … único encabezado…`     | Resuelto  | `test-results/cierre-ticker-2-unico.png`                     |
| H3 · el motivo era el texto técnico «ticker 'EUR' no existe»      | `H3: ningún texto visible…`   | Resuelto  | `test-results/cierre-ticker-3-llano.png`                     |

## Pasos y comprobaciones

**H1.** Mercado → foco en «Cambiar por FXE para EUR» → Tab llega a «Quitar EUR de la lista» → Enter. Sin reiniciar: el encabezado «EUR no está disponible en Tiingo» desaparece de Mercado y de Inicio (y «Precios» sigue «Disponible»); `watchlist.list()` = `['SPY']`; `freshness().uncovered` = `[]` y `state` = `current`; `dataStatus.get()` ya no contiene `ticker:EUR`; `watchlist.coverage()` solo lista SPY. Una pasada nueva (`refreshNow`) y un reinicio de la app tampoco lo resucitan.

**H2.** Con EUR heredado, en Inicio y en Mercado: exactamente 1 encabezado «EUR no está disponible en Tiingo» y 1 botón «Quitar EUR de la lista» por rol, y recorriendo la página con Tab (hasta que el foco repite elemento) el botón recibe el foco exactamente una vez.

**H3.** Recorrido Inicio, Mercado, IA y Ajustes › Conectores (tras «Probar conexión»): el texto visible de la página y todos los `reason` de `freshness().uncovered`, `freshness().items` y `watchlist.coverage()` no casan con `/no existe|'tiingo'|ticker '|no devolvió datos/`. El motivo de EUR casa con `/no tiene datos de EUR/` (con el proveedor simulado dice «Proveedor simulado no tiene datos de EUR.»; con Tiingo real dirá «Tiingo…»).

## Cambio en un assert existente (no es una relajación)

El caso 4 original fallaba (en las 3 pasadas) porque la tarea «Conectores no afirma “sin cobertura” cuando todo está cubierto» cambió los textos a propósito: el título «Activos de tu lista sin cobertura» pasó a ser el encabezado «Cobertura de tu lista en Tiingo», y «No hay activos marcados sin cobertura.» pasó a «Tiingo cubre todos los activos de tu lista.». Se han actualizado esos dos asserts a los textos nuevos, con la misma intención (el encabezado se ve con EUR sin cobertura; sin EUR, Conectores deja de nombrarlo y confirma la cobertura).

## Comandos

- `npm run build && for i in 1 2 3; do npx playwright test e2e/ticker-sin-cobertura.spec.ts e2e/quitar-activo-sin-cobertura.spec.ts; done`: 8 de 8 en las tres pasadas.
- `npm run test:e2e`: 71 pasan, 0 fallan.
- `npm run lint` y `npm run format:check`: en verde.
- Las capturas regeneradas de `docs/qa/capturas` se restauraron con `git checkout`.

## Fallos nuevos

Ninguno.
