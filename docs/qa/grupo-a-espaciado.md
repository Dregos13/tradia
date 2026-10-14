# QA del grupo A · Inicio, Mercado, IA, Salud de modelos y Macro

Fecha: 14 de octubre de 2026. Rama `orquesta/modificar-el-logo-y-corregir-ux-ui-mucho-27a49c`.

## Método

1. Arrancar la app con un perfil E2E limpio y depuración remota:
   `TRADIA_E2E=1 TRADIA_E2E_USER_DATA=$(mktemp -d) REMOTE_DEBUGGING_PORT=9287 npm run dev`.
2. Ejecutar `CDP_PORT=9287 node docs/qa/grupo-a-layout.mjs`. El script acepta el aviso inicial, salta el tour, añade el universo inicial en Mercado si la lista está vacía y recorre las cinco pantallas a 1280 × 800 y a 1024 × 700.
3. Para cada pila (`.app-page`, `.dashboard`, `.market-data-page`, `.ai-page`, `.macro-panel`) mide `siguiente.top − anterior.bottom` entre hijos visibles, comprueba `scrollWidth <= clientWidth` en `.main`, guarda la captura y escribe las cifras en `docs/qa/grupo-a-mediciones.json`.

## Resultados

| Pantalla | Ventana | `.main` scroll / ancho | Separaciones medidas (px) |
| --- | --- | ---: | --- |
| Inicio | 1280 × 800 | 1052 / 1052 | 32 · 32 · 32 |
| Mercado | 1280 × 800 | 1052 / 1052 | 32 · 32 |
| IA | 1280 × 800 | 1052 / 1052 | 32 × 6 |
| Salud de modelos | 1280 × 800 | 1052 / 1052 | 32 × 4 |
| Macro | 1280 × 800 | 1052 / 1052 | 32 · 32 · 24 (aviso → rejilla) |
| Inicio | 1024 × 700 | 796 / 796 | 32 · 32 · 32 |
| Mercado | 1024 × 700 | 796 / 796 | 32 · 32 |
| IA | 1024 × 700 | 796 / 796 | 32 × 6 |
| Salud de modelos | 1024 × 700 | 796 / 796 | 32 × 4 |
| Macro | 1024 × 700 | 796 / 796 | 32 · 32 · 24 (aviso → rejilla) |

Ninguna pantalla tiene desbordamiento horizontal y ninguna separación entre bloques baja de 24 px. Valores calculados: tarjetas de Inicio, Macro y métricas de Salud con 24 px de relleno; columnas de rejilla a 16 px.

## Capturas

| Pantalla | Antes | Después 1280 × 800 | Después 1024 × 700 |
| --- | --- | --- | --- |
| Inicio | `ux-antes-inicio.png` | `ux-despues-inicio.png` | `ux-despues-inicio-1024.png` |
| Mercado | `ux-antes-mercado.png` | `ux-despues-mercado.png` | `ux-despues-mercado-1024.png` |
| IA | `ux-antes-ia.png` | `ux-despues-ia.png` | `ux-despues-ia-1024.png` |
| Salud de modelos | `ux-antes-salud-modelos.png` | `ux-despues-salud-modelos.png` | `ux-despues-salud-modelos-1024.png` |
| Macro | `ux-antes-macro.png` | `ux-despues-macro.png` | `ux-despues-macro-1024.png` |

Las capturas «después» muestran Mercado con el universo inicial cargado; la de «antes» tenía la lista vacía. Con datos apareció un fallo extra: las insignias de estado de cada activo quedaban sin relleno, debajo del divisor, y parecían del activo siguiente. Ahora el divisor va en la fila (`.market-watch li`) y las insignias quedan alineadas con el ticker.

## Límites

- La barra de estado se reparte en dos líneas a 1024 px; es del shell (`styles.css`) y queda fuera del grupo A.
- Los estados de carga, vacío y error no se fuerzan en las capturas; conservan las cajas y rellenos de su bloque por CSS.
- Tema oscuro: el espaciado no depende del tema; no se repitieron capturas en oscuro para este grupo.
