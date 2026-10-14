# E2E: ticker sin cobertura y conectores

Spec: `e2e/ticker-sin-cobertura.spec.ts` (app Electron real, proveedor simulado de `TRADIA_E2E`, que nace con EUR sin cobertura). Reloj de mercado anclado al martes 2026-10-06.

## Resultados

| Caso                                                                                                                                                                     | Resultado                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------- |
| 1. Añadir `eur` → rechazo «Tiingo no ofrece datos para EUR» con «Añadir EUR/USD (divisa)» y «Cambiar por FXE», lista intacta, sin aviso de datos → «Cambiar por FXE» con teclado → FXE con más de 250 velas | Pasa                            |
| 2. EUR heredado: aviso solo de EUR, SPY «fiable», régimen/predicciones/señales sin pausa → «Quitar de la lista» con teclado → el aviso desaparece                          | Pasa tras corregir H1 (ver «Estado tras la ronda de correcciones») |
| 3. «Actualizar ahora» con fallo parcial → «Actualizados 1 de 2 · sin datos: EUR», nunca «Datos actualizados.»                                                              | Pasa                            |
| 4. Ajustes › Conectores: Tiingo «Funciona» + EUR sin cobertura; «Clave no válida» + EUR sin cobertura, «Cómo arreglarlo», enlace a la cuenta, foco en el campo; FRED aparte | Pasa                            |

Comandos (estado en la entrega, antes de las correcciones):

- `npm run build && npx playwright test e2e/ticker-sin-cobertura.spec.ts`: 3 de 4 pasan; el caso 2 falla siempre por H1, así que no se pudo hacer la tirada de 3 repeticiones en verde.
- `npm run test:e2e` completo: **66 pasan, 1 falla** (el caso 2 de esta spec). Ninguna otra spec falla.
- `npm run format:check`: en verde.

Preparación de los casos 2-4 (un EUR que ya estaba en la lista): se siembra EUR con `TRADIA_E2E_UNCOVERED_TICKERS=''`, se reabre la app con la lista por defecto y se adelanta el reloj un día para que se pida la vela nueva de EUR. Sin ese día, EUR ya tiene velas y nunca se pide, así que no se detecta que no tiene cobertura.

Limitación del caso 3: el estado «desactualizado» de SPY es real (proveedor caído + un cierre más), pero después se congela el resumen por IPC (como `data-uncovered-banner.spec.ts`), porque al apagar el fallo la app se recupera sola y el botón «Actualizar ahora» desaparece. La actualización que lanza el botón sí es real.

## Estado tras la ronda de correcciones

- **H1:** corregido en `7eefc97e`. `removeWatchlistTicker` borra la fila `ticker:X` y `freshness()` solo cuenta los activos de la lista. El caso 2 pasa.
- **H2:** corregido. Con un activo sin cobertura se corrigió en `54e8337b`. Con datos atrasados, el bloque en línea queda como un chip sin acciones (`fe-correcciones-pruebas`).
- **H3:** descartado, porque es un texto del proveedor simulado que la interfaz no muestra.

El detalle está en [`cierre-tiingo-claridad.md`](cierre-tiingo-claridad.md). Lo que sigue es el informe original.

## Verificación final (auditoría del 2026-10-14)

Revisión a fondo de la entrega provisional sobre el código final de la rama, con las correcciones de H1-H3 ya integradas:

- `npm test`: **203 archivos, 3060 pruebas en verde**.
- `npm run lint`, `npm run typecheck`, `npm run format:check`: **en verde**.
- `npm run test:e2e` completo: **71 pruebas pasan, 0 fallan** (9,9 min); los 7 tests de esta spec incluidos.
- `npx playwright test e2e/ticker-sin-cobertura.spec.ts`: 7/7 en tres pasadas tras el ajuste de abajo.

Corrección aplicada en la auditoría: en una de las pasadas aisladas el rearranque de `openWithLegacyEur` (reuso del mismo `userData`, con el bloqueo de instancia única y el arranque pesado de servicios) superó una vez los 30 s sin llegar a «Estado del sistema». No es un fallo del producto (la instancia no estaba corrupta: repitiendo el caso pasa siempre), pero hacía inestable la spec: las dos esperas de arranque tras `relaunchPhaseApp` pasan de 30 s a 60 s. No se relajó ninguna aserción del producto ni se corrigió código de producción.

Pendiente del usuario: clave real de Tiingo, `npm run qa:providers` con ella y la revisión visual del instalador (`npm run dist:mac`).

## Hallazgos (por severidad)

### H1 · Alta · backend: tras «Quitar de la lista» el aviso de EUR no desaparece

- Pasos: lista con SPY y EUR heredado; adelantar un día el reloj; en Mercado pulsar «Quitar EUR de la lista».
- Esperado: la lista queda en SPY y el aviso «EUR no está disponible en Tiingo» desaparece.
- Obtenido: `watchlist.list()` devuelve `['SPY']` y aparece «EUR se ha quitado de tu lista.», pero `dataStatus.freshness().uncovered` sigue con EUR y el aviso permanece 6 s después y en las pasadas siguientes. Queda la fila `ticker:EUR` en `data_status` con estado `sin-cobertura`.
- Causa probable: `src/main/market/health.ts` (~línea 915) arma `uncovered` con todas las filas `ticker:*` de `data_status`, no solo con las de la lista actual; `removeTicker` (`ingestion.ts` ~1021) no borra la fila. Conectores sí lo hace bien porque usa `listWatchlist()`.
- Evidencia: `e2e/ticker-sin-cobertura.spec.ts`, caso 2, `expect(banner).toHaveCount(0)`; `docs/qa/e2e-ticker-sin-cobertura.md`.
- Efecto: el criterio 2 de la misión («Quitar de la lista» resuelve el aviso) no se cumple de extremo a extremo. Los specs previos no lo veían porque republicaban el resumen a mano.

### H2 · Media · frontend: el aviso de datos aparece dos veces en Mercado

- Pasos: con EUR sin cobertura (o datos desactualizados) abrir Mercado.
- Esperado: un solo aviso con sus acciones.
- Obtenido: el panel lateral «Avisos del mercado» y el grupo «Frescura de datos» dentro de «Datos de mercado» repiten el aviso entero: dos «Quitar EUR de la lista», dos «Cambiar por FXE…» y dos «Actualizar ahora». Los lectores de pantalla lo leen dos veces y el orden de Tab se duplica. Los locators por rol dan «strict mode violation» si no se acotan a la región «Estado de los datos».
- Evidencia: `test-results/*/error-context.md` del caso 2 (instantánea de accesibilidad, refs e34 y e59).

### H3 · Baja · frontend/backend: texto técnico en `reason` de Conectores y resumen

- `watchlist.coverage()` y `freshness().uncovered[].reason` devuelven «ticker 'EUR' no existe», mientras el aviso dice «EUR no está disponible en Tiingo». Hoy la interfaz usa su propio texto, pero cualquier pantalla que muestre `reason` lo enseñaría en bruto y con una frase que no es cierta (EUR sí existe como acción en otros orígenes).

### Observaciones (sin fallo)

- Conectores sin activos sin cobertura mantiene el título «Activos de tu lista sin cobertura» seguido de «No hay activos marcados sin cobertura.»: se entiende, aunque el título afirma lo contrario.
- Con el proveedor caído, EUR pasa a «desactualizado» como el resto (no «sin cobertura»): correcto, el fallo es del proveedor.
- Teclado: Tab desde «Cambiar por FXE para EUR» llega a «Quitar EUR de la lista»; Enter activa; «Revisar la clave» devuelve el foco al campo. Contraste, zoom y ventanas estrechas los cubren `data-uncovered-banner.spec.ts` y `provider-connection.spec.ts` (en verde).
- No se probó con claves ni red reales de Tiingo: queda para el usuario.
