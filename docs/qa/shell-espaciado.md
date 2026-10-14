# QA · Marca y espaciado del shell

Verificado el 14 de octubre de 2026 con Electron real mediante `npm run dev`, un perfil temporal separado y los ganchos E2E existentes. Playwright se conectó al puerto de depuración de esa instancia. Se usó contenido determinista de los proveedores E2E; las capturas no representan datos de mercado reales. Se aceptó el aviso y se saltó el tour con sus controles existentes.

## Resultados geométricos

Cada medición se comprobó en claro y oscuro; la geometría coincide entre temas.

| Comprobación | 1280 × 800 | 1024 × 700 |
| --- | ---: | ---: |
| Margen horizontal de main, cabecera, banners y estado | 32 px | 24 px |
| Margen vertical de main sin banners globales | 40 px | 32 px |
| Separación entre banners globales | 16 px | 16 px |
| Pila global → contenido | 24 px | 24 px |
| Aviso visible de datos → superficie de pantalla | 24 px | 24 px |
| Main de Antes de empezar: margen horizontal | 32 px | 32 px |
| Título → introducción | 12 px | 12 px |
| Introducción → aviso | 32 px | 32 px |
| Relleno de aviso | 24 px | 24 px |
| Símbolo de marca cargado | Sí | Sí |
| Desbordamiento horizontal de main o documento | Ninguno | Ninguno |

Los estados revisados fueron primer arranque, Inicio sin banners globales y parada manual junto a pérdida simulada de conexión. También se comprobó que el aviso de datos al día, oculto visualmente y montado para anuncios accesibles, no deja un hueco. A 1024 × 700 el aviso inicial requiere desplazamiento vertical; su contenido y acciones siguen accesibles.

## Capturas

Las capturas anteriores están en [Inicio](capturas/ux-antes-inicio.png) y [Antes de empezar](capturas/ux-antes-antes-de-empezar.png).

| Superficie | 1280 claro | 1280 oscuro | 1024 claro | 1024 oscuro |
| --- | --- | --- | --- | --- |
| Antes de empezar | [Captura](capturas/ux-despues-shell-antes-de-empezar-1280-light.png) | [Captura](capturas/ux-despues-shell-antes-de-empezar-1280-dark.png) | [Captura](capturas/ux-despues-shell-antes-de-empezar-1024-light.png) | [Captura](capturas/ux-despues-shell-antes-de-empezar-1024-dark.png) |
| Inicio | [Captura](capturas/ux-despues-shell-inicio-1280-light.png) | [Captura](capturas/ux-despues-shell-inicio-1280-dark.png) | [Captura](capturas/ux-despues-shell-inicio-1024-light.png) | [Captura](capturas/ux-despues-shell-inicio-1024-dark.png) |
| Banners | [Captura](capturas/ux-despues-shell-banners-1280-light.png) | [Captura](capturas/ux-despues-shell-banners-1280-dark.png) | [Captura](capturas/ux-despues-shell-banners-1024-light.png) | [Captura](capturas/ux-despues-shell-banners-1024-dark.png) |

## Verificación automatizada

- `npx vitest run src/renderer/src/App.test.tsx src/renderer/src/components/RiskGate.test.tsx`: 36 pruebas en verde. Se comprueba el nombre accesible único «Tradia», el recurso de marca decorativo, el salto al contenido, las 15 entradas de navegación y los recorridos de foco existentes.
- `npm install && npm test`: 195 archivos y 2810 pruebas en verde, incluidos los iconos añadidos por la tarea de recursos.
- `npm run typecheck`, `npm run lint`, `npm run format:check`: en verde.
- Detector de layout de `impeccable` sobre `styles.css`: sin hallazgos.
- `src/renderer/index.html`: sin cambios; la marca carga con la CSP existente.

Esta revisión resuelve UX-01 a UX-04. Los bloques internos de los grupos A/B/C y el E2E de las quince secciones corresponden a sus tareas posteriores. No se da por comprobada la instalación empaquetada en Dock, Finder, Windows ni Linux.
