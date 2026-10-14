# Identidad de Tradia

## Concepto elegido: Vector de consenso

La marca representa el mecanismo distintivo de Tradia: varios agentes aportan señales independientes, dos nodos agregan la evidencia y una salida ascendente expresa una decisión cuantitativa. No promete que el mercado siempre suba; la dirección del vector representa una conclusión calculada, válida para estrategias largas o cortas.

La antigua «T» se descarta porque solo repetía la inicial del nombre. No explicaba agentes, cálculo, señal ni aprendizaje, y perdía significado al separarse de la palabra Tradia. La nueva silueta se reconoce por tres entradas, dos nodos de consenso y una salida diagonal; funciona sin texto y sin depender del color.

## Construcción

- Rejilla maestra: `32 × 32` unidades.
- Trazo: `3.25` unidades, extremos y uniones redondeados.
- Nodos de entrada y salida: radio `2.35`; nodos de consenso: radio `2.55`.
- Zona ocupada aproximada: `2.9–28.9` en X y `5.1–28.4` en Y.
- Área de respeto: como mínimo el radio de un nodo de entrada alrededor del símbolo.
- No se corrige ópticamente cada tamaño con una silueta diferente: `build/icon.svg`, `tradia-mark.svg` y la bandeja parten de la misma geometría maestra.

La forma se compone de una ruta principal (`5.25,22.5 → 11.5,15.75 → 16.5,19.5 → 26.5,7.5`) y dos entradas (`6.25,8.5 → 11.5,15.75` y `10.25,26 → 16.5,19.5`). Los seis nodos hacen explícita la red de agentes; la ruta quebrada evita la lectura de una flecha genérica o de un monograma.

## Color

| Uso | Valor | Decisión |
| --- | --- | --- |
| Marca de interfaz | `#557BE8` | Cobalto puente: supera 3:1 tanto sobre blanco como sobre `#17233A`; válido para el símbolo no textual en claro y oscuro. |
| Fondo del icono | `#101A2A` | Azul tinta, coherente con la interfaz sin cambiar sus tokens. |
| Señal del icono | `#8EACFF` | Salida y nodos de consenso. |
| Entradas del icono | `#5ED7C0` | Agentes que alimentan el cálculo. |
| Bandeja en línea | `#16A873` | Punto verde más símbolo de círculo. |
| Bandeja sin conexión | `#D34A50` | Punto rojo más aspa. |
| Bandeja en pausa | `#D59512` | Punto ámbar más pausa. |
| Bandeja detenida | `#A12232` | Punto carmesí más cuadrado. |

Los colores de marca son locales a los recursos de identidad. No sustituyen ni modifican la paleta de tokens de la interfaz. En las variantes macOS `Template` solo se usa negro sobre transparencia; el sistema operativo aplica el color final.

## Icono de aplicación

`build/icon.svg` usa un lienzo de `1024 × 1024`. La placa redondeada mide `824 × 824`, parte de `100,100` y tiene radio `184`. Todo lo que queda fuera de esa forma es transparente: no debe añadirse ningún rectángulo que cubra el lienzo completo.

La placa y su línea interior forman el contenedor del icono; el símbolo mantiene la geometría maestra, ampliada 24 veces. Los PNG, ICNS e ICO se generan desde este SVG en la tarea de iconos y no se editan a mano.

## Legibilidad por tamaño

| Tamaño | Uso | Regla |
| --- | --- | --- |
| 16 px | Bandeja compacta | El trazo resultante es de 1,625 px y los nodos conservan al menos 2,35 px de diámetro. El estado se distingue también por forma, no solo por color. |
| 32 px | Bandeja Retina e interfaz compacta | Se usa la rejilla maestra sin redibujar. El badge de estado ocupa la esquina inferior derecha sin tapar la salida de la señal. |
| 256 px | Finder, barra de tareas e instaladores | Se ve la relación entre entradas, consenso y salida; la placa mantiene esquinas transparentes. |
| 1024 px | Fuente maestra de empaquetado | La línea interior permanece sutil y la geometría no introduce detalle que desaparezca en reducción. |

El mínimo recomendado para la marca dentro de la interfaz es `24 px`. `16 px` se reserva para bandeja, favicon o inspección de reducción. La marca nunca debe sustituir un nombre accesible: cuando aparezca junto a «Tradia», el contenedor recibe el nombre accesible y el SVG se marca como decorativo.

## Bandeja y estados

Los ocho SVG de `resources/tray/` comparten la silueta maestra. El indicador vive siempre en el centro `25,24`:

- En línea: círculo sólido.
- Sin conexión: aro con aspa.
- En pausa: aro con dos barras.
- Detenida: cuadrado sólido.

Las diferencias de forma mantienen los cuatro estados distinguibles en monocromo y ayudan a usuarios con deficiencias de percepción del color. Los archivos `*-Template.svg` no incluyen blanco, grises ni colores de estado: únicamente `#000000` y transparencia.

## Usos correctos

- Usar el SVG maestro; mantener su relación de aspecto y área de respeto.
- Mostrar símbolo y palabra «Tradia» juntos en la barra lateral y en «Antes de empezar».
- Mantener la versión bicolor únicamente sobre el fondo oscuro del icono de aplicación.
- Usar la versión monocroma de Template en la barra de menús de macOS.
- Conservar el badge y su posición al generar los PNG de bandeja.

## Usos incorrectos

- No reconstruir una «T», añadir velas, flechas ni texto dentro del símbolo.
- No rotar, reflejar, estirar ni cambiar las posiciones de los nodos.
- No aplicar degradados, brillos o sombras al símbolo de interfaz.
- No recolorear las variantes Template ni rellenar su fondo.
- No usar el color como única diferencia entre estados.
- No poner `build/icon.svg` sobre un rectángulo opaco de `1024 × 1024`; las esquinas deben seguir transparentes.

## Archivos fuente

- `build/icon.svg`: icono maestro de aplicación, `1024 × 1024`.
- `src/renderer/src/assets/brand/tradia-mark.svg`: símbolo de interfaz, `32 × 32`.
- `resources/tray/tray-{online,offline,paused,stopped}.svg`: bandeja en color.
- `resources/tray/tray-{online,offline,paused,stopped}-Template.svg`: bandeja monocroma de macOS.
- `.orquesta/design/27a49c61/`: tres propuestas, tokens, guía y banco de comprobación de escalas.

## Regeneración reproducible

Ejecutar `npm run icons` desde el proyecto. Usa el Chromium de la versión instalada de Playwright; si no está descargado, ejecutar antes `npx playwright install chromium`. No requiere dependencias adicionales ni herramientas de conversión del sistema.

`scripts/generar-iconos.mjs` rasteriza directamente los SVG a cada escala con fondo transparente y codifica PNG RGBA con `node:zlib`, filtro fijo y sin fechas. Empaqueta esos PNG en ICO (16, 24, 32, 48, 64, 128 y 256 px) e ICNS (16, 32, 64, 128, 256, 512 y 1024 px, más representaciones Retina). Escribir dos veces con la misma versión de Chromium/Node y las mismas fuentes produce los mismos bytes. Una actualización de Chromium puede cambiar el antialiasing: en ese caso se regeneran los recursos y se revisa su aspecto.

Los PNG incluyen el SHA-256 del SVG fuente para detectar recursos obsoletos. `scripts/iconos.test.ts`, incluido en `npm test`, comprueba las dimensiones, los contenedores, las esquinas transparentes, los cuatro estados diferentes y que los Template solo tengan negro sobre transparencia. La bandeja conserva todos sus nombres y rutas: 16 px en `*.png` y 32 px en `*@2x.png`.
