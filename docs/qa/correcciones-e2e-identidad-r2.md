# Correcciones E2E de la identidad · ronda 2

Rama `orquesta/renovar-la-identidad-visual-logo-paleta-edcd49`, sobre el resultado de `fix-1` (legibilidad), `fix-1-2` (retirada del registro) y «Restaurar el cableado del buscador de Mercado». Los hallazgos son los de `docs/qa/e2e-identidad.md`. Ningún texto, rol ni selector de las specs existentes cambia; la única edición en una spec existente son dos colores de fondo (ver IDV-E2E-4).

## Estado de partida

Antes de tocar nada se comprobó qué había resuelto el trabajo anterior:

| Id | Estado al empezar |
| --- | --- |
| IDV-E2E-1 | Cableado del buscador restaurado, pero el fallo persistía: el desplegable seguía abierto sobre el aviso. |
| IDV-E2E-2, 3, 4, 5, 6 | Sin resolver (ya fallaban en el origen `e58032fa`). |
| IDV-E2E-7, 8 | Resueltos por `fix-1`; se vuelven a medir a 1120 px, el ancho que citan los hallazgos. |

## Resultado por hallazgo

| Id | Causa | Corrección | Evidencia |
| --- | --- | --- | --- |
| IDV-E2E-1 | Al enviar «EUR» el desplegable de sugerencias seguía abierto (o se reabría al volver el foco y al llegar los resultados de la búsqueda repuesta) y quedaba sobre el aviso con «Añadir EUR/USD (divisa)»; `search-item-VGK` interceptaba el clic. | `AssetSearch.tsx`: un envío (Enter o «Añadir») cierra el desplegable y recuerda el texto enviado; ni el foco ni los resultados lo reabren hasta que se escribe otra cosa o se pulsa ↓/↑. La captura de la posición del ratón y el resalte con `onMouseEnter` no cambian. | `e2e/fx-paper-portfolio.spec.ts:69` pasa (clic y alta); `e2e/mejoras-mercado-ajustes.spec.ts:303` sigue con ratón y teclado (flecha + Enter). Unitaria: `AssetSearch.test.tsx` «IDV-E2E-1». |
| IDV-E2E-2 | La pasada de identidad incluyó `.orders-reconcile` en la regla de carriles (`border: 0; border-top only; padding-inline: 0`). | `orders.css`: la conciliación sale de esa regla y conserva su caja de 1 px por los cuatro lados, relleno de 24 px y ancho de la pila. Fondo `surfaceSubtle` (carril tenue), radio pequeño y **sin sombra**: los demás bloques de Órdenes siguen en carriles. | `e2e/layout-espaciado.spec.ts:597` pasa a 1280×800 y 1024×700. Regresión nueva `IDV-E2E-2` en `e2e/identidad-correcciones-r2.spec.ts` (borde `1px` ×4, relleno 24 px, `box-shadow: none`, ancho = pila) y capturas `capturas/identidad-correcciones-r2/ordenes-{1280,1024}-{claro,oscuro}.png`. |
| IDV-E2E-3 | La fila de la lista mostraba «Divisa · 24/5 · cartera simulada» en un solo elemento; no había una etiqueta «Divisa» propia. | `assetPresentation.ts` separa `FX_CLASS_LABEL` («Divisa») y `fxDetail` (`fxLabel` los une igual que antes). `Watchlist.tsx` pinta `<span class="market-asset-class-name">Divisa</span>` seguido del texto « · 24/5 · cartera simulada» en el mismo contenedor, así que la descripción accesible sigue siendo «Divisa · 24/5 · cartera simulada». | `e2e/mejoras-mercado-ajustes.spec.ts:303` (`getByText('Divisa', { exact: true })`) y `fx-paper-portfolio.spec.ts` (descripción accesible) pasan. Unitaria: `Watchlist.test.tsx`. |
| IDV-E2E-4 | El título del aviso era «Suscripción no disponible · No hay una sesión iniciada en Claude Code.»; el texto contractual es «Suscripción no disponible · sesión no iniciada». | `newsSubscription.ts`: el título es el texto contractual y «No hay una sesión iniciada en {CLI}. Abre un terminal, {cómo iniciar sesión}. Vuelve aquí y prueba de nuevo. Mientras tanto, las noticias se analizan con el analizador local.» pasa al detalle. Para Claude Code el paso es «ejecuta claude y después /login» (como `loginHint` del proceso principal); para las demás CLI se mantiene «ejecuta {cmd} para iniciar sesión». | `news-sentiment.spec.ts:213` y `:317` pasan. Unitaria: `SubscriptionNotice.test.tsx` «IDV-E2E-4». Además, ese recorrido fijaba dos fondos del aviso de la paleta anterior (`rgb(75, 28, 38)` y `rgb(251, 228, 231)`); ahora comprueba los de la identidad, `state.critical` `#3A1519` y `#FBE3E5`. |
| IDV-E2E-5 | «Análisis de noticias» solo tenía el desplegable de motores; el recorrido espera dos `radio`. | `AiSettings.tsx`: grupo «Origen del análisis» con dos radios funcionales, «Suscripción (<CLI>)» y «Analizador local», sincronizados con el desplegable (que conserva sus cinco opciones, su nombre y su valor). El radio de suscripción nombra la CLI elegida o autodetectada (por defecto Claude Code) y la recuerda al alternar. Sin claves ni API de pago. `AiSettings.test.tsx` ya no afirma «ningún radio» (era un sustituto de «sin API de pago»): ahora exige exactamente esos dos y mantiene que no hay «Clave de API» ni «Tope mensual». | `news-sentiment.spec.ts:317` pasa (`toHaveCount(2)`, `.check()` de la suscripción). Regresión `IDV-E2E-5` (claro y oscuro) y captura `ajustes-radios-{claro,oscuro}.png`. Unitaria: `AiSettings.test.tsx` «IDV-E2E-5». |
| IDV-E2E-6 | El aviso de datos de IA estaba dentro de un `div[data-layout-block="frescura"]`, así que `.data-freshness-container` no era hijo directo de `.ai-page` (`.ai-page > .data-freshness-container`). | `DataFreshness` acepta `layoutBlock` y pone `data-layout-block` en su propio contenedor; `AiPage.tsx` quita el envoltorio. Mismo bloque medible para `layout-espaciado`, sin el `div` intermedio. | `e2e/stale-data.spec.ts:237` pasa («Sin conexión · datos del 6 oct 2026…»); `layout-espaciado` sigue en verde. |
| IDV-E2E-7 | Resuelto por `fix-1` (la mono ya no se aplica a nombre y descripción; Sora en la biblioteca). | Sin cambios de código en esta ronda; se vuelve a medir. | Regresión `IDV-E2E-7` a 1120 × 688 en ambos temas: sin celdas recortadas, sin desplazamiento horizontal. Capturas `estrategias-1120-{claro,oscuro}.png`. |
| IDV-E2E-8 | Resuelto por `fix-1` (la barra se reparte en líneas y usa etiquetas cortas por debajo de 1200 px). | Sin cambios de código en esta ronda; se vuelve a medir. | Regresión `IDV-E2E-8` a 1120 × 688 en Inicio, Mercado y Riesgo: «En línea» y «Agentes activos» completos, ningún elemento de la barra con `scrollWidth > clientWidth`. Capturas `barra-estado-1120-{claro,oscuro}.png`. |

## Archivos

`src/renderer/src/`: `components/market/AssetSearch.tsx`, `Watchlist.tsx`, `market.css`; `components/assetPresentation.ts`; `components/orders/orders.css`; `components/settings/AiSettings.tsx`, `settings.css`; `components/DataFreshness.tsx`; `components/ai/AiPage.tsx`; `src/shared/newsSubscription.ts`. Pruebas: `AssetSearch.test.tsx`, `Watchlist.test.tsx`, `AiSettings.test.tsx`, `SubscriptionNotice.test.tsx`, `e2e/identidad-correcciones-r2.spec.ts` (nueva) y los dos colores de `e2e/news-sentiment.spec.ts`.

## Comprobaciones

- `npm run typecheck`, `npm run lint`, `npm run format:check`: correctos.
- `npm test`: 215 ficheros, 3290 pruebas, correctas.
- Specs de los hallazgos: `fx-paper-portfolio`, `mejoras-mercado-ajustes`, `news-sentiment`, `stale-data`, `layout-espaciado`, `identidad-legibilidad`, `identidad-visual` e `identidad-correcciones-r2`, todas en verde.
- `npm run test:e2e` completo (build + Playwright): **126 pasan, 0 fallan** (8,6 min). Antes: 99 pasan, 7 fallan.
