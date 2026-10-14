# Identidad de Tradia

## Concepto elegido: monograma «T» de onda ascendente

La marca es una «T» de Tradia cuyo travesaño es una curva de precio: arranca a la izquierda, sube, hace una meseta donde nace el tallo y vuelve a subir hacia la derecha. El tallo vertical sostiene esa curva. Se lee primero como una «T» y después como una tendencia calculada que se proyecta hacia delante. Es el monograma «T» reelaborado con una curva ascendente que eligió el usuario.

En el icono de aplicación, la curva cambia de color en el tallo: el tramo izquierdo (lo medido) va en lavanda, igual que el tallo, y el tramo derecho (lo proyectado) en menta. La marca no promete que el mercado suba: la subida representa la proyección que calcula Tradia, válida para estrategias en largo y en corto.

### Por qué se abandona «Vector de consenso»

La marca anterior (tres entradas, dos nodos de consenso y una diagonal de salida) se retira por cuatro motivos, recogidos en UXP-04 de `docs/qa/ux-perfiles.md`:

1. No era la decisión del usuario. El usuario eligió un monograma «T» con curva ascendente, y esa silueta no contenía ninguna «T». El usuario respondió: «No, el logo no me gusta nada».
2. A 16 px los seis nodos y los cruces se fundían en una mancha, y los estados de bandeja solo se distinguían por el color del punto.
3. En la barra lateral, a unos 28 px y con trazo fino, se leía como dos líneas cruzadas y pesaba menos que la palabra «Tradia».
4. La idea de «agentes que votan» solo se entendía con la explicación al lado.

### Por qué no se vuelve a la «T» lisa

La «T» original (`main:build/icon.svg`) era una inicial genérica que el usuario calificó de «aburrida» y «sin sentido». La nueva «T» conserva lo que la antigua hacía bien, una silueta compacta que se lee en cualquier tamaño, y le añade la curva que cuenta qué hace la app.

### Variantes estudiadas

Las tres variantes están en `.orquesta/design/27a49c61/04-monograma-t-*.svg`, con su comparativa en `04-comparativa-variantes.png`:

| Variante | Forma | Decisión |
| --- | --- | --- |
| **A · Onda ascendente** | Todo el travesaño es una curva que sube con una meseta sobre el tallo. | **Elegida.** La curva forma parte de la letra en vez de añadirse a ella. La subida total (8 de 32 unidades) se sigue viendo a 16 px y la «T» se mantiene equilibrada. |
| B · Remate ascendente | Travesaño plano con el extremo derecho doblado hacia arriba. | Es la «T» más literal, pero a 16 px el remate se reduce a un píxel y vuelve a parecer la «T» lisa. |
| C · Punto previsto | Travesaño plano que termina en un punto separado. | Cuenta bien la idea de predicción a 256 px, pero a 16–24 px el punto se pega a la curva y forma un bulbo. Además, añade un nodo, justo el recurso que no funcionó en la marca anterior. |

## Construcción

- Rejilla maestra: `32 × 32` unidades.
- Trazo: `5` unidades (1/6,4 del lado), extremos y uniones redondeados. Es más grueso que el de la marca anterior (`3.25`) para que la «T» pese al menos lo mismo que la palabra «Tradia».
- Travesaño: `M4 12 C9 12 11 9 16 9 S23 7.5 28 4`. Sube de `y = 12` a `y = 4`, con meseta en `16,9`.
- Tallo: `M16 9 V28`, centrado en `x = 16`.
- Caja ocupada con los extremos redondeados: `1.5–30.5` en X y en Y.
- Área de respeto: media altura del trazo (`2.5` unidades) alrededor del símbolo; junto a la palabra «Tradia», al menos `8 px`.
- Icono de aplicación: la misma geometría ampliada 20 veces (`translate(192 192) scale(20)`), centrada en la placa.
- Bandeja: silueta simplificada (trazo `4`, tallo en `x = 12`; ver «Bandeja y estados»).

## Color

| Uso | Valor | Decisión |
| --- | --- | --- |
| Marca de interfaz | `#557BE8` | Cobalto puente: supera 3:1 sobre blanco y sobre `#17233A`. Sirve para un símbolo no textual en tema claro y oscuro. |
| Fondo del icono | `#101A2A` | Azul tinta, coherente con la interfaz sin cambiar sus tokens. |
| Línea de placa | `#31435F` | Contorno interior sutil. |
| Tallo y tramo medido | `#8EACFF` | Lavanda de señal. |
| Tramo proyectado | `#5ED7C0` | Menta: la parte de la curva que calcula Tradia. |
| Bandeja en línea | `#16A873` | Punto lleno. |
| Bandeja sin conexión | `#D34A50` | Anillo hueco; la «T» pasa a gris `#64748B`. |
| Bandeja en pausa | `#D59512` | Dos barras. |
| Bandeja detenida | `#A12232` | Cuadrado. |

Los colores de marca son locales a los recursos de identidad. No sustituyen ni modifican la paleta de tokens de la interfaz. En las variantes macOS `Template` solo se usa negro sobre transparencia, y el sistema operativo aplica el color final.

## Icono de aplicación

`build/icon.svg` usa un lienzo de `1024 × 1024`. La placa redondeada mide `824 × 824`, parte de `100,100` y tiene radio `184`. Todo lo que queda fuera de esa forma es transparente: no debe añadirse ningún rectángulo que cubra el lienzo completo.

Los PNG, ICNS e ICO se generan desde este SVG con `npm run icons` y no se editan a mano.

## Legibilidad por tamaño

Hoja de comprobación: `docs/qa/capturas/marca-monograma-escalas.png`, generada desde `.orquesta/design/27a49c61/04-hoja-escalas.html`. Muestra cada recurso en tamaño real y su ráster a 16 px ampliado píxel a píxel, sobre fondo claro y oscuro.

| Tamaño | Uso | Resultado |
| --- | --- | --- |
| 16 px | Bandeja, favicon, ICO pequeño | Trazo de 2 px en la bandeja (rejilla alineada a medio píxel) y de 2,5 px en la marca. La «T» se reconoce en claro y en oscuro, y la subida del travesaño ocupa unos 4 px. El estado se distingue por la forma del distintivo. |
| 24 px | Mínimo de la marca en la interfaz | Trazo de 3,75 px. Se ven la meseta y las dos subidas. |
| 32 px | Barra lateral, «Antes de empezar», bandeja Retina | Tamaño normal de la marca junto a «Tradia». El trazo de 5 px pesa como el rótulo en negrita. |
| 256 px | Finder, barra de tareas, instaladores | Se distinguen los dos colores de la curva (medido y proyectado) y la placa conserva las esquinas transparentes. |
| 1024 px | Fuente maestra de empaquetado | Sin detalles finos que se pierdan al reducir. La línea interior de la placa queda sutil. |

El mínimo de la marca en la interfaz es `24 px`; lo normal, `32 px`. `16 px` queda para la bandeja, el favicon o la comprobación de reducción. La marca nunca sustituye a un nombre accesible: cuando aparece junto a «Tradia», el contenedor recibe el nombre accesible y el SVG se marca como decorativo.

## Bandeja y estados

Los ocho SVG de `resources/tray/` llevan la silueta simplificada para 16 px: la misma «T» de onda, con trazo `4` (2 px exactos a 16 px), tallo en `x = 12` y travesaño `M3 11.5 C6.5 11.5 8.5 8 12 8 S17.5 6.5 22 3`. Así queda libre la esquina inferior derecha. El distintivo de estado ocupa siempre la caja `20–30 × 20–30` (5 × 5 px a 16 px), separada de la «T» por al menos 3 px:

| Estado | Forma | Template | Color |
| --- | --- | --- | --- |
| En línea | Punto lleno (`r 5`) | Negro | Verde `#16A873`, «T» cobalto |
| Sin conexión | Anillo hueco (`r 4`, trazo `2`) | Negro | Rojo `#D34A50`, «T» gris `#64748B` |
| En pausa | Dos barras de `4 × 10` separadas por `2` | Negro | Ámbar `#D59512`, «T» cobalto |
| Detenida | Cuadrado de `10 × 10` | Negro | Carmesí `#A12232`, «T» cobalto |

Como la forma cambia en cada estado, los cuatro se distinguen en monocromo, con la Template invertida en una barra de menús oscura, y para quien no distingue los colores. Los archivos `*-Template.svg` solo contienen `#000000` y transparencia: sin blanco, sin grises y sin colores de estado. El nombre del estado se sigue mostrando en el texto del menú o del tooltip.

## Usos correctos

- Usar los SVG maestros y mantener su relación de aspecto y su área de respeto.
- Mostrar el símbolo y la palabra «Tradia» juntos en la barra lateral y en «Antes de empezar», con el símbolo a 32 px.
- Usar el monocolor cobalto en la interfaz y el bicolor (lavanda y menta) solo sobre la placa azul tinta del icono de aplicación.
- Usar la versión Template en la barra de menús de macOS.
- Regenerar los PNG, ICNS e ICO con `npm run icons` después de cualquier cambio en los SVG.

## Usos incorrectos

- No enderezar el travesaño ni volver a la «T» lisa.
- No añadir flechas, velas, nodos ni texto dentro del símbolo.
- No rotar, reflejar ni estirar la «T». Si se refleja, la curva bajaría.
- No aplicar degradados, brillos ni sombras al símbolo de interfaz.
- No invertir los colores del icono (menta a la izquierda y lavanda a la derecha).
- No recolorear las variantes Template ni rellenar su fondo.
- No usar el color como única diferencia entre estados.
- No poner `build/icon.svg` sobre un rectángulo opaco de `1024 × 1024`: las esquinas deben seguir transparentes.
- No usar la marca por debajo de 24 px dentro de la interfaz.

## Archivos fuente

- `build/icon.svg`: icono maestro de aplicación, `1024 × 1024`.
- `src/renderer/src/assets/brand/tradia-mark.svg`: símbolo de interfaz, `32 × 32`.
- `resources/tray/tray-{online,offline,paused,stopped}.svg`: bandeja en color.
- `resources/tray/tray-{online,offline,paused,stopped}-Template.svg`: bandeja monocroma de macOS.
- `.orquesta/design/27a49c61/04-*`: variantes del monograma, comparativa y hoja de escalas.

## Regeneración reproducible

Ejecutar `npm run icons` desde el proyecto. Usa el Chromium de la versión instalada de Playwright; si no está descargado, ejecutar antes `npx playwright install chromium`. No requiere dependencias adicionales ni herramientas de conversión del sistema.

`scripts/generar-iconos.mjs` rasteriza directamente los SVG a cada escala con fondo transparente y codifica PNG RGBA con `node:zlib`, filtro fijo y sin fechas. Con esos PNG compone el ICO (16, 24, 32, 48, 64, 128 y 256 px) y el ICNS (16, 32, 64, 128, 256, 512 y 1024 px, más las representaciones Retina). Con la misma versión de Chromium y Node y las mismas fuentes, dos ejecuciones dan los mismos bytes. Una actualización de Chromium puede cambiar el antialiasing; en ese caso se regeneran los recursos y se revisa su aspecto.

Cada PNG lleva el SHA-256 de su SVG fuente para detectar recursos obsoletos. `scripts/iconos.test.ts`, incluido en `npm test`, comprueba las dimensiones, los contenedores, las esquinas transparentes, que los cuatro estados sean distintos y que las Template solo tengan negro sobre transparencia. La bandeja conserva todos sus nombres y rutas: 16 px en `*.png` y 32 px en `*@2x.png`.
