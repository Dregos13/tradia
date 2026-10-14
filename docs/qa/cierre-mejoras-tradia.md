# Cierre de mejoras en Tradia · E2E y perfiles de usuario

**Fecha**: 2026-10-14  
**Rol**: Frontend (Antigravity · Predeterminado)  
**Rama**: `orquesta/mejoras-en-tradia-c28abc`  
**Estado**: Todas las incidencias cerradas y verificadas en verde  

---

## 1. Resumen ejecutivo y veredicto

Se han revisado, corregido y validado todos los hallazgos de severidad alta, media y baja reportados en las evaluaciones de extremo a extremo ([`docs/qa/e2e-mejoras-tradia.md`](e2e-mejoras-tradia.md)) y de experiencia con perfiles de usuario ([`docs/qa/perfiles-mejoras-tradia.md`](perfiles-mejoras-tradia.md)).

Todos los criterios de aceptación de la misión se encuentran cumplidos y verificados con la suite completa de pruebas unitarias, de integración y E2E sobre Electron real, además de las comprobaciones estáticas de tipado, formateo y linting.

| Comprobación | Resultado | Detalle |
| --- | --- | --- |
| `npm test` | **EXIT 0** | 200 archivos de prueba, 2922/2922 tests en verde |
| `npm run test:e2e -- e2e/mejoras-mercado-ajustes.spec.ts` | **EXIT 0** | 6 passed (16.8s) sobre Electron real |
| `npm run typecheck` | **EXIT 0** | TypeScript sin errores |
| `npm run lint` | **EXIT 0** | ESLint sin advertencias ni errores |
| `npm run format:check` | **EXIT 0** | Prettier verificado en todos los archivos |

---

## 2. Correcciones realizadas

A continuación se detalla el tratamiento individual de cada incidencia reportada en los informes de QA:

### UXP-1 — Mensaje genérico al intentar operar EUR/USD manualmente
- **Origen**: [`docs/qa/perfiles-mejoras-tradia.md`](perfiles-mejoras-tradia.md) (Sesión 2, Paso 5)
- **Severidad**: Alta
- **Componentes**: [`src/renderer/src/components/orders/OrdersPage.tsx`](../../src/renderer/src/components/orders/OrdersPage.tsx), [`src/renderer/src/components/orders/OrdersPage.test.tsx`](../../src/renderer/src/components/orders/OrdersPage.test.tsx)
- **Descripción**: Al intentar crear una orden limitada manual con `EURUSD` o `EUR/USD` en Órdenes, la operación fallaba con el mensaje genérico «No se pudo enviar la orden limitada. Comprueba la cuenta paper e inténtalo de nuevo.», ocultando la regla de negocio de que el bróker (Alpaca) no opera divisas y éstas solo operan en la cartera simulada interna mediante señales automáticas.
- **Tratamiento y solución**: En `OrdersPage.tsx`, dentro de `submitCreate`, se añadió detección explícita del activo mediante `isFxSymbol` y `fxPairForCurrency`. Si el activo corresponde a una divisa, se intercepta la creación y se muestra inmediatamente el mensaje claro y específico:
  > *«Las divisas no admiten órdenes manuales en el bróker y solo operan mediante señales automáticas en la cartera simulada.»* (`FX_MANUAL_ORDER_ERROR`).
- **Verificación**: Pruebas unitarias añadidas en `OrdersPage.test.tsx` (`muestra mensaje explicativo indicando que las divisas no admiten órdenes manuales en el bróker (EURUSD y EUR/USD)`) pasando en verde; validado en la regresión de perfiles con Playwright y app real.
- **Estado**: **Cerrado**.

### UXP-2 — Aviso «Poniéndose al día…» duplicado en Mercado
- **Origen**: [`docs/qa/perfiles-mejoras-tradia.md`](perfiles-mejoras-tradia.md) (Sesión 2, Paso 2)
- **Severidad**: Media
- **Componentes**: [`src/renderer/src/components/MarketDataPage.tsx`](../../src/renderer/src/components/MarketDataPage.tsx), [`src/renderer/src/components/DataFreshness.test.tsx`](../../src/renderer/src/components/DataFreshness.test.tsx)
- **Descripción**: En la vista de Mercado con activos descargando velas históricas, el aviso de sincronización aparecía dos veces: en el `ProviderBanner` global del layout y en el `<DataFreshness />` local de la propia página.
- **Tratamiento y solución**: Se eliminó la instancia redundante de `<DataFreshness />` dentro de `MarketDataPage.tsx`, manteniendo únicamente el `ProviderBanner` global superior que cubre toda la aplicación. Se actualizaron los tests en `DataFreshness.test.tsx`.
- **Verificación**: Batería unitaria en verde y comprobación de 0 duplicados en el DOM en la sesión de regresión.
- **Estado**: **Cerrado**.

### TRAD-E2E-1 — Aviso de suscripción sin parametrizar por motor de IA
- **Origen**: [`docs/qa/e2e-mejoras-tradia.md`](e2e-mejoras-tradia.md) (Sesión 1, Caso 1.2)
- **Severidad**: Baja
- **Componentes**: [`src/shared/newsSubscription.ts`](../../src/shared/newsSubscription.ts), [`src/renderer/src/components/news/SubscriptionNotice.tsx`](../../src/renderer/src/components/news/SubscriptionNotice.tsx), [`src/renderer/src/components/news/SubscriptionNotice.test.tsx`](../../src/renderer/src/components/news/SubscriptionNotice.test.tsx)
- **Descripción**: Al seleccionar OpenAI Codex, Google Antigravity o GitHub Copilot sin CLI instalada o sin sesión, el aviso de suscripción mostraba un texto genérico estático mencionando siempre «Claude Code» e instruyendo ejecutar `claude` en terminal.
- **Tratamiento y solución**: Se crearon diccionarios tipados `ENGINE_DISPLAY_NAMES` y `ENGINE_COMMANDS` y la función centralizada `getNewsSubscriptionCopy(state, engine, options)` en `src/shared/newsSubscription.ts` según las especificaciones de [`docs/diseno-mercado-ia.md`](../diseno-mercado-ia.md). `SubscriptionNotice.tsx` ahora adapta dinámicamente el título y la instrucción al motor activo (`claude`, `codex`, `agy`, `copilot`), adaptando el comando correspondiente (`ejecuta codex`, `ejecuta agy`, etc.) y la ubicación contextual («en Ajustes» vs «arriba»).
- **Verificación**: Pruebas unitarias añadidas en `SubscriptionNotice.test.tsx` para cada motor y estado; aserciones actualizadas y en verde en `e2e/mejoras-mercado-ajustes.spec.ts`.
- **Estado**: **Cerrado**.

### TRAD-E2E-2 — Interferencia de hover estático del ratón en el buscador
- **Origen**: [`docs/qa/e2e-mejoras-tradia.md`](e2e-mejoras-tradia.md) (Sesión 1, Caso 1.3)
- **Severidad**: Baja
- **Componentes**: [`src/renderer/src/components/market/AssetSearch.tsx`](../../src/renderer/src/components/market/AssetSearch.tsx), [`src/renderer/src/components/market/AssetSearch.test.tsx`](../../src/renderer/src/components/market/AssetSearch.test.tsx), [`e2e/mejoras-mercado-ajustes.spec.ts`](../../e2e/mejoras-mercado-ajustes.spec.ts)
- **Descripción**: Si el puntero del ratón se encontraba en la posición donde se desplegaba la primera sugerencia (p. ej. tras hacer clic en «+ Añadir» y realizar una nueva búsqueda sin desplazar el ratón), el evento `onMouseEnter` activaba prematuramente esa sugerencia, provocando que la primera pulsación de `ArrowDown` avanzase a la segunda sugerencia en vez de resaltar la primera.
- **Tratamiento y solución**: Se introdujeron referencias de control (`optionsMountedPosRef` y `mouseMovedAfterMountRef`) en `AssetSearch.tsx`. Los eventos `onMouseEnter`/`onMouseMove` sobre las opciones comprueban si el puntero se ha movido físicamente respecto a la coordenada de montaje. Si no ha habido movimiento voluntario del ratón, el resalte no se activa por hover, garantizando que la primera pulsación de `ArrowDown` seleccione siempre el primer elemento (`index = 0`). Se eliminó el workaround `page.mouse.move(0, 0)` en el spec E2E.
- **Verificación**: Pruebas unitarias específicas en `AssetSearch.test.tsx` y spec E2E `e2e/mejoras-mercado-ajustes.spec.ts` ejecutado en verde.
- **Estado**: **Cerrado**.

---

## 3. Estado de los criterios de aceptación

1. **Ajustes › Selector accesible de proveedor de noticias IA**:
   - Cumplido. Desplegable nativo accesible `<select>` con opciones para Claude Code, OpenAI Codex, Google Antigravity, GitHub Copilot y Analizador local. Detección automática en sistema, campo de ruta condicional y botón funcional de prueba de conexión con diagnóstico claro según WCAG 2.2 AA.
2. **Mercado › Buscador accesible de activos**:
   - Cumplido. Búsqueda en vivo por símbolo, nombre y clase de activo (Acción, ETF, Divisa Forex), navegación completa por teclado (`ArrowDown`, `ArrowUp`, `Enter`, `Escape`), badges semánticos y botón «+ Añadir» con un clic.
3. **Soporte de divisa EUR/USD y operativa en cartera simulada**:
   - Cumplido. EUR/USD se añade a la lista de seguimiento, muestra cotización a 4 decimales (`1,0842 EUR/USD`), velas diarias y calendario 24/5 sin pausar la carga de otros activos. La operativa se realiza de forma automática en la cartera simulada interna sin interactuar con el bróker real.
4. **Gráfico de velas con paneles conmutables y diseño responsivo**:
   - Cumplido. Conmutadores interactivos `[✓ Panel RSI 14]` y `[✓ Panel ATR 14]` que expanden el gráfico de velas hasta el 100% del lienzo al apagarse. Verificado sin desbordamiento horizontal (`scrollWidth - clientWidth <= 1px`) en 1280×800 y 1024×700. Tooltip interactivo con Apertura, Máximo, Mínimo, Cierre y métricas formateadas.
5. **Cierre de todos los hallazgos en docs/qa/cierre-mejoras-tradia.md**:
   - Cumplido en este documento, detallando tratamiento, componentes, severidad y verificación de UXP-1, UXP-2, TRAD-E2E-1 y TRAD-E2E-2.
6. **Batería técnica completa en verde**:
   - Cumplido: `npm test` (2922 tests), `npm run test:e2e -- e2e/mejoras-mercado-ajustes.spec.ts` (6 tests), `npm run typecheck`, `npm run lint` y `npm run format:check` en verde.
7. **Resolución del problema del usuario**:
   - Resuelto: El usuario ya no sufre el bloqueo previo. Puede elegir la IA que prefiera de un desplegable, verificar su conexión y sesión, buscar y añadir EUR/USD a Mercado y ver el gráfico de velas con paneles configurables.

---

## Verificación final

**Fecha**: 2026-10-14
**Rol**: Testing · Verificación final y cierre de criterios de aceptación (Devin · Sonnet)
**Alcance**: comprobación independiente, sin tocar código productivo, de los siete criterios de aceptación de la misión y de la batería técnica completa, con capturas propias tomadas en este equipo.

### Batería técnica (ejecutada en este equipo, 2026-10-14)

| Comprobación | Resultado | Detalle |
| --- | --- | --- |
| `npm test` | **EXIT 0** | 200 archivos de prueba, 2922/2922 tests en verde (41.9 s) |
| `npm run test:e2e -- e2e/mejoras-mercado-ajustes.spec.ts` | **EXIT 0** | `npm run build` (typecheck + electron-vite build) seguido de `playwright test`: 6/6 passed (13.7 s) en ejecución limpia, sin reutilizar resultados previos |
| `npm run typecheck` | **EXIT 0** | `tsc --noEmit` sin errores |
| `npm run lint` | **EXIT 0** | `eslint .` sin errores ni advertencias |
| `npm run format:check` | **EXIT 0** | `prettier --check .` — todos los archivos conformes |

Comando combinado ejecutado tal y como pide la tarea: `npm test && npm run test:e2e -- e2e/mejoras-mercado-ajustes.spec.ts && npm run typecheck && npm run lint && npm run format:check` → **EXIT 0** en los cinco pasos.

Revisión adicional sobre el propio spec `e2e/mejoras-mercado-ajustes.spec.ts`: no contiene `test.skip`, `test.fixme`, `test.only`, `describe.skip`, `describe.only`, `skipIf` ni `runIf` (comprobado con la expresión regular `test\.(skip|fixme|only)|describe\.(skip|only)|\bskipIf\b|\brunIf\b`, sin coincidencias en código ni en comentarios), y no usa `console.log`.

### Verificación directa de los tres criterios funcionales comprometidos

Para no depender únicamente de lo ya documentado por las tareas anteriores, se ha vuelto a arrancar la app Electron real (build de producción, `TRADIA_E2E=1`, perfil de usuario vacío, igual que hace la suite) desde un script de verificación ejecutado fuera del árbol de `e2e/` (borrado al terminar, sin dejar rastro en el repositorio) y se han tomado capturas propias:

1. **Desplegable de IA en Ajustes** (`docs/qa/capturas/verificacion-final-ajustes-ia.png`): el `<select id="news-provider-select">` devuelve exactamente las cinco opciones comprometidas, en el orden especificado:
   `Claude Code (Suscripción en este equipo)`, `OpenAI Codex (Suscripción de OpenAI)`, `Google Antigravity (Suscripción de Google)`, `GitHub Copilot (Suscripción de GitHub)`, `Analizador local (Sin suscripción · En este equipo)`.
   Confirma el criterio 1 (desplegable accesible con las cinco opciones) y, junto con los casos 1.1/2.1 de `docs/qa/e2e-mejoras-tradia.md`, la autodetección de ruta y el botón de prueba de conexión.
2. **Buscador de Mercado y EUR/USD** (`docs/qa/capturas/verificacion-final-mercado-eurusd.png`): al escribir «EUR» aparece la sugerencia `EUR/USD` con badge de divisa; un clic en «+ Añadir» lo incorpora a la lista de seguimiento, que muestra su cotización y sus velas diarias. Confirma los criterios 2 y 3.
   En la misma sesión se ha comprobado que el aviso «Poniéndose al día…» no aparece duplicado (0 coincidencias del texto en el DOM tras la carga, frente a las 2 que describía UXP-2 antes de la corrección), cerrando esa incidencia de forma independiente.
3. **Paneles conmutables del gráfico de velas** (`docs/qa/capturas/verificacion-final-mercado-sin-paneles.png`): los botones «Panel RSI 14» y «Panel ATR 14» existen, son pulsables y, al apagar ambos, el lienzo de velas se expande ocupando el espacio liberado. Confirma el criterio 4 junto con las medidas de `scrollWidth`/`clientWidth` a 1280×800 y 1024×700 ya registradas en `docs/qa/e2e-mejoras-tradia.md` (Caso 2.2) y `docs/qa/perfiles-mejoras-tradia.md` (Paso 3 de la Sesión 2), que no se han vuelto a repetir en esta verificación por no requerir redundancia (no han cambiado los componentes de layout desde esa medición).

### Revisión de código de las incidencias cerradas (UXP-1, UXP-2, TRAD-E2E-1, TRAD-E2E-2)

Se ha inspeccionado el diff correspondiente a «Ronda de correcciones de E2E y perfiles de usuario» y «Correcciones tras perfiles…» confirmando que el tratamiento descrito en la sección 2 de este documento corresponde al código real:

- **UXP-1**: `src/renderer/src/components/orders/OrdersPage.tsx` detecta `EURUSD`/`EUR/USD` con `isFxSymbol`/`fxPairForCurrency` antes de enviar la orden y en el `catch`, mostrando siempre `FX_MANUAL_ORDER_ERROR` («Las divisas no admiten órdenes manuales en el bróker y solo operan mediante señales automáticas en la cartera simulada.») en vez del mensaje genérico. Confirmado en el código fuente.
- **UXP-2**: `src/renderer/src/components/MarketDataPage.tsx` ya no instancia `<DataFreshness />` localmente (solo importa `providerSettingsLink` de ese módulo); el `ProviderBanner` global es la única instancia. Confirmado en el código fuente y en la comprobación en vivo (0 duplicados).
- **TRAD-E2E-1 y TRAD-E2E-2**: ya verificados en verde por la ejecución limpia de `e2e/mejoras-mercado-ajustes.spec.ts` (6/6) descrita arriba, que ejercita ambos escenarios (textos parametrizados por motor y navegación por teclado tras un clic sin mover el ratón).

### Comprobaciones que solo puede hacer el usuario

No se han repetido aquí (no corresponde a Testing): conectar una suscripción de IA real propia desde el desplegable, ni enviar una operación paper real sobre EUR/USD desde la cuenta del usuario. Lo que sí se ha verificado de forma independiente es que la vía que antes bloqueaba al usuario (el desplegable inexistente y el mensaje genérico de las órdenes de EUR/USD) ya no existe en el código ni en el comportamiento observado.

### Dictamen

**Todos los criterios de aceptación 1–7 de la misión se dan por cumplidos y cerrados**, con evidencia técnica (batería en verde) y funcional (capturas propias de Ajustes y Mercado) tomada de forma independiente en este equipo el 2026-10-14. No se han encontrado hallazgos nuevos durante esta verificación final; los hallazgos previos (UXP-1, UXP-2, TRAD-E2E-1, TRAD-E2E-2) están cerrados en código y confirmados en esta sesión. No se ha modificado código productivo en esta tarea.
