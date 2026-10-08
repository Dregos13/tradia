# QA — Fase 1 · Datos de mercado

**Fecha:** 2026-10-08  
**Entorno:** macOS 27.0 (Apple Silicon arm64), Node.js v24.21.0, npm 11.19.0.  
**Modo:** Electron con almacén temporal limpio, `TRADIA_E2E=1` y proveedor simulado. Las consultas de conectividad usaron un servidor local de prueba; no se usaron claves ni datos de mercado reales.

## Resultado de los criterios de aceptación

| # | Criterio | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Contrato de proveedor, Tiingo (grabaciones, HTTP 401/429/5xx y límites de uso) y adaptador simulado | **APROBADO** | `npm test`: 39 archivos y 388 pruebas aprobadas. Pruebas en `src/main/market/providers/contract.test.ts`, `tiingo.test.ts`, `rateLimiter.test.ts` y `simulated.test.ts`. |
| 2 | Ajustes por splits y dividendos; huecos, duplicados, anomalías y versiones de lote | **APROBADO** | `npm test`: pruebas de AAPL 4:1 (31-08-2020), NVDA 10:1 (10-06-2024), dividendos, huecos, duplicados y valores inválidos/anómalos en `src/main/market/cleaning/clean.test.ts`; versiones en `version.test.ts`. |
| 3 | Actualización sin intervención tras cierre NYSE, con conversión a Madrid y desfases DST | **APROBADO** | `npm test`: integración del flujo de datos con reloj simulado en `src/main/market/__integration__/data-flow.test.ts`; calendario/ingesta en semanas de desfase de marzo y finales de octubre en `calendar.test.ts` e `ingestion.test.ts`. |
| 4 | Añadir ticker, ver velas de varios años e indicadores y quitarlo | **APROBADO** | `npm run test:e2e`: 9 pruebas aprobadas. El caso `e2e/market-chart.spec.ts` valida más de 750 velas, SMA 20/50/200, RSI, ATR, tabla OHLCV, rango, entrada larga, ventana estrecha y retirada. Sesión Electron adicional añadió AAPL y MSFT, alternó la selección entre ambos y mostró sus gráficos. |
| 5 | Macro con tipos, IPC, curva 2/10 años y VIX con valor, fecha y frescura | **APROBADO** | `e2e/macro-context.spec.ts`: almacén limpio sin clave FRED y seis tarjetas con datos, fecha `time[datetime]`, estado y distintivo simulado; incluye DFF, CPIAUCSL, DGS2, DGS10, T10Y2Y y VIXCLS. |
| 6 | Fallo de proveedor: notificación y dato no fiable/desactualizado; calidad del build | **APROBADO en modo de prueba** | `e2e/market-chart.spec.ts` simula tres fallos, verifica banner, estado No fiable y llamada a notificación, y valida la recuperación. `npm run lint`, `npm run typecheck` y el build de `npm run test:e2e` terminaron sin errores. La prueba de notificación usa un espía de Electron; no acredita la presentación nativa del sistema operativo. |

### Ejecuciones

| Comando | Resultado |
| --- | --- |
| `npm test` | 39 archivos; 388/388 pruebas aprobadas. |
| `npm run test:e2e` | Build y typecheck incluidos; 9/9 pruebas E2E aprobadas. |
| `npm run lint` | Código de salida 0. |
| `npm run typecheck` | Código de salida 0. |
| `npm run build` | Ejecutado como parte de `npm run test:e2e`; código de salida 0. |

## Sesiones por perfil

### Profesional independiente que organiza varios proyectos — superada

1. Inicié Electron en modo de pruebas con datos temporales limpios, acepté el aviso y abrí Mercado.
2. Envié `NASDAQ-TOO-LONG` con Enter. Esperaba un error accesible que explicara el límite y que el texto siguiera en el campo; ambos se observaron.
3. Añadí AAPL y revisé las velas simuladas, más de 750 observaciones, rango de varios años, SMA 20/50/200, RSI, ATR y tabla OHLCV. Reduje la ventana a 700 px y comprobé que no hubiera desbordamiento horizontal.
4. En una sesión adicional añadí MSFT, comprobé ambos activos en la lista y alterné la selección MSFT → AAPL → MSFT. El ticker seleccionado cambió y el gráfico correspondiente apareció en cada caso.
5. Simulé tres fallos del proveedor; observé el banner, el estado No fiable y la llamada a la notificación. Restablecí el proveedor, confirmé la recuperación, avancé el reloj simulado hasta obtener una vela nueva y quité AAPL.

**Esperado:** poder crear y cambiar entre activos, consultar sus precios e indicadores, distinguir datos simulados/no fiables, recuperarse del error y quitar un ticker.  
**Observado:** pasos aprobados en las pruebas E2E y en la sesión Electron con dos activos. La notificación se comprobó como llamada simulada, no como aviso del Centro de notificaciones macOS.  
**Evidencia:** `e2e/market-chart.spec.ts`; salida de `npm run test:e2e` (9 aprobadas); sesión Electron adicional. Capturas: [lista con dos activos](capturas/mercado-dos-activos.png), [Mercado](capturas/mercado-amplio.png), [ventana estrecha](capturas/mercado-ventana-estrecha.png), [fallo de proveedor](capturas/proveedor-no-fiable.png), [vela nueva](capturas/mercado-vela-nueva.png).

### Responsable de equipo que revisa entregas — superada

1. Inicié la app de pruebas con almacén limpio y sin clave FRED; acepté el aviso y abrí Macro.
2. Revisé el estado sin configuración: aparecen las series simuladas sin solicitar una clave real.
3. Comprobé las seis series y que cada tarjeta tuviera valor, fecha de observación y estado de frescura; los valores no eran “Sin dato” y aparecía el distintivo “Datos simulados”.
4. Contrasté los criterios con la batería unitaria, la integración de calendario/ingesta, el E2E, lint, typecheck y build.

**Esperado:** los datos deben mostrar su procedencia, fecha y frescura, y el dato simulado/no fiable no debe confundirse con datos reales fiables.  
**Observado:** Macro muestra seis series con valor, fecha y estado; el estado simulado está identificado. Ante el fallo E2E de proveedor, el ticker queda marcado No fiable y se muestra el aviso. Todos los comandos indicados terminaron correctamente.  
**Evidencia:** `e2e/macro-context.spec.ts`; salida de `npm test` (388 aprobadas), `npm run test:e2e` (9 aprobadas), `npm run lint`, `npm run typecheck` y build. Capturas: [Macro sin clave](capturas/macro-sin-clave.png), [primera fila](capturas/macro-indicadores.png) y [segunda fila](capturas/macro-indicadores-segunda-fila.png); las pruebas verificaron las seis tarjetas y sus fechas.

## Hallazgos y límites

No se encontraron fallos reproducibles en los criterios evaluados. Las pruebas usan proveedores y reloj simulados; no verifican precios reales ni la notificación visible del sistema operativo. Quedan fuera de esta revisión y reservadas al usuario las comprobaciones de claves reales Tiingo/FRED, comparación de precios con una fuente pública, ejecución en segundo plano durante la noche, notificaciones nativas en macOS/Windows/Linux, instalables empaquetados y licencias/atribución.

## Referencias visuales

Las capturas adjuntas se generaron durante las sesiones de prueba; las vistas de cotizaciones e indicadores usan datos simulados, no son precios actuales ni evidencia de una fuente real.
