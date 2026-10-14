# Revisión de EUR/USD, datos y Conectores

Revisión del trabajo provisional `2dee469d`, contrastada con el código vigente y los criterios de la misión. Se mantiene Electron, el sistema de diseño existente y los contratos IPC. No se añaden proveedores, endpoints ni APIs de IA.

## Correcciones

- `DataProvidersSettings.tsx` consulta la frescura después de actualizar Tiingo o FRED. Una respuesta correcta del proveedor ya no permite anunciar «Datos actualizados.» si EUR sigue sin cobertura. Si falla la comprobación, el mensaje indica que espera datos verificados. La actualización evita peticiones duplicadas y conserva el foco al terminar. Un evento posterior de cambio de datos retira el éxito anterior, para que no quede visible con un nuevo fallo.
- `DataFreshness.tsx` exige un resumen verificado antes de anunciar éxito total y nombra los activos pendientes cuando la descarga se completó pero su frescura no se recuperó.
- `SignalsBlock.tsx` elimina la afirmación de pausa global por cualquier estado agregado. El vacío nombra los tickers atrasados y explica que los demás siguen evaluándose. Las guardas reales comparan la sesión esperada por ticker en `signals/engine.ts`, `ai/prediction/service.ts` y `ai/regime/service.ts`; los estados del proveedor no son una guarda global de frescura.
- `PriceChart.tsx` configura cinco decimales y un paso mínimo de 0,00001 en las velas de divisas. Antes el resumen textual tenía cinco decimales, pero la serie del gráfico heredaba dos.
- La descripción de Tiingo en Conectores incluye los pares de divisas 24/5 que la aplicación ya admite.

## Comprobación del alcance

- EUR se rechaza sin modificar la lista y ofrece EUR/USD y FXE. El par se normaliza al formato del contrato y se presenta como EUR/USD.
- Las señales de EUR/USD conservan la decisión de Riesgo y su destino en la cartera simulada. Los pares cotizados en otra moneda siguen como solo análisis. Tamaño en moneda base, precio y P&L en USD para los pares operables.
- Órdenes bloquea las divisas antes de enviarlas al bróker; el bloqueo del proceso principal sigue siendo independiente.
- Los activos sin cobertura se separan de los estados agregados en `market/health.ts`; el aviso conserva quitar, cambiar por FXE y el detalle que explica cómo añadir EUR/USD. No se añade otra acción de sustitución al contrato de ese aviso.
- Los conectores muestran estado, última comprobación y siguiente paso; la cobertura de la lista distingue cubierta, pendiente y sin cobertura.
- Se revisaron las capturas existentes y las reglas CSS. Se conservan colores, tamaños y foco de los tokens del proyecto. Se añaden pruebas de contraste sRGB para las superficies y estados de avisos y conectores en ambos temas.

## Pruebas añadidas

Vitest cubre éxito parcial en ambos conectores, fallo de verificación posterior, nombres de activos pendientes, vacío de señales por activo, precisión de la serie y contraste AA. `connector-refresh-freshness.spec.ts` comprueba por IPC real ambos conectores, activación con Enter, resultado parcial y conservación del foco.

## Verificación

- `npm install && npm test`: instalación correcta; repetición final de Vitest en verde, 204 archivos y 3076 pruebas.
- En una ejecución intermedia concurrente hubo cinco fallos por tiempo/foco en Ingesta, App, Onboarding y Estrategias. La repetición completa con menor carga pasó sin cambiar esas pruebas, sus límites ni la configuración.
- `npm run lint`, `npm run typecheck` y `npm run format:check`: en verde.
- `npm run test:e2e`: aplicación reconstruida y 73 pruebas en verde, incluidas las dos nuevas de Conectores (6,4 minutos).
- Las capturas regeneradas por Playwright se devuelven a su estado anterior a estas dos auditorías; la evidencia de EUR/USD de esta ejecución queda en `test-results/fx-paper-*.png`.
