# Identidad de Tradia

## Marca vigente: monograma «Arco» · dirección «Telemetría de box»

La idea visual es la pantalla del ingeniero de pista en el muro de boxes: cada señal es una traza viva y una línea lima marca el instante en que la curva ya ve la vuelta siguiente. Todo parte de ahí: el símbolo, la paleta de acero frío con un único acento lima y el par tipográfico Sora + IBM Plex Mono.

El símbolo es una «T» de una sola pieza. Su barra es la **curva de previsión**: nace a la izquierda con un corte vertical (lo medido empieza en un instante), sube sin caer y acaba en una punta que es el punto más alto del símbolo (lo que la curva ya ve). El fuste es una **aguja** que se clava en el «ahora». A la izquierda del fuste queda lo medido y a la derecha lo previsto, igual que con el cursor «AHORA» de la interfaz.

La marca no promete que el mercado suba: la subida representa la proyección que calcula Tradia, sea en largo o en corto.

### Por qué cambia

1. El usuario consideró «cutre» la marca anterior. Era una «T» de trazo redondo con el travesaño en S, en cobalto, lavanda y menta. Los extremos redondos la hacían blanda y genérica, sin filo y sin ningún rasgo propio.
2. El usuario pidió una marca «fina, puntiaguda, con personalidad» que denote innovación, tomando el logo de Tesla como referencia de carácter. Este símbolo toma de Tesla la pieza única, la finura y la punta del fuste. No toma su arco simétrico, que cae por los dos lados, ni la barra separada del fuste: aquí el arco sube hasta la punta y va soldado al fuste.
3. El usuario eligió la dirección «Telemetría de box» entre tres propuestas y, con ella, el monograma «Arco». Mantener la «T» respeta su decisión de partida («monograma "T" con curva ascendente o predictiva»).
4. La paleta cobalto y crema tampoco transmitía «trader definitiva». La nueva es acero frío con lima ácida `#C6F432` como único acento y colores de mercado vivos (subida en verde frío, bajada en rojo de pista), pensada para sesiones largas ante pantallas oscuras.

## Construcción

- Retícula maestra de `48 × 48` unidades, con área útil de 4 a 44. Una sola ruta rellena: sin trazos, sin `transform` y sin redondeos.
- Ruta maestra: `M4 14.8Q19 6.2 44 4.2Q35 8.6 26.6 11.6L24 43L21.4 12.4Q12 14 4 16.4Z`.
- El borde superior es una cuadrática que siempre sube (su control está por debajo de los dos extremos) y llega a la punta de previsión `44,4.2` todavía subiendo. La punta mide unos 21°.
- La barra pasa de 1,6 u en el corte izquierdo a unos 5,2 u en el centro y se afila hasta la punta. Los dos bordes del fuste convergen en línea recta desde las soldaduras (`21.4,12.4` y `26.6,11.6`) hasta la aguja (`24,43`).
- **Versión óptica de 16 px**, obligatoria hasta 20 px: `M1 4.6Q6.2 2.1 15 1.3Q11.8 3.3 9.2 4.5L8.7 15L7.3 15L6.8 5.1Q4 5.8 1 7.3Z` en una retícula de `16 × 16`. La barra mide 2 px y el fuste acaba romo, porque a 16 px la aguja del maestro se funde.
- **Logotipo:** el símbolo y la palabra «TRADIA» en Sora 600 en mayúsculas, convertida a contornos, con una separación de +0,21 em y los pares ajustados a mano. Detalle propio: la «T» de la palabra corta en bisel el extremo derecho de su barra, con el mismo filo que la punta del símbolo.
- **Área de respeto:** el grosor de la barra en la soldadura (5 u, 1/8 del lado) alrededor de la caja ocupada. Junto a la palabra se mantiene el hueco de 12 u.

### Variantes estudiadas

Se probaron cuatro variantes del «Arco» a 16, 32 y 512 px, en claro, en oscuro y en una tinta:

| Variante                 | Decisión                                                                                                                             |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ |
| r1 · Arco original       | Superada: el borde superior cae al final, como el arco de Tesla, y la punta izquierda desaparece a 16 px.                            |
| **r2 · Arco calculado**  | **Elegida.** El arco sube hasta la punta, tiene corte a la izquierda y aguja abajo, y cada punto de la construcción tiene una función. |
| r3 · Arco y cursor       | Descartada: el fuste asoma por encima de la barra y, a 16 y 32 px, se lee como una cruz o una daga.                                   |
| r4 · Arco grueso         | Descartada como maestro porque pierde la finura que se pidió. Su lógica de grosores se usa en la versión óptica de 16 px.            |

## Color

Acero frío (matiz de unos 210°) en capas separadas por un 2–4 % de luminancia, con la lima como único acento. En oscuro, la proporción es 78 % acero oscuro, 15 % acero medio, 5 % texto y 2 % lima. La lima solo aparece en la acción principal, el foco, el cursor «AHORA» y la previsión.

| Uso                         | Oscuro    | Claro     |
| --------------------------- | --------- | --------- |
| Lienzo                      | `#0A0E12` | `#EEF2F5` |
| Superficie                  | `#10161C` | `#FFFFFF` |
| Texto                       | `#E4EAF0` | `#0C1218` |
| Texto secundario            | `#9AA8B6` | `#475563` |
| Borde de controles          | `#66747F` | `#738392` |
| Acento y foco               | `#C6F432` | `#4A6500` |
| Subida                      | `#3CCB8A` | `#0B7548` |
| Bajada                      | `#FF6B6B` | `#C0282B` |
| Predicción y cursor «AHORA» | `#C6F432` | `#4A6500` |

- En claro, la lima `#C6F432` no llega a 3:1 sobre el lienzo. Por eso el acento pasa a la tinta lima `#4A6500` (5,9:1), y la lima plana solo se usa como relleno con tinta `#0A0E12` encima (15,1:1).
- La lima nunca significa «sube». La subida es verde frío y la predicción lleva además trazo discontinuo y zona rayada.
- Todos los pares de texto cumplen 4,5:1, y los elementos de interfaz y de gráfico 3:1, en los dos temas: 144 pares sin fallos. La tabla completa está en `.orquesta/design/edcd494e/guia.md`.

## Tipografía

- **Sora** (variable, 100–800; se usan 400, 500, 600 y 700) para titulares, navegación, botones y textos.
- **IBM Plex Mono** (400, 500 y 600) para cifras, horas, tickers, etiquetas de eje y metadatos. Las cifras son tabulares por diseño. Si una cifra va en Sora, lleva `font-variant-numeric: tabular-nums`.
- Las dos tienen licencia SIL Open Font License 1.1. Son cuatro archivos woff2 del subconjunto `latin` de Fontsource (`@fontsource-variable/sora@5.3.0` y `@fontsource/ibm-plex-mono@5.3.0`), servidos desde la propia app con `font-display: swap` y sin ninguna URL externa.
- Escala: 13, 14 (cuerpo), 16, 18, 24 y 36 px (título de página), más 48 px para la portada de bienvenida y el aviso de riesgo.

## Icono de aplicación

`build/icon.svg` usa un lienzo de `1024 × 1024`. La placa mide `824 × 824`, parte de `100,100` y tiene radio `184`. Es de acero pavonado `#0A0E12`, con un filo interior de 4 px en `#1F2932`, y lleva el símbolo en lima `#C6F432`, de 528 px de ancho y centrado. Todo lo que queda fuera de la placa es transparente. De 16 a 32 px se usa un dibujo propio, en retícula 32 y con la «T» óptica, para que la aguja no desaparezca.

Los PNG, ICNS e ICO se generan desde los SVG con `npm run icons` y no se editan a mano.

## Bandeja y estados

Los ocho SVG de `resources/tray/` usan una retícula de 32: se exportan a 16 px (`*.png`) y a 32 px (`*@2x.png`). La «T» de bandeja va desplazada a la izquierda para dejar libre la caja `21–31 × 20–30`, donde va el distintivo de estado.

| Estado       | Forma                       | Color (Windows y Linux) | Template de macOS |
| ------------ | --------------------------- | ----------------------- | ----------------- |
| En línea     | Punto lleno                 | `#1C9B63`               | Negro             |
| Sin conexión | Anillo hueco                | `#D2691E`               | Negro             |
| En pausa     | Dos barras                  | `#B07A00`               | Negro             |
| Detenida     | Cuadrado                    | `#E0393E`               | Negro             |

La «T» de color es acero `#6B7B8A`, que cumple 3:1 sobre barras de tareas claras y oscuras. Los estados se distinguen por la forma, así que se reconocen en monocromo y sin distinguir colores. Los archivos `*-Template.svg` solo contienen `#000000` y transparencia.

## Usos correctos

- Usar los SVG maestros, respetar su área de respeto y no cambiar su proporción.
- En la interfaz, el símbolo va en el color del texto (`currentColor`), a 24–28 px junto a «Tradia» en la barra lateral y a 40 px en «Antes de empezar».
- Usar la lima solo sobre acero oscuro, y la tinta lima o la tinta en fondos claros.
- Usar la versión óptica de 16 px hasta 20 px y el maestro desde 24 px.
- Usar la versión Template en la barra de menús de macOS.

## Usos incorrectos

- Reflejar, rotar, inclinar o estirar el símbolo. Si se refleja, la curva bajaría.
- Redondear las puntas, convertir el símbolo en trazo o separar la barra del fuste.
- Poner la lima `#C6F432` sobre fondos claros.
- Añadir degradados, brillos, neones, sombras, flechas, velas o texto dentro del símbolo.
- Usar la lima para indicar subida.
- Usar el color como única diferencia entre estados de bandeja, o recolorear las Template.
- Poner `build/icon.svg` sobre un rectángulo opaco de `1024 × 1024`.

## Archivos fuente

- `.orquesta/design/edcd494e/`: logo maestro (`logo/`), icono de aplicación (`icono/`), bandeja (`bandeja/`), `tokens.json`, `guia.md` y la hoja de escalas a 16, 24, 32, 128 y 512 px (`hoja-escalas.html` y `.png`).
- `build/icon.svg`: icono maestro de aplicación, `1024 × 1024`.
- `src/renderer/src/assets/brand/tradia-mark.svg`: símbolo de interfaz.
- `resources/tray/tray-{online,offline,paused,stopped}.svg` y `*-Template.svg`: bandeja.

## Regeneración reproducible

Ejecutar `npm run icons` desde el proyecto. Usa el Chromium de la versión instalada de Playwright; si no está descargado, ejecutar antes `npx playwright install chromium`. No requiere dependencias adicionales ni herramientas de conversión del sistema.

`scripts/generar-iconos.mjs` rasteriza los SVG a cada escala con fondo transparente y codifica PNG RGBA con `node:zlib`, con filtro fijo y sin fechas. Con esos PNG compone el ICO y el ICNS. Con la misma versión de Chromium y Node, dos ejecuciones dan los mismos bytes. Cada PNG lleva el SHA-256 de su SVG fuente para detectar recursos obsoletos, y `scripts/iconos.test.ts`, incluido en `npm test`, comprueba las dimensiones, los contenedores, las esquinas transparentes, que los cuatro estados sean distintos y que las Template solo tengan negro sobre transparencia.
