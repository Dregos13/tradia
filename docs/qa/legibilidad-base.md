# Legibilidad base

Revisión del 13 de octubre de 2026. Se aplica la guía de claridad de datos del equipo a la base visual, conservando la identidad Cuaderno cuantitativo y la navegación existente.

## Cambios

- `base.tokens.json` pasa a ser la fuente efectiva de paleta, escala, espaciado y foco en `tokens.ts`; Mercado conserva sus colores específicos de gráficos y datos y sus tamaños de composición (incluido el ancho máximo existente de 1440 px).
- Base: 16/24 px → 16/24 px. Secundario: 14/20 → 15/22 px. Metadatos: 12/16 → 14/20 px. Encabezado principal: 34/40 → 32/40 px. Título de pantalla: 18/26 → 24/32 px. Títulos de tarjeta globales: 18/26 px.
- Texto tenue claro: #6A7280 → #566174. Superficie marcada clara: #DCD8CE → #E2DED5, para que el texto secundario siga siendo legible incluso en controles deshabilitados. El resto de colores de contenido ya cumplía AA.
- Barra lateral: #17233A / #F5F3ED en claro; #090F19 / #F4F5F7 en oscuro, según la guía.
- Foco común: 3 px sólidos con separación de 2 px. En navegación se usa el texto inverso de la barra lateral: el anillo queda sobre ese fondo incluso en el enlace seleccionado. En ventanas estrechas se añade espacio alrededor de los enlaces para evitar recortar el foco al desplazarse. Botones comunes: mínimo 44 × 44 px.

## Ratios medidos

Luminancia relativa sRGB de WCAG 2.2, calculada con los valores reales de los tokens, sin redondear para decidir el aprobado. Todos los pares de texto/fondo finales llegan a 4,5:1. El test recorre los pares declarados en la base y todos sus estados semánticos, incluidos los cuerpos de texto sobre fondos de estado. El «antes» de navegación corresponde a los colores aplicados por el CSS anterior, no a tokens que entonces no existían.

| Par | Claro antes | Claro después | Oscuro antes | Oscuro después |
| --- | ---: | ---: | ---: | ---: |
| text / canvas | 14.15:1 | 14.15:1 | 16.75:1 | 16.75:1 |
| text / surface | 15.55:1 | 15.55:1 | 15.15:1 | 15.15:1 |
| text / surfaceSubtle | 12.94:1 | 12.94:1 | 13.44:1 | 13.44:1 |
| text / surfaceStrong | 11.03:1 | 11.69:1 | 10.86:1 | 10.86:1 |
| text / accentSoft | 13.20:1 | 13.20:1 | 11.39:1 | 11.39:1 |
| textMuted / canvas | 5.64:1 | 5.64:1 | 10.06:1 | 10.06:1 |
| textMuted / surface | 6.20:1 | 6.20:1 | 9.10:1 | 9.10:1 |
| textMuted / surfaceSubtle | 5.16:1 | 5.16:1 | 8.07:1 | 8.07:1 |
| textMuted / surfaceStrong | 4.39:1 | 4.66:1 | 6.52:1 | 6.52:1 |
| textMuted / accentSoft | 5.26:1 | 5.26:1 | 6.84:1 | 6.84:1 |
| textFaint / canvas | 4.37:1 | 5.64:1 | 7.31:1 | 7.31:1 |
| textFaint / surface | 4.80:1 | 6.20:1 | 6.61:1 | 6.61:1 |
| textFaint / surfaceSubtle | 4.00:1 | 5.16:1 | 5.86:1 | 5.86:1 |
| textFaint / surfaceStrong | 3.41:1 | 4.66:1 | 4.74:1 | 4.74:1 |
| textFaint / accentSoft | 4.08:1 | 5.26:1 | 4.97:1 | 4.97:1 |
| sidebarText / sidebar | 14.15:1 | 14.15:1 | 16.75:1 | 17.60:1 |
| inverse / accent | 7.70:1 | 7.70:1 | 7.40:1 | 7.40:1 |
| inverse / accentHover | 10.28:1 | 10.28:1 | 10.16:1 | 10.16:1 |
| accent / surface | 7.63:1 | 7.63:1 | 6.69:1 | 6.69:1 |
| accent / accentSoft | 6.47:1 | 6.47:1 | 5.03:1 | 5.03:1 |
| online (etiqueta) / fondo de estado | 5.59:1 | 5.59:1 | 7.19:1 | 7.19:1 |
| online (cuerpo) / fondo de estado | 13.51:1 | 13.51:1 | 11.83:1 | 11.83:1 |
| offline (etiqueta) / fondo de estado | 5.51:1 | 5.51:1 | 6.54:1 | 6.54:1 |
| offline (cuerpo) / fondo de estado | 13.16:1 | 13.16:1 | 12.36:1 | 12.36:1 |
| paused (etiqueta) / fondo de estado | 5.68:1 | 5.68:1 | 8.12:1 | 8.12:1 |
| paused (cuerpo) / fondo de estado | 13.03:1 | 13.03:1 | 11.52:1 | 11.52:1 |
| info (etiqueta) / fondo de estado | 6.47:1 | 6.47:1 | 5.62:1 | 5.62:1 |
| info (cuerpo) / fondo de estado | 13.20:1 | 13.20:1 | 11.39:1 | 11.39:1 |
| alert (etiqueta) / fondo de estado | 5.49:1 | 5.49:1 | 8.49:1 | 8.49:1 |
| alert (cuerpo) / fondo de estado | 13.80:1 | 13.80:1 | 11.22:1 | 11.22:1 |
| critical (etiqueta) / fondo de estado | 6.22:1 | 6.22:1 | 6.39:1 | 6.39:1 |
| critical (cuerpo) / fondo de estado | 12.97:1 | 12.97:1 | 12.89:1 | 12.89:1 |
| success (etiqueta) / fondo de estado | 5.59:1 | 5.59:1 | 7.19:1 | 7.19:1 |
| success (cuerpo) / fondo de estado | 13.51:1 | 13.51:1 | 11.83:1 | 11.83:1 |

El foco común sobre superficie conserva 5,40:1 en claro y 8,45:1 en oscuro. El foco de navegación sobre barra lateral pasa de 2,88:1 a 14,15:1 en claro y de 9,34:1 a 17,60:1 en oscuro; supera el mínimo no textual de 3:1.

## Revisión y verificación

Pantallas revisadas: aviso inicial de riesgo, Inicio y Ajustes (General) en `npm run dev`, con perfil E2E limpio en macOS. Recorrido con Tab de toda la navegación hasta Ajustes y apertura con Enter; el foco vuelve al título de pantalla. Revisadas la jerarquía de títulos, el texto secundario y los metadatos heredados. Playwright recorre todos los enlaces en ambos temas y ventanas de 1280×800, 760×800 y 640×800, y comprueba `:focus-visible`, anillo de 3/2 px, tamaño mínimo y permanencia del enlace enfocado dentro de la ventana.

- `npx vitest run src/renderer/src/tokens.test.ts`: 62 pruebas en verde.
- `npm install && npm test`: en verde en el primer pase. Repetición final de `npm test` sin solapamiento: 197 archivos y 2.918 pruebas en verde.
- `npx playwright test e2e/legibility-base.spec.ts`: 2 pruebas en verde.
- `npm run typecheck`, `npm run lint` y `npm run format:check`: en verde en la última ejecución conjunta. Los errores concurrentes iniciales de divisas y avisos quedaron resueltos por sus tareas responsables.
- Formato específico de los cinco archivos de código de esta entrega: en verde. `docs/` está excluido por la configuración del proyecto.

`npm run test:e2e` compiló correctamente y terminó con 60 pruebas aprobadas y una fallida: `e2e/market-chart.spec.ts:201` espera el texto antiguo `No se pudo actualizar: fallo simulado del proveedor (network)`, que ya no aparece tras el cambio concurrente de avisos. El contexto de error muestra `Actualizados 0 de 1 · sin datos: AAPL` y un fallo macro separado. Las dos pruebas de `legibility-base.spec.ts` pasan sobre la compilación actual; el nuevo aviso sin cobertura también pasa. Se comunica esta incompatibilidad a la tarea de avisos sin modificar su interfaz ni recortar la prueba.

Una repetición de `npm test` solapada con E2E tuvo un timeout de 120 s en la semilla de backtest (`src/main/backtest/service.test.ts:220`): 2.917 pruebas aprobadas y una fallida. Esa suite pasó aislada con sus 21 pruebas en 39 s. La repetición completa sin solapamiento pasó con sus 2.918 pruebas en 84 s; no se han cambiado timeouts, umbrales ni configuración de pruebas.


## Alcance

No se modifican la estructura ni las rutas de `App.tsx`, ni el CSS propio del aviso de frescura, la lista de seguimiento o Conectores. Esta revisión de base no certifica todos los colores específicos de cada pantalla. No se ha ejecutado axe (el proyecto no lo incluye); se verifican contraste por cálculo y navegación por teclado en Electron con Playwright. Las claves reales y el instalador quedan para las comprobaciones del usuario.
