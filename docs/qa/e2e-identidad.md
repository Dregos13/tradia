# E2E de la identidad visual «Telemetría de box»

Rama `orquesta/renovar-la-identidad-visual-logo-paleta-edcd49`. Pruebas con la app Electron real (macOS, Playwright), 1120 × 688 px de ventana por defecto.

## Resultado

| Comprobación | Resultado |
| --- | --- |
| `e2e/identidad-visual.spec.ts` (18 casos: aviso, logo, fuentes y red, 6 pantallas × 2 temas) | **18/18 pasan** |
| `npm run test:e2e` completo (35 specs, 106 casos) | **99 pasan, 7 fallan** (ver hallazgos) |
| Las mismas 5 specs con fallos sobre el origen `e58032fa` (sin la identidad nueva) | 10 fallan: 6 de los 7 fallos ya existían; uno es regresión (IDV-E2E-1) |
| Grep de restos de la marca anterior | **sin coincidencias** |

Qué comprueba la spec nueva:

- **Logo**: en `.side` hay `img` «Tradia» con la ruta del arco nuevo (`M4 14.8Q19 6.2 44 4.2…`) y sin la geometría anterior (`M4 12C9 12 11 9 16 9`).
- **Fuentes**: `document.fonts` confirma `Sora` e `IBM Plex Mono` en estado `loaded` y `body` usa `Sora`.
- **Red**: ninguna petición `http(s)` a un host distinto de `127.0.0.1`/`localhost` en toda la sesión.
- **Contraste** (`getComputedStyle`, fondo compuesto con alfa): título h1 y texto secundario (`--color-textMuted`) y botones ≥ 4,5:1; contorno de foco de teclado ≥ 3:1. Inicio, Mercado, Estrategias, Riesgo, Noticias y Ajustes, en claro y oscuro con `emulateMedia`.
- Capturas «después» de cada paso.

## Resultado por spec (`npm run test:e2e`)

Todas las specs de `e2e/` pasan salvo estas (el resto de las 35 specs pasan completas):

| Spec | Resultado | Hallazgo |
| --- | --- | --- |
| `fx-paper-portfolio.spec.ts:69` | falla (pasa en el origen) | IDV-E2E-1 |
| `layout-espaciado.spec.ts:597` (1280×800 y 1024×700) | falla (también en el origen) | IDV-E2E-2 |
| `mejoras-mercado-ajustes.spec.ts:303` | falla (también en el origen) | IDV-E2E-3 |
| `news-sentiment.spec.ts:213` | falla (también en el origen) | IDV-E2E-4 |
| `news-sentiment.spec.ts:317` | falla (también en el origen) | IDV-E2E-5 |
| `stale-data.spec.ts:237` | falla (también en el origen) | IDV-E2E-6 |

`legibility-base.spec.ts` y `identidad-visual.spec.ts` pasan. No se han modificado specs existentes.

## Grep de restos de la marca anterior

```
grep -rnE "M4 12C9 12 11 9 16 9|#8EACFF|#5ED7C0|#557BE8|#101A2A" src build resources scripts
→ sin salida (código 1)
grep -rniE "8eacff|5ed7c0|557be8|101a2a" src build resources scripts
→ sin salida (código 1)
```

## Capturas

`docs/qa/capturas/identidad/`: `antes-*` y `despues-*` de `aviso`, `inicio`, `mercado`, `estrategias`, `riesgo`, `noticias` y `ajustes`, en `claro` y `oscuro` (28 archivos). «Antes» sale de `origin/main` (`e58032fa`) construido en una copia fuera del repositorio; la rama local `main` (`9c35f649`) está desfasada y no compila (`JournalPage.tsx:100`), por lo que no sirve de referencia.

## Hallazgos

| id | gravedad | pantalla | pasos | evidencia |
| --- | --- | --- | --- | --- |
| IDV-E2E-1 | media | Mercado (alta de EUR/USD) | Buscar «EUR/USD» y pulsar «Añadir EUR/USD (divisa)». Esperado: se añade. Observado: la opción `search-item-VGK` de la lista de resultados queda sobre el botón e intercepta el clic (timeout 30 s). Regresión: en el origen la spec pasa. | `fx-paper-portfolio.spec.ts:69`, `.market-add` / `.market-search-option` |
| IDV-E2E-2 | media | Órdenes | Medir `layout-espaciado`: «la conciliación no tiene la caja de tarjeta (1px 0px 0px, 24px)». Ya fallaba en el origen. | `layout-espaciado.spec.ts:597`, `ordenes@1280` |
| IDV-E2E-3 | baja | Mercado | Añadir EUR/USD y AAPL y mirar la lista de seguimiento: no hay la etiqueta «Divisa». Ya fallaba en el origen. | `mejoras-mercado-ajustes.spec.ts:338` |
| IDV-E2E-4 | baja | Noticias / Ajustes | Forzar «sin-sesión». Esperado «Suscripción no disponible · sesión no iniciada»; observado «Suscripción no disponible · No hay una sesión iniciada en Claude Code.…». Reproducido en la rama y en el origen. | `news-sentiment.spec.ts:262` |
| IDV-E2E-5 | baja | Noticias | En la región «Análisis de noticias» se esperan dos `radio`; hay 0. Reproducido en la rama y en el origen. | `news-sentiment.spec.ts:317` |
| IDV-E2E-6 | baja | IA | Reconectar tras desconexión: no aparece «Sin conexión · datos del 6 oct 2026…» en `.ai-page > .data-freshness-container`. Ya fallaba en el origen. | `stale-data.spec.ts:262` |
| IDV-E2E-7 | baja | Estrategias | A 1120 px, la tabla recorta las últimas columnas («Operacion», «Sin dat»); antes cabían enteras. La mono nueva ensancha las celdas. | `despues-estrategias-oscuro.png` frente a `antes-estrategias-oscuro.png` |
| IDV-E2E-8 | baja | Barra de estado (todas) | Los textos «En línea» y «Agentes activos» se truncan a «En lír» y «Agentes ac». Ya ocurría antes (más corto), pero sigue. | `despues-inicio-claro.png`, `despues-estrategias-oscuro.png` |

Nota: la decisión de Orquesta indica que IDV-E2E-4 y IDV-E2E-5 «no existen»; se reproducen en dos ejecuciones distintas y se registran por honestidad. Corresponde al responsable decidir.

## Cómo se ha ejecutado

```
npm run test:e2e              # 99 passed, 7 failed (10,2 min)
npx playwright test e2e/identidad-visual.spec.ts   # 18 passed
```
