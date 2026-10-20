# Prueba de la nueva identidad con los perfiles de usuario

Rama `orquesta/renovar-la-identidad-visual-logo-paleta-edcd49` (HEAD `5a714df4`). Línea base de comparación: `e58032fa`, la fusión de la PR #16 sobre la que se aplicó la renovación.

## Método

- **App real.** Se probó el build de Electron (`npm run build`, que incluye `typecheck`) lanzado con Playwright desde un script fuera del repositorio (`~/Library/Caches/tradia-qa-perfiles/`). Perfil de datos vacío y reloj de mercado anclado a `2026-10-06`, como las specs existentes. El proveedor de datos es el simulado: las cifras son ilustrativas.
- **Cuatro sesiones.** Dos perfiles por dos temas (`emulateMedia` y `nativeTheme`). Cada sesión recorre aviso de riesgo, tour, Inicio, Mercado, Estrategias, Riesgo, Noticias y Ajustes.
- **Medidas automáticas por pantalla.** Contraste de cada texto visible contra su fondo efectivo (4,5:1; 3:1 desde 24 px), tamaño mínimo de fuente, desbordamiento horizontal del documento, fuentes cargadas, peticiones externas y consola.
- **Capturas.** `docs/qa/capturas/perfiles-identidad/`, con el nombre `<perfil>-<tema>-<pantalla>.png` y un `.json` de medidas por sesión. `A`/`B` son las sesiones de perfil, `M` es la extra de Mercado con datos.

| Perfil | Ventana | Forma de usar la app |
| --- | --- | --- |
| **A · Profesional independiente que organiza varios proyectos** | 1440 × 900 | Ratón. Salta entre pantallas, busca activos (`EUR`), añade el universo inicial de 25 activos y abre el gráfico de SPY. |
| **B · Responsable de equipo que revisa entregas** | 1100 × 760 | Teclado: foco en el enlace de la barra y Enter. Revisa estado, límites de riesgo, titulares y ajustes en una ventana menos holgada. |

## Recorrido por perfil

Leyenda de las valoraciones: ✔ cumple, ⚠ cumple con reservas (ver hallazgo), ✘ no cumple.

### Perfil A · Profesional independiente (1440 × 900)

| Pantalla | Claro | Oscuro | Qué se hizo y qué se vio |
| --- | :-: | :-: | --- |
| Aviso de riesgo | ✔ | ✔ | «Continuar» deshabilitado y casilla sin marcar al abrir. Con «He leído y acepto» se habilita. El bloque «Tu capital está en riesgo» domina sobre el logo. `A-light-00-aviso.png`, `A-dark-00-aviso.png`. |
| Tour (10 pasos) | ✔ | ✔ | Aparece al aceptar; «Saltar tour» lo cierra. `A-*-01-tour.png`. |
| Inicio | ⚠ | ⚠ | «Primeros pasos» ocupa el primer pliegue y empuja «Situación del mercado» y los carriles de datos abajo. El `h2` supera al `h1` (IDV-UXP-2). `A-*-inicio.png`, `A-*-inicio-completa.png`. |
| Mercado | ⚠ | ⚠ | Busca `EUR` y añade el universo. SPY muestra precio en mono de 1499,06 USD, «Fiable» y «Datos simulados», SMA con trazo distinto. El gráfico queda bajo el pliegue y la lista de seguimiento es muy alta (IDV-UXP-2, IDV-UXP-3). `A-*-mercado*.png`, `M-*-mercado-*.png`. |
| Estrategias | ⚠ | ⚠ | Tabla con cifras a la derecha en mono y estado con icono y texto. Descripciones a 10,8 px (IDV-UXP-1). `A-*-estrategias.png`. |
| Riesgo | ⚠ | ⚠ | «Modo cautela activo · VIX 36.2 · Tamaño × 0,5» en ámbar con texto. Una línea de ayuda a 11,7 px (IDV-UXP-1). `B-*-riesgo.png`. |
| Noticias | ✔ | ✔ | Filtros, 117 titulares, insignias «Baja», «Oficial · BCE», «Confirmada» con texto, icono y borde. `A-*-noticias.png`. |
| Ajustes | ⚠ | ⚠ | Filas etiqueta, ayuda y control; interruptores con posición visible. «Techo fijo de esta fase» a 11,7 px (IDV-UXP-1). `A-*-ajustes.png`. |

### Perfil B · Responsable de equipo (1100 × 760, teclado)

| Pantalla | Claro | Oscuro | Qué se hizo y qué se vio |
| --- | :-: | :-: | --- |
| Aviso de riesgo | ✔ | ✔ | Misma pasarela que A. Sin desbordamiento horizontal. |
| Inicio | ⚠ | ⚠ | La barra de estado inferior recorta «En línea» y «Agentes activos» (IDV-UXP-4). |
| Mercado | ⚠ | ⚠ | Navegable con Tab. Misma densidad baja de la lista. |
| Estrategias | ⚠ | ⚠ | Tabla con desplazamiento propio, sin desbordar la ventana. Texto pequeño (IDV-UXP-1). |
| Riesgo | ⚠ | ⚠ | Anillo de foco de 2 px en lima (oscuro) u oliva (claro), visible sobre el elemento activo. `B-*-riesgo.png`. |
| Noticias | ✔ | ✔ | Lectura de titulares cómoda; el titular enlazado tiene un peso alto pero legible. |
| Ajustes | ⚠ | ⚠ | Con 760 px de alto la barra lateral se desplaza y «Inicio» queda fuera de vista al enfocar «Ajustes» (el pliegue de la barra lo indica; sin pérdida de función). |

## Valoración

| Aspecto | Resultado |
| --- | --- |
| **Legibilidad de cifras** | ✔ Cifras, horas y códigos en IBM Plex Mono (`font-variant-numeric: tabular-nums`), alineadas a la derecha en las tablas. El precio de Mercado y el reloj de la barra de estado se leen a primera vista. Contraste de los textos visibles: **0 fallos** en todas las pantallas y temas de las 4 sesiones (umbral 4,5:1, 3:1 en texto grande). Es un muestreo de nuestro script, no sustituye a la batería `contrast.test.ts`. |
| **Tamaño de texto** | ⚠ Mínimo 13 px en Inicio, Mercado y Noticias. Los `<small>` de Estrategias, Riesgo y Ajustes bajan a 10,8 y 11,7 px (IDV-UXP-1). |
| **Jerarquía** | ⚠ Cada pantalla repite el título de página (24 px, barra superior) y un `h2` de 36 px que lo supera (IDV-UXP-2). Los estados usan texto, icono y borde, no solo color. |
| **Logo en barra lateral** | ✔ Símbolo «Arco» de 24 × 24 px (`width/height` fijados) más «TRADIA» en Sora 600 con tracking. Misma geometría (`M4 14.8Q19 6.2 44 4.2…`) que `tradia-mark.svg`. A 24 px la barra y el fuste son finos pero reconocibles. Se ve igual en ambos temas (tinta oscura/clara). |
| **Logo en aviso e icono** | ✔ En el aviso el símbolo sube a ~48 px sobre panel oscuro. `build/icon.svg` lleva la misma ruta, reescalada a 1024 (T lima sobre cuadrado `#0A0E12`). La bandeja usa el dibujo óptico de 16 px previsto en la guía (`M1 9.5Q9 3.4 24 2.4…` en su retícula). `window.ts` fija `backgroundColor: '#0A0E12'`. El aspecto real en Dock, barra de tareas y bandeja lo comprueba el usuario. |
| **Comodidad visual en sesión larga** | ✔ en oscuro: acero `#0A0E12`/`#10161C`, sin sombras ni neones, lima solo en acción primaria, foco y selección. ⚠ en claro: la lima pasa a oliva `#4A6500`, mucho más sobria (IDV-UXP-5). |
| **Coherencia entre pantallas** | ✔ Misma barra lateral de 228 px, mismas insignias y botones, mismos radios. Excepción: el patrón de cabecera de página varía (IDV-UXP-2). |
| **Respeto de la guía** | ✔ Sora + IBM Plex Mono (4 archivos locales, `Sora 100–800`, Plex 400/500/600), paleta acero + lima, un solo acento, sin degradados. Trazos de SMA diferenciados (continuo, guiones, puntos) con su muestra. ✘ Metadatos por debajo de 13 px (IDV-UXP-1). |
| **Red y consola** | ✔ 0 peticiones a hosts externos en las 4 sesiones; las fuentes cargan desde la propia app. La consola solo muestra el aviso de CSP `frame-ancestors` (meta) y un `MaxListenersExceededWarning` de `ai:changed` (11 oyentes). No se puede atribuir a la identidad: no se comprobó en la línea base. |

## ¿Ha cambiado algún flujo, texto o estado de riesgo respecto a main?

**Conclusión: ningún flujo, texto de interfaz ni estado de riesgo cambió; sí hay un cambio de cableado en el proceso principal que no es visual (IDV-UXP-7).**

Evidencia estática (`git diff e58032fa..HEAD`):

- En `src/`, fuera de CSS, JSON de diseño, SVG, fuentes y tests, solo cambian: `TradiaBrand.tsx` (tamaño del `img` y clase del texto), `DashboardBlock.tsx` (envoltorio `div` de presentación; los textos «No se pudo actualizar este bloque…», «Reintentar» y «Cargando…» son los mismos), `PriceChart.tsx` (se quitan los colores de reserva y se añade el estilo de línea de las SMA), `window.ts` (`backgroundColor`) y `ingestion.ts` (+2 líneas).
- `src/shared/`, `src/preload/` y `src/main/risk/` no cambian. Los JSON de `design/` solo cambian valores de color y tipografía, más el nombre de metadatos.
- `e2e/`: solo `data-uncovered-banner.spec.ts` (2 colores esperados) y `legibility-base.spec.ts` (comprobaciones de fuente). Ningún texto, rol o selector de especificación cambia.

Evidencia dinámica (4 sesiones):

- El aviso conserva sus tres párrafos, la casilla «He leído y acepto» y «Continuar» deshabilitado hasta marcarla.
- El tour sigue siendo «Paso n de 10».
- La barra lateral tiene los mismos 15 destinos y el mismo orden.
- La parada conserva «Parada» y octágono.
- El estado de riesgo muestra «Modo cautela activo · VIX 36.2 · Tamaño × 0,5».
- Mercado, Noticias, Estrategias y Ajustes muestran las mismas etiquetas y acciones que antes.

Alcance de esta prueba: no se comparó el texto renderizado contra una compilación de main, y no se probaron Salud de modelos, IA, Macro, Calendario, Fuentes, Diario, Órdenes, Real vs backtest ni Dinero real.

## Hallazgos

| ID | Gravedad | Pantalla y tema | Hallazgo | Propuesta |
| --- | --- | --- | --- | --- |
| IDV-UXP-1 | Media | Estrategias, Riesgo y Ajustes · claro y oscuro | Los `<small>` miden 10,8 px (descripción de estrategia) y 11,7 px («Procedencia no disponible», «Reglas automáticas de calendario…», «Techo fijo de esta fase…»). La guía fija 13 px como mínimo («los metadatos no deben reducirse»). | Fijar `small` a la escala `caption` (13/18) en `styles.css` y en los CSS de esas pantallas. |
| IDV-UXP-2 | Media | Inicio, Mercado, Estrategias, Ajustes · ambos | Jerarquía invertida: la barra superior trae el `h1` a 24 px y debajo hay un `h2` de 36 px («Situación del mercado», «Tu mercado, con perspectiva.», «Biblioteca de estrategias», «Tu aplicación, bajo tus reglas.») que lo supera y repite el título. En Inicio el bloque «Primeros pasos» ocupa el primer pliegue y los carriles de datos quedan debajo. | Reducir el `h2` a la escala de título y dar a «Primeros pasos» una altura compacta cuando hay datos; así los carriles quedan en el primer pliegue. |
| IDV-UXP-3 | Baja | Mercado · ambos | Con 25 activos cada fila de la lista de seguimiento apila ticker, «Fiable» y «Datos simulados» en tres líneas (≈ 150 px por fila). Solo caben unos 3 activos a la vez y el gráfico de SPY queda bajo el pliegue a 1440 × 900. Contradice «carriles densos» de la guía. | Colocar las insignias en la misma línea que el ticker o hacerlas más pequeñas, y subir el gráfico. |
| IDV-UXP-4 | Media | Barra de estado, todas las pantallas · ambos, ventana de 1100 px | La barra inferior recorta «En línea» y «Agentes activos» (se lee «En lín», «Agentes ac»). A 1440 px no ocurre. | Permitir que los textos de estado se envuelvan o abrevien con `title`, no recortarlos con `overflow`. |
| IDV-UXP-5 | Baja | Todas · claro | En claro la lima se sustituye por oliva `#4A6500`: «Añadir» y «Nueva estrategia» se leen como verde oscuro y el tema pierde el carácter «eléctrico» y los «colores vibrantes» del objetivo. Cumple contraste y la guía. | Decisión de diseño: valorar un acento claro más saturado con borde oscuro, o aceptar la sobriedad. |
| IDV-UXP-6 | Baja | Mercado · ambos | El texto de ayuda «Acciones y ETF: AAPL, SPY o FXE…» queda a la derecha de «Añadir» y desalineado de la línea base del botón (más bajo). | Alinear la ayuda bajo el campo con `aria-describedby` y espacio constante. |
| IDV-UXP-7 | Media | Proceso principal (sin pantalla propia) | `ac07a2f9` añade en `src/main/market/ingestion.ts` la llamada `registerMarketSearch(ipcMain)`. Ni `main` ni `e58032fa` la tenían: es un cambio de cableado fuera de una renovación visual. Con él la búsqueda de Mercado responde; sin él el canal `market:search` no tiene manejador. | Decidir: dejarlo documentándolo en el cierre como corrección de funcionamiento, o retirarlo. |

## Comandos

- `npm run build` (typecheck + electron-vite): correcto.
- `grep -rE "M4 12C9 12 11 9 16 9|#8EACFF|#5ED7C0|#557BE8|#101A2A" src build resources scripts`: sin coincidencias.
- `npx prettier --check docs/qa/perfiles-identidad.md`: correcto.
