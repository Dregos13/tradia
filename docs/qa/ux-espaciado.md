# QA · E2E de espaciado, solapes y marca en todas las secciones

Fecha: 14 de octubre de 2026. Rama `orquesta/modificar-el-logo-y-corregir-ux-ui-mucho-27a49c`. Prueba: `e2e/layout-espaciado.spec.ts`, ejecutada con la app Electron real, perfil limpio y reloj de mercado anclado (`TRADIA_E2E_MARKET_NOW`).

## Qué comprueba el spec

Contrato de `docs/diseno-espaciado.md`, sección «Contrato que medirá el E2E»:

| Comprobación                                                    | Cómo se mide                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `main#contenido` no se desborda en horizontal                   | `scrollWidth - clientWidth <= 0`                                                                                                                                                                                                 |
| Margen de página                                                | Primer hijo visible de `.app-page`: 32 px desde `main` a 1280, 24 px a 1024, ±1 px                                                                                                                                               |
| Bloques hermanos no se solapan                                  | Rectángulos de los bloques `data-layout-block` visibles agrupados por su superficie más cercana (`data-layout-page` o bloque contenedor), más los hijos directos de `.app-page`; se considera solape si se cruzan más de 1 px en ambos ejes |
| Separación vertical mínima 24 px                                | `siguiente.top − anterior.bottom` entre bloques que no comparten fila, ±1 px                                                                                                                                                     |
| Marca «Tradia»                                                  | `role="img"` con nombre accesible «Tradia», símbolo cargado (`naturalWidth > 0`) de al menos 24 px y palabra «Tradia» visible, en la barra lateral y en «Antes de empezar», tema claro y oscuro                                   |
| Tour                                                            | Pasos 2 a 10: el foco (`.tour-spotlight`) acaba sobre el elemento `data-tour` del paso (no sobre `#contenido`), el globo tiene 24 px de relleno y cabe en la ventana                                                              |
| Tour, pasos 8 y 9 (UXE-01, UXE-02)                              | Con el globo quieto, su rectángulo no se cruza con el del ancla; en el paso 9 el foco mide 400 px de alto como mucho. El paso 8 se mide a 1280 × 800 y, volviendo a entrar en él, a 1024 × 700                                   |
| Barra de estado (UXE-03)                                        | En Inicio, a los dos tamaños: `footer.statusbar` mide 48 px ±1 y el dato con `title` «Último latido …» se ve dentro de la barra                                                                                                 |
| Selector «Prioridad» de Noticias (UXE-04)                       | A los dos tamaños: muestra «Todas las prioridades», su ancho cubre el texto medido con su fuente más relleno y flecha, y no sale de `.news-filters` ni la desborda                                                              |

Las 15 rutas, en el orden de la navegación: Inicio, Mercado (con SPY en seguimiento), IA, Salud de modelos, Macro, Noticias, Calendario, Fuentes, Estrategias, Riesgo, Diario, Órdenes, Real vs backtest, Dinero real y Ajustes. Tamaños: 1280 × 800 y 1024 × 700.

Capturas de cada paso en `docs/qa/capturas/e2e-espaciado/` (`<ruta>-<ancho>.png`, `marca-*.png`, `tour-paso-<n>.png`).

## Resultado

```
npm run test:e2e -- e2e/layout-espaciado.spec.ts

  ✓  las 15 secciones respiran a 1280×800: sin desbordamiento, sin solapes y ≥ 24 px entre bloques (6.1s)
  ✓  las 15 secciones respiran a 1024×700: sin desbordamiento, sin solapes y ≥ 24 px entre bloques (6.0s)
  ✓  la marca Tradia se ve en «Antes de empezar» y en la barra lateral (tema claro) (1.9s)
  ✓  la marca Tradia se ve en «Antes de empezar» y en la barra lateral (tema oscuro) (2.0s)
  ✓  el tour ilumina el ancla data-tour de cada paso, también en Mercado, IA y Dinero real (6.3s)

  5 passed (22.6s)
```

`npm run format:check`, `npm run typecheck` y `npx eslint e2e/layout-espaciado.spec.ts` en verde. El spec no usa `test.skip`, `skipIf`, `runIf` ni `fixme`, no escribe en `/tmp` y no usa `console.log`.

### Mediciones por pantalla

Valores leídos a 1280 (a 1024 la estructura es la misma con margen 24 px). «Mín.» es la separación vertical más pequeña entre bloques hermanos apilados de la pantalla.

| Ruta             | Desb. 1280 | Desb. 1024 | Margen 1280/1024 | Bloques medidos (grupo principal)                                              | Mín.  | Solapes |
| ---------------- | ---------- | ---------- | ---------------- | ------------------------------------------------------------------------------ | ----- | ------- |
| inicio           | 0          | 0          | 32 / 24          | primeros pasos, situación → cabecera, tablero, descargo                        | 32 px | 0       |
| mercado          | 0          | 0          | 32 / 24          | cabecera, frescura, herramientas-y-gráfico                                     | 32 px | 0       |
| ia               | 0          | 0          | 32 / 24          | cabecera, frescura, aviso, 4 secciones                                         | 32 px | 0       |
| salud-modelos    | 0          | 0          | 32 / 24          | cabecera, aviso, resumen, 2 secciones                                          | 32 px | 0       |
| macro            | 0          | 0          | 32 / 24          | cabecera, frescura, indicadores → simulación, rejilla                          | 24 px | 0       |
| noticias         | 0          | 0          | 32 / 24          | filtros, resultado, 90 días                                                    | 32 px | 0       |
| calendario       | 0          | 0          | 32 / 24          | cabecera, controles, aviso, días → 3 días                                      | 32 px | 0       |
| fuentes          | 0          | 0          | 32 / 24          | cabecera, lista, formulario                                                    | 32 px | 0       |
| estrategias      | 0          | 0          | 32 / 24          | cabecera, controles, resultados                                                | 32 px | 0       |
| riesgo           | 0          | 0          | 32 / 24          | cabecera, cautela, paneles → límites · vetos (misma fila), simulador           | 24 px | 0       |
| diario           | 0          | 0          | 32 / 24          | cabecera, filtros, resultados, paginación                                      | 32 px | 0       |
| ordenes          | 0          | 0          | 32 / 24          | cabecera (con conciliación), filtros, acciones, resultados                     | 32 px | 0       |
| real-vs-backtest | 0          | 0          | 32 / 24          | cabecera, resumen, resultados, umbrales                                        | 32 px | 0       |
| dinero-real      | 0          | 0          | 32 / 24          | lista, prueba de humo, escalado → cabecera, aviso, estado, requisitos, corto… | 24 px | 0       |
| ajustes          | 0          | 0          | 32 / 24          | 12 secciones de Preferencias, broker real, corto, límites, legal               | 24 px | 0       |

Los 24 px de Macro (aviso → rejilla), Riesgo (cabecera → cautela) y Dinero real (corto → límites) son los previstos por la guía (UX-11, UX-17 y UX-21).

### Marca

- Barra lateral: `role="img"` «Tradia», símbolo de 32 × 32 px cargado desde `tradia-mark.svg`, palabra «Tradia» visible. Claro: `marca-barra-lateral-light.png`; oscuro: `marca-barra-lateral-dark.png`.
- «Antes de empezar»: misma marca arriba del panel izquierdo. Claro: `marca-antes-de-empezar-light.png`; oscuro: `marca-antes-de-empezar-dark.png`.

### Tour

Los pasos 2 a 10 acaban con el foco sobre su ancla `data-tour`; incluidos los pasos 3 (Mercado, `tour-paso-3.png`), 8 (IA, `tour-paso-8.png`) y 9 (Dinero real, `tour-paso-9.png`), que antes caían en el respaldo. El globo mide 24 px de relleno en todos los pasos y no se sale de la ventana a 1280 × 800.

## Sesiones por perfil

### Profesional independiente que organiza varios proyectos

Pasos: primer arranque con perfil limpio a 1280 × 800, lectura de «Antes de empezar» en claro y oscuro, aceptación, tour completo de 10 pasos con «Siguiente», luego recorrido de las 15 secciones en el orden del menú con un activo en seguimiento. Esperado: marca reconocible, cada paso del tour señalando lo que describe, secciones con aire y sin cortes. Observado: todo lo anterior se cumple; véanse los hallazgos UXE-01 y UXE-02 sobre el tour. Evidencia: salida del spec y `docs/qa/capturas/e2e-espaciado/`.

### Responsable de equipo que revisa entregas

Pasos: mismo recorrido a 1024 × 700 (portátil pequeño), revisión de cada captura `-1024.png` y lectura de los números medidos. Esperado: sin desbordamiento horizontal, sin bloques pegados, controles legibles. Observado: el contrato se cumple en las 15 pantallas. Dos cosas que no mide el contrato pero se ven: la barra de estado se parte en dos líneas (UXE-03) y el selector «Prioridad» de Noticias corta su texto (UXE-04). Evidencia: `inicio-1024.png`, `noticias-1024.png`.

## Hallazgos

Ninguno rompía el contrato original del spec; los cuatro eran de gravedad baja. Los cuatro están resueltos (tarea `fe-correcciones-e2e-espaciado`) y el spec los comprueba desde entonces. Las capturas `*-antes.png` son las de la primera pasada; las que llevan el nombre sin sufijo son las de después.

### UXE-01 · Tour, paso 9: el foco cubre toda la ventana (baja) · resuelto

- Pasos: perfil limpio → aceptar aviso → «Empezar» → «Siguiente» hasta el paso 9 (Dinero real).
- Esperado: el resaltado enmarca un elemento identificable de la lista de requisitos.
- Observado: el ancla `dinero-real-lista` es la sección de requisitos completa (unos 2 200 px de alto), así que el recorte al viewport ilumina todo `main` y el globo tapa el contenido. El usuario no distingue este estado del respaldo genérico.
- Evidencia (antes): `docs/qa/capturas/e2e-espaciado/tour-paso-9-antes.png`.
- Rol: frontend (ancla o altura del elemento señalado en `ChecklistPage`).
- Resuelto: el ancla `dinero-real-lista` pasa de la sección completa a su cabecera (título «Requisitos previos», explicación y fecha de la última evaluación) en `ChecklistPage.tsx`. El foco mide unos 130 px y el globo queda debajo, sin taparlo.
- Después: `tour-paso-9.png`; antes: `tour-paso-9-antes.png`.

### UXE-02 · Tour, paso 8: el globo tapa el panel resaltado (baja) · resuelto

- Pasos: igual que UXE-01 hasta el paso 8 (IA).
- Esperado: el globo se coloca junto al panel «Régimen del mercado», sin ocultarlo.
- Observado: el ancla ocupa todo el ancho y no queda sitio en ninguno de los cuatro lados, así que el globo cae centrado sobre el panel y oculta sus dos primeros textos.
- Evidencia (antes): `docs/qa/capturas/e2e-espaciado/tour-paso-8-antes.png`.
- Rol: frontend (`useTourAnchor`, colocación cuando ningún candidato cabe).
- Resuelto en la colocación (`useTourAnchor.ts`, `scrollBlock`): si, con el ancla centrada, el globo no cabe a ningún lado pero ancla y globo caben juntos en la altura de la ventana, la vista lleva el ancla al borde superior y el globo se coloca debajo. El ancla sigue siendo el panel «Régimen del mercado» entero.
- Después: `tour-paso-8.png` (1280 × 800) y `tour-paso-8-1024.png` (1024 × 700); antes: `tour-paso-8-antes.png`.

### UXE-03 · Barra de estado en dos líneas a 1024 × 700 (baja) · resuelto

- Pasos: cualquier sección a 1024 × 700.
- Esperado: una sola línea de estado de 48 px.
- Observado: «Último latido» pasa a una segunda línea y la barra crece a unos 96 px; en una ventana de 700 px eso resta espacio al contenido. Ya anotado por los grupos A, B y C como asunto del shell.
- Evidencia (antes): `docs/qa/capturas/e2e-espaciado/inicio-1024-antes.png`.
- Rol: frontend (`.statusbar` en `styles.css`).
- Resuelto: `.statusbar` ya no salta de línea; las horas no encogen y el estado de conexión y agentes cede con recorte si hiciera falta. Por debajo de 1200 px las etiquetas se abrevian («Comprobado», «Reintento», «Latido») y la etiqueta completa sigue en el árbol accesible y en el `title` (`SystemStatus.tsx`). Por debajo de 760 px la barra vuelve a poder partirse.
- Después: `inicio-1024.png`; antes: `inicio-1024-antes.png`.

### UXE-04 · Noticias: el selector «Prioridad» corta su texto a 1024 (baja) · resuelto

- Pasos: Noticias a 1024 × 700.
- Esperado: «Todas las prioridades» legible entero.
- Observado: el selector mide unos 160 px y el texto se corta en «Todas las prioridad».
- Evidencia (antes): `docs/qa/capturas/e2e-espaciado/noticias-1024-antes.png`.
- Rol: frontend (`news.css`, anchura mínima de los filtros).
- Resuelto: en `news.css`, los selectores de `.news-filters` no encogen por debajo de su opción más larga (`min-width: max-content`) y su etiqueta tampoco; si la fila no cabe, el siguiente filtro salta de línea.
- Después: `noticias-1024.png`; antes: `noticias-1024-antes.png`.

## Límites de la prueba

- Perfil limpio: Diario, Órdenes y Real vs backtest se miden con sus estados vacíos; Mercado con un solo activo. La guía exige que los estados vacíos conserven la misma caja, así que la medida es válida para ambos casos.
- Tema oscuro solo en la prueba de marca: el espaciado no depende del tema.
- El margen de página se mide sobre el primer bloque de `.app-page`; los banners de proveedor quedan cubiertos por `docs/qa/shell-espaciado.md`.
