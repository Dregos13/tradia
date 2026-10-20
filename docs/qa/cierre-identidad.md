# Cierre de la identidad visual «Telemetría de box»

Rama `orquesta/renovar-la-identidad-visual-logo-paleta-edcd49`, HEAD `08516bc5` más los cambios sin confirmar de la rama. Los comandos se ejecutaron el 20 oct 2026 sobre el estado final, sin modificar código ni specs.

## Resultado de los comandos

| Comando                                                                           | Resultado                                                                                           |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `npm test`                                                                        | **215 archivos, 3290 tests, todos pasan** (36 s)                                                    |
| `npm run typecheck`                                                               | **sin errores** (código 0)                                                                          |
| `npm run lint`                                                                    | **sin errores** (código 0)                                                                          |
| `npm run format:check`                                                            | **«All matched files use Prettier code style!»** (código 0)                                         |
| `npm run test:e2e`                                                                | **126 passed (8,2 min)**, código 0                                                                  |
| `npx vitest run src/renderer/src/contrast.test.ts scripts/iconos.test.ts`         | **2 archivos, 134 tests pasan**                                                                     |
| `npx prettier --check docs/qa/cierre-identidad.md`                                | correcto (ver el final de la sesión)                                                                |

De `npm run test:e2e`: `e2e/identidad-visual.spec.ts` pasa sus 18 casos (aviso, logo en `.side`, fuentes `Sora` e `IBM Plex Mono` cargadas y sin peticiones a hosts externos, contraste y foco en seis pantallas × dos temas). Los 35 specs anteriores pasan sin cambiar textos, roles ni selectores de sus recorridos.

## Grep de restos de la marca anterior

```
grep -rE "M4 12C9 12 11 9 16 9|#8EACFF|#5ED7C0|#557BE8|#101A2A" src build resources scripts
→ sin salida (código 1)
```

## Capturas finales

`docs/qa/capturas/identidad/`: `antes-*` (14, de `origin/main` `e58032fa`, hechas a las 08:42) y `despues-*` (14, regeneradas por `identidad-visual.spec.ts` durante este `test:e2e`, 10:49–10:50) de `inicio`, `mercado`, `estrategias`, `riesgo`, `noticias`, `ajustes` y `aviso`, en `claro` y `oscuro`. Se revisaron `despues-inicio-oscuro.png` y `despues-estrategias-claro.png`: barra de estado con «En línea» y «Agentes activos» completos, tabla de Estrategias con las ocho columnas visibles, logo «Arco» en la barra lateral.

Capturas de las correcciones: `docs/qa/capturas/identidad-correcciones/` y `identidad-correcciones-r2/`.

## Estado de cada hallazgo

| Hallazgo   | Estado                         | Evidencia                                                                                                                       |
| ---------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- |
| IDV-E2E-1  | corregido                      | `fx-paper-portfolio.spec.ts:69` y `mejoras-mercado-ajustes.spec.ts:303` pasan en `test:e2e`                                     |
| IDV-E2E-2  | corregido                      | `layout-espaciado.spec.ts` y `identidad-correcciones-r2.spec.ts` pasan; `capturas/identidad-correcciones-r2/ordenes-*`          |
| IDV-E2E-3  | corregido                      | `mejoras-mercado-ajustes.spec.ts` pasa                                                                                          |
| IDV-E2E-4  | corregido                      | `news-sentiment.spec.ts:213` pasa                                                                                               |
| IDV-E2E-5  | corregido                      | `news-sentiment.spec.ts:317` pasa; `capturas/identidad-correcciones-r2/ajustes-radios-*`                                        |
| IDV-E2E-6  | corregido                      | `stale-data.spec.ts:237` pasa                                                                                                   |
| IDV-E2E-7  | corregido                      | `identidad-correcciones-r2.spec.ts`; `capturas/identidad-correcciones-r2/estrategias-1120-*`                                    |
| IDV-E2E-8  | corregido                      | `identidad-correcciones-r2.spec.ts`; `despues-inicio-oscuro.png`                                                                |
| IDV-UXP-1  | corregido                      | `identidad-legibilidad.spec.ts` y `legibilidad-identidad.test.ts` pasan                                                         |
| IDV-UXP-2  | corregido                      | `identidad-legibilidad.spec.ts` (h1 24 px, todo h2 menor); `despues-inicio-oscuro.png`                                          |
| IDV-UXP-3  | corregido                      | `identidad-legibilidad.spec.ts` (filas de 45 px, gráfico visible)                                                               |
| IDV-UXP-4  | corregido                      | `identidad-legibilidad.spec.ts`; `capturas/identidad-correcciones-r2/barra-estado-1120-*`                                       |
| IDV-UXP-5  | descartado por Orquestación    | El oliva `#4A6500` es la tinta lima del tema claro prescrita por el diseño y cumple contraste; ver `correcciones-legibilidad-identidad.md` |
| IDV-UXP-6  | corregido                      | `identidad-legibilidad.spec.ts`                                                                                                 |
| IDV-UXP-7  | resuelto por decisión          | `registerMarketSearch` restaurado (decisión answer-5); `src/main/market/registro-busqueda.test.ts` pasa en `npm test`           |

Limitación: la sonda de regresión anterior anotó que las etiquetas largas de la barra de estado a 1100 px dan `scrollWidth > clientWidth` sin verse cortadas. La spec r2 mide 1120 px y pasa; a 1100 px no se ha vuelto a medir en esta tarea.

## Verificación final

| #   | Criterio                                                                                                  | Resultado    | Evidencia                                                                                                                                                                                                                  |
| --- | --------------------------------------------------------------------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `npm test`, `typecheck`, `lint` y `format:check` pasan sin errores                                        | **Cumplido** | `npm test`: 215 archivos, 3290 tests; los otros tres, código 0 (tabla de comandos)                                                                                                                                         |
| 2   | `npm run test:e2e` pasa completo; `identidad-visual.spec.ts` comprueba logo, fuentes locales y sin red     | **Cumplido** | 126 passed; `e2e/identidad-visual.spec.ts` 18/18 (logo en barra lateral, fuentes cargadas, sin peticiones a hosts externos). Los specs existentes conservan sus recorridos; solo cambian dos colores esperados en `news-sentiment.spec.ts` (fondo del aviso: paleta anterior → identidad) y `data-uncovered-banner.spec.ts`, ya documentado en `correcciones-e2e-identidad-r2.md` |
| 3   | Prueba de contraste (vitest) con todos los pares de los temas claro y oscuro cumple WCAG AA              | **Cumplido** | `src/renderer/src/contrast.test.ts` pasa (4,5:1 texto, 3:1 elementos) dentro de `npm test`; ejecutada aparte: 134 tests con `scripts/iconos.test.ts`                                                                         |
| 4   | Sin geometría ni colores de la marca anterior en `src`, `build`, `resources`, `scripts`; iconos del mismo SVG maestro | **Cumplido** | El `grep` devuelve código 1 sin salida; `scripts/iconos.test.ts` pasa («las variantes ópticas y de bandeja pertenecen al único maestro», ICO, ICNS y bandeja en cuatro estados)                                        |
| 5   | Capturas antes y después de las siete pantallas en claro y oscuro, y cierre con esta sección              | **Cumplido** | 28 archivos en `docs/qa/capturas/identidad/` (14 `antes-*`, 14 `despues-*` regeneradas hoy tras las correcciones); cada hallazgo figura en la tabla de estado, sin ninguno abierto                                       |

Quedan fuera de esta verificación, por ser del usuario: icono en Dock, Launchpad y Cmd+Tab, bandeja en sus cuatro estados con barra clara y oscura, instalación en Windows y Linux, y valorar la comodidad en sesiones largas.
