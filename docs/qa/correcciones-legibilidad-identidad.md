# Correcciones de legibilidad, jerarquía y composición de la identidad

Rama `orquesta/renovar-la-identidad-visual-logo-paleta-edcd49`. Solo CSS (más dos pruebas nuevas): ningún texto, rol, ruta ni lógica cambia.

## Decisión de jerarquía

El título dominante de cada pantalla es el `h1` de la barra superior (24 px, escala `xl`). El `h2` de cabecera pasa a subtítulo en la escala `lg` (18/26) y los títulos de sección y de carril quedan en `md` (16/24), como pide la guía para los títulos de carril. La relación es 24 › 18 › 16 en todas las pantallas; antes el `h2` de 36 px superaba al `h1`.

## Hallazgos y correcciones

| Id | Estado | Corrección | Evidencia |
| --- | --- | --- | --- |
| IDV-UXP-1 | corregido | `small { font-size: var(--type-xs) }` en `styles.css` (13 px; antes `smaller`: 10,8 y 11,7 px). | `e2e/identidad-legibilidad.spec.ts` «IDV-UXP-1» (Estrategias, Riesgo, Ajustes, claro y oscuro); `src/renderer/src/legibilidad-identidad.test.ts`. |
| IDV-UXP-2 | corregido | `.headline h2` y los `h2` de Estrategias (`strategies.css`), Riesgo (`risk.css`), IA (`ai.css`), Dinero real (`checklist.css`), Órdenes, Real vs backtest, Fuentes y «Primeros pasos» pasan a `lg`; los `h3` de carril de Inicio y los de sección de Riesgo, a `md`. La cabecera pone título y descripción en la misma línea y «Primeros pasos» es más compacto (`dashboard.css`). | Spec «IDV-UXP-2»: `h1` = 24 px y todo `h2` < 24 px en Inicio, Mercado, Estrategias y Ajustes, en ambos temas. Capturas en `docs/qa/capturas/identidad-correcciones/`. |
| IDV-UXP-3 | corregido | Fila de la lista de seguimiento en una línea (ticker a la izquierda, insignias a la derecha; `market.css`), columna de la lista de 252 a 300 px como máximo, cabecera del gráfico y barra de herramientas más compactas, «Añadir universo inicial» junto al campo y separaciones de Mercado de 24 px (el mínimo entre bloques). | Spec «IDV-UXP-3 e IDV-UXP-6» a 1440 × 900 con 25 activos y SPY: filas de 45 px (antes 152) y ≥ 150 px de gráfico visibles (el lienzo arranca en y ≈ 682 de 824). |
| IDV-UXP-4 | corregido | La barra de estado ya no recorta con puntos suspensivos: se reparte en líneas si hace falta y, por debajo de 1200 px, usa las etiquetas cortas existentes («Comprobado», «Reintento», «Latido») con las largas en el árbol accesible y en el `title`. | Spec «IDV-UXP-4 e IDV-E2E-8» a 1100 × 760 en Inicio y Riesgo: «En línea» y «Agentes activos» completos, sin recortes ni solapamientos. |
| IDV-UXP-5 | descartado por Orquestación | El oliva `#4A6500` es la tinta lima prescrita para el tema claro y cumple contraste. | — |
| IDV-UXP-6 | corregido | La ayuda de búsqueda ocupa la fila bajo el campo, alineada a su izquierda (rejilla de la barra de herramientas, `market.css`). `aria-describedby` no cambia. | Misma spec: `help.left` = `input.left` y `help.top` ≥ `input.bottom`. |
| IDV-UXP-7 | fuera de esta tarea | Lo cubre «Retirar el registro de búsqueda ajeno a la identidad» (backend). | — |
| IDV-E2E-7 | corregido | Causa: `:where(th) { font-family: mono }` ponía en Plex Mono el nombre y la descripción de cada estrategia y los rótulos de columna. En la tabla de la biblioteca pasan a Sora, con relleno lateral de 8 px y nombre mínimo de 128 px. A 1120 px caben las ocho columnas sin desplazamiento. | Spec «IDV-E2E-7» (`scrollWidth` = `clientWidth`). |
| IDV-E2E-8 | corregido | Igual que IDV-UXP-4. | Spec «IDV-UXP-4 e IDV-E2E-8». |
| IDV-E2E-1, 2, 3, 4, 5, 6 | no tocados aquí | No son de presentación: los cubren «Retirar el registro de búsqueda…» (IDV-E2E-1) y «Resolver los ocho hallazgos E2E pendientes de la identidad». | — |

## Comprobaciones

- `npm run typecheck`, `npm run lint`, `npm run format:check`: correctos.
- `npm test`: 214 ficheros, 3286 pruebas, correctas.
- `npx playwright test e2e/identidad-legibilidad.spec.ts`: 10/10 (5 casos × 2 temas).
- Medida de «antes» y «después» con la app real (1440 × 900 y 1100 × 760, ambos temas): ningún elemento por debajo de 13 px en Inicio, Mercado, Estrategias, Riesgo y Ajustes; antes, 10,8 y 11,7 px.
