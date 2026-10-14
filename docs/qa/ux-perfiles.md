# Tradia · Prueba de uso con perfiles: legibilidad, espaciado y marca

Fecha: 14 de octubre de 2026 · Rama `orquesta/modificar-el-logo-y-corregir-ux-ui-mucho-27a49c` · Tester: Claude · Sonnet.

## Método

- App Electron real compilada con `electron-vite build` y lanzada con el arranque E2E (`TRADIA_E2E=1`, perfil de datos vacío por sesión), controlada con Playwright. No se ha modificado código ni se ha dejado ningún spec de exploración en `e2e/`: los guiones viven fuera del repositorio.
- Tamaños: **1280 × 800** y **1024 × 700**, en tema claro y oscuro.
- Cada perfil recorrió «Antes de empezar» (claro y oscuro, a los dos tamaños) y las **15 secciones** de la navegación, y de cada pantalla se midió: desbordamiento horizontal de `main`, separación entre bloques `data-layout-block`, solapes, textos truncados con puntos suspensivos y controles menores de 24 px. Se abrió cada captura para valorarla a ojo.
- Perfil A (independiente): 1280 claro, 1024 claro y 1280 oscuro, con el tour completo de 10 pasos a 1280. Perfil B (responsable): 1280 claro, 1024 oscuro y 1280 oscuro, con el tour saltado. Los dos se completaron sin errores.
- Casos límite probados (perfil A): lista de seguimiento con 25 activos, ticker de 36 caracteres, nombre de estrategia de 333 caracteres, URL y nombre largos en el formulario de fuentes, teclado (Tab y Escape) en Diario y en el tour.
- `npm test`: 196 archivos, 2817 pruebas en verde (ejecutado durante esta prueba).

### Medición automática (resumen de las 15 secciones × 2 tamaños × 3 temas, por perfil)

| Comprobación | Resultado |
| --- | --- |
| Desbordamiento horizontal de `main` y del documento | 0 px en todas las pantallas |
| Bloques solapados | 0 |
| Separación mínima entre bloques | 32 px; 24 px en Riesgo (cabecera → cautela, previsto en UX-17) |
| Textos cortados con puntos suspensivos | Solo rótulos de ejes, «(abre en el navegador externo)» y descripciones de tabla; ningún dato ni selector |
| Barra de estado | 49 px a 1280; **97 px a 1024 (se parte en dos líneas)** |
| Barra lateral | Sobrepasa la altura: 168 px a 1280 × 800 y 268 px a 1024 × 700 (ver UXP-01) |

## Perfil A · Profesional independiente que organiza varios proyectos

Sigue varios tickets (lista de seguimiento), estrategias y noticias a la vez: acepta el aviso, hace el tour, monta su lista de 25 activos, abre gráficos, crea una estrategia, añade una fuente, revisa Noticias y Calendario y ajusta preferencias.

### Lo que funciona

- «Antes de empezar» (`ux-perfil-indep-antes-de-empezar-1280-light.png`): introducción, aviso y casilla forman una columna clara con 32 px de margen; la marca aparece junto a «Tradia» con nombre accesible «Tradia» (`role="img"`, `aria-label="Tradia"`, imagen decorativa) en claro y oscuro.
- Las 15 secciones respiran: ninguna tiene bloques pegados en el recorrido normal (Inicio, Mercado, IA, Salud, Macro, Noticias, Calendario, Fuentes, Estrategias, Ajustes), sin desbordamiento horizontal ni a 1024.
- Noticias: 32 px entre días y 16 px entre tarjetas; las insignias, el titular y el texto se leen por niveles.
- Mercado con 25 activos: cada fila agrupa ticker e insignias bajo un divisor (ya no parecen del activo siguiente). El gráfico y sus controles caben a 1024.
- Estrategias: tabla con scroll propio y región con nombre; el editor cabe a 1024 y avisa a tiempo del exceso de caracteres («Sobran 213 caracteres», 333/120) sin romper la caja.
- Tour: los pasos 3 (Mercado), 8 (IA) y 6, 7 (Riesgo, Órdenes) iluminan su ancla; en 3 y 8 la corrección de `useTourAnchor` funciona con el perfil limpio (`ux-perfil-indep-tour-paso-3-1280.png`).
- Escape en el tour lo pausa con aviso («Tour en pausa en el paso 1 de 10…») y no deja la app inerte.

### Hallazgos

**UXP-01 · Media · Barra lateral · 3–5 secciones quedan fuera de pantalla sin pista de desplazamiento**
- Pantalla: toda la app (barra lateral). Captura: `ux-perfil-indep-inicio-1280.png`, `ux-perfil-indep-estrategias-1024-barra-estado.png`.
- Pasos: abrir la app a 1280 × 800 → mirar el menú.
- Esperado: las 15 secciones alcanzables de un vistazo, o un indicio visible de que hay más.
- Observado: el menú mide 168 px más que la barra (268 px a 1024 × 700). A 1280 × 800 «Real vs backtest» aparece cortado y «Dinero real» y «Ajustes» no se ven; a 1024 × 700 desde «Diario» hacia abajo. La barra lateral sí hace scroll (al abrir «Ajustes» se desplaza sola), pero no muestra barra de desplazamiento ni degradado que avise de que hay más entradas. Causa: 15 enlaces de 56 px más 32 px de relleno y el bloque de marca (`styles.css`, `.side`, `.nav a`).

**UXP-02 · Media · Barra de estado · se parte en dos líneas a 1024 y tapa contenido**
- Pantalla: todas, a 1024 × 700. Captura: `ux-perfil-indep-estrategias-1024-barra-estado.png`.
- Pasos: redimensionar a 1024 × 700 → cualquier sección.
- Esperado: una línea de 49 px como a 1280.
- Observado: 97 px de alto; «Último latido» queda solo en la segunda línea y la barra se come el 14 % de la altura útil, ocultando la fila inferior del contenido. Ya constaba como «sin resolver» en las entregas de los grupos A y B: sigue abierto.

**UXP-03 · Media · Tour pasos 2, 4, 9 y 10 · el resaltado cubre toda la columna y el globo tapa lo que explica**
- Pantallas: tour. Capturas: `ux-perfil-indep-tour-paso-2-1280.png`, `ux-perfil-indep-tour-paso-4-1280.png`, `ux-perfil-indep-tour-paso-9-1280.png`.
- Pasos: Antes de empezar → aceptar → «Siguiente» hasta el paso 10.
- Esperado: foco sobre una zona acotada (como en los pasos 3, 6, 7 y 8) y globo sin tapar lo señalado.
- Observado: los anclajes `inicio-situacion` (988 × 2029 px), `fuentes-lista`, `dinero-real-lista` y `ajustes-proveedores` son más altos que la ventana; el recuadro de foco mide 1004 × 800 (toda la columna) y no distingue nada. El contenido se desplaza hasta el centro del bloque (en el paso 2 se ve a mitad de Inicio, sin la cabecera) y el globo, centrado, tapa la tabla que describe (paso 4). No se probó el tour a 1024 × 700.

**UXP-04 · Alta · Marca · el icono no es el monograma «T» elegido y a tamaño pequeño no se lee** (ver «Valoración del icono»)
- Pantalla: barra lateral, «Antes de empezar», icono, bandeja. Capturas: `ux-perfil-icono-comparativa.png`, `ux-perfil-indep-inicio-1280.png`.
- Pasos: abrir la app → mirar la marca junto a «Tradia»; ampliar la bandeja a 16 px.
- Esperado: según la decisión del usuario, un «monograma “T” reelaborado con una curva ascendente o predictiva»; legible a 24 px (interfaz) y 16 px (bandeja).
- Observado: la marca nueva no contiene ninguna «T» (tres entradas, dos nodos y una diagonal, «Vector de consenso»); en la barra lateral mide unos 28 px, con trazos finos de cobalto sobre azul marino, mucho menos peso que el rótulo «Tradia» y se lee como un par de líneas cruzadas, no como una curva predictiva. A 16 px (bandeja) los nodos y la diagonal se funden en una mancha; los estados se distinguen por el punto de color y por poco más. El usuario, además, ha respondido «No, el logo no me gusta nada» al diseño propuesto, que sigue siendo el mismo.

**UXP-05 · Baja · Noticias · entidad HTML sin decodificar en un titular**
- Pantalla: Noticias. Captura: `ux-perfil-indep-noticias-1280.png`.
- Pasos: Noticias → primer titular de CNMV.
- Esperado: «A&P LIFESCIENCE FUND, FI».
- Observado: «A&amp;P LIFESCIENCE FUND, FI» (el feed entrega la entidad y no se decodifica al ingerir ni al mostrar).

**UXP-06 · Baja · Mercado · el mensaje de error estrecha el campo de ticker a 1280**
- Pantalla: Mercado. Captura: `ux-perfil-indep-mercado-error-ticker-1280.png`.
- Pasos: Mercado → escribir `ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789` → «Añadir».
- Esperado: el error aparece sin cambiar la caja del campo (regla «Estados» de `diseno-espaciado.md`).
- Observado: a 1280 el error se coloca a la derecha de los botones y el campo se encoge de ~420 px a ~75 px («ABCDEF…»); a 1024 el error pasa debajo y el campo no cambia. Comportamiento distinto según el ancho.

**UXP-07 · Baja · Estrategias (editor) · «Volver sin guardar» pegado a la cabecera**
- Pantalla: Estrategias → Nueva estrategia. Captura: `ux-perfil-indep-editor-estrategia-1024.png`.
- Pasos: Estrategias → «Nueva estrategia».
- Esperado: el mismo margen superior que el resto de pantallas (32–40 px).
- Observado: el enlace empieza a ~5 px de la línea inferior de la cabecera y a ~10 px del título «Nueva estrategia»; es la única pantalla cuyo primer elemento toca la cabecera.

**UXP-08 · Baja · Ajustes · hueco de 64 px entre «Ayuda» y «Legal» (el resto, 32 px)**
- Pantalla: Ajustes, final. Captura: `ux-perfil-indep-ajustes-ayuda-legal-1280.png`.
- Pasos: Ajustes → bajar hasta el final.
- Esperado: 32 px entre secciones (UX-22).
- Observado: todas las secciones están a 32 px (medido con `.settings-section`) salvo «Ayuda» → «Legal», a 64 px (el panel de «Ayuda» deja un hueco inferior propio, el de `TourHelp`).

**UXP-09 · Baja · Ajustes · el bloque «Cuenta de broker · Dinero real» es un muro de 3 100 px sin jerarquía**
- Pantalla: Ajustes. Captura: `ux-perfil-indep-ajustes-corto-1280.png`.
- Pasos: Ajustes → bajar a «Cuenta de broker · Dinero real».
- Esperado: tarjetas con el mismo ritmo que las demás secciones.
- Observado: desde el offset 3 364 hasta 6 463 px hay dos tarjetas y, entre ellas y el botón final, párrafos y una lista con viñetas sin tarjeta, con huecos de ~70 px que no siguen la escala. Se lee peor que el resto de Ajustes y hace difícil localizar «Telegram» o «Correo».

**UXP-10 · Baja · Controles menores de 24 px (casillas y selector)**
- Pantallas: Fuentes, Dinero real, Ajustes, Calendario, Órdenes. Capturas: `ux-perfil-indep-fuentes-1280.png`, `ux-perfil-indep-dinero-real-1280.png`.
- Observado (medición): casillas «Activa» de Fuentes de 20 × 20 px y las de declaración en Dinero real de 13 × 13 px; el selector de intervalo de Ajustes mide 23 px de alto; enlaces en línea («Ajustes», «Revisar cuenta paper», «lista de comprobación») de 19 px. `diseno-espaciado.md` pide controles de al menos 44 × 44 px para conservar el objetivo táctil. Las casillas de 13 px son las más difíciles de acertar.

## Perfil B · Responsable de equipo que revisa entregas

Revisa Diario, Órdenes, Real vs backtest y Riesgo, y comprueba Dinero real y Ajustes antes de dar el visto bueno. Recorrido en 1280 claro, 1024 oscuro y 1280 oscuro; el tour se salta nada más entrar, como haría quien ya lo conoce.

### Lo que funciona

- Las seis pantallas de revisión (Riesgo, Diario, Órdenes, Real vs backtest, Dinero real, Ajustes) no desbordan ni a 1024 ni en tema oscuro y mantienen 32 px entre bloques; el resumen de Real vs backtest pasa a 2 × 2 a 1024 y la fecha ya no se parte («14/10/2026, 11:55:20 CEST», `ux-perfil-resp-real-vs-backtest-1024-dark.png`).
- Los filtros de Órdenes y Diario pasan a otra fila antes de truncar («Todas las estrategias» entero a 1024).
- Diario: leyenda de scroll y tabla forman un bloque; los filtros se agrupan con 16 px entre campos.
- Riesgo a 1280: etiquetas y márgenes del formulario de límites ya no se parten (columnas 5/7); la cautela queda a 24 px de la cabecera y a 32 px de los paneles.
- Dinero real: los bloques críticos (aviso de capital, estado, requisitos, escalado) se distinguen por distancia y tarjeta.
- En tema oscuro todo mantiene el mismo espaciado y el contraste de las insignias y avisos es suficiente (`ux-perfil-resp-macro-1024-dark.png` y similares).
- Teclado en Diario: orden lógico (filtros → Aplicar → Limpiar → región de la tabla), foco con contorno de 3 px visible en cada paso.

### Hallazgos

**UXP-11 · Baja · Diario · el botón «Exportar CSV» queda pegado a la cabecera y, sin entradas, se ve casi ilegible**
- Pantalla: Diario. Captura: `ux-perfil-resp-diario-1024-dark.png`.
- Pasos: Diario con perfil vacío, tema oscuro, 1024 × 700.
- Esperado: acción separada de la frase descriptiva; botón deshabilitado con contraste suficiente.
- Observado: el botón empieza ~12 px debajo de la descripción («0 entradas · Señales, operaciones…») sin separación de la cabecera; deshabilitado, el texto gris sobre azul claro tiene un contraste muy bajo en oscuro.

**UXP-12 · Baja · Órdenes · el panel de conciliación tiene una caja distinta al resto**
- Pantalla: Órdenes. Captura: `ux-perfil-resp-ordenes-1024-dark.png`.
- Pasos: Órdenes a 1024 × 700.
- Esperado: bloques principales al ancho de la pila, o un motivo visual claro para que no lo estén.
- Observado: «Conciliación con el broker» ocupa unos 424 px alineado a la izquierda, con un filete verde superior, mientras filtros y tabla ocupan los 748 px; la línea «Actualizado…» queda a ~8 px de la descripción. Parece un resto, no una decisión de jerarquía.

**UXP-13 · Baja · Dinero real · dos avisos rojos iguales seguidos restan jerarquía**
- Pantalla: Dinero real. Captura: `ux-perfil-resp-dinero-real-1280.png`.
- Pasos: Dinero real con perfil limpio, 1280 × 800.
- Esperado: el estado («Dinero real bloqueado · faltan 7 de 7 requisitos») destaca sobre el aviso general.
- Observado: ambos avisos usan la misma caja, color, peso e icono; el estado decisivo no se distingue del texto genérico y, con 32 px entre ellos, parecen repetidos. Además, «Estado del escalado» deja «Drawdown real» solo en una segunda fila de la rejilla.

(Los hallazgos UXP-01, UXP-02 y UXP-04 también se vieron en esta sesión y afectan a este perfil, sobre todo a 1024 × 700: Riesgo, Diario, Órdenes y Real vs backtest están justo en la parte de la barra lateral que queda cortada.)

## Valoración del icono nuevo frente al antiguo

Comparativa: `docs/qa/capturas/ux-perfil-icono-comparativa.png` (nuevo vs «T» antigua en 256, 128, 64, 32 y 16 px, sobre fondo claro y oscuro, y los cuatro estados de bandeja ampliados). Pruebas hechas: `build/icon.png` y `resources/icon.png` (esquinas transparentes), render en la barra lateral y en «Antes de empezar».

| Criterio | «T» antigua | Marca nueva (vector de consenso) |
| --- | --- | --- |
| Identidad / diferenciación | Inicial genérica; sirve para cualquier «T» | Distintiva: nodos, cruce y diagonal ascendente; no se confunde con otra app |
| Transmite la idea de la app | No: ni agentes, ni cálculo, ni predicción | Parcialmente: la línea ascendente y los nodos sugieren «datos → señal», pero la idea de agentes que votan solo se entiende con la explicación |
| Respeta la decisión del usuario («monograma “T” reelaborado con una curva ascendente o predictiva») | Es la «T» a retirar | **No**: no hay «T» en la silueta; es otra propuesta |
| Legibilidad a 256 / 128 px | Muy buena | Buena: verde y cobalto sobre azul tinta se leen bien |
| Legibilidad a 32 / 24 px | Buena | Aceptable; en la barra lateral (≈28 px, trazo fino) se lee como dos líneas cruzadas y pesa menos que «Tradia» |
| Legibilidad a 16 px (bandeja) | Buena | **Mala**: se funde en una mancha; los cuatro estados solo se distinguen por el punto de color (rojo en «sin conexión» y «detenida») |
| Esquinas | Esquinas blancas visibles en la captura del usuario | Transparentes, sin esquinas blancas |
| Coherencia con la interfaz | Cobalto de interfaz | Mismo cobalto + verde menta y tinta; coherente |

**¿El logo nuevo transmite la idea de la app? Solo en parte.** Es claramente más elaborado e identificable que la «T», y la diagonal ascendente comunica predicción; pero (1) no es el monograma «T» que el usuario eligió, (2) la lectura «agentes que aportan señales y un consenso» exige la guía para entenderse, (3) a 16–28 px pierde justo esa lectura y (4) el usuario ya ha dicho que no le gusta. Recomendación: pasarlo al rol de diseño (UXP-04) para decidir entre rehacer sobre la «T» con la curva ascendente o confirmar por escrito con el usuario que se acepta el cambio de concepto, y dar más peso y tamaño a la marca de la barra lateral.

Pendiente del usuario (no verificable aquí): aspecto en el Dock, Finder y Cmd+Tab con pantalla Retina, icono de la barra de tareas e instalador en Windows, lanzador en Linux y lectura real a 16 px en la barra de menús clara y oscura.

## ¿Aún hay secciones pegadas?

**Casi ninguna.** Medido en las 15 secciones, a 1280 × 800 y a 1024 × 700, en claro y oscuro: 32 px entre bloques principales (24 px en Riesgo por diseño), sin solapes y sin desbordamiento horizontal. Lo que queda pegado o desigual es local y de gravedad baja: el enlace «Volver sin guardar» del editor (UXP-07), el botón «Exportar CSV» de Diario (UXP-11), el panel de conciliación de Órdenes (UXP-12), el hueco de 64 px de «Ayuda» → «Legal» (UXP-08) y el estado del campo de ticker (UXP-06). Fuera del espaciado entre bloques, los puntos más molestos son la barra lateral cortada (UXP-01) y la barra de estado partida a 1024 (UXP-02).

## Punto por punto: lo que vio el usuario

1. «El icono es muy aburrido… una aburrida T que no tiene sentido»: **la T ya no está** en la interfaz, en `build/icon.*`, en `resources/icon.png` ni en la bandeja; esquinas transparentes verificadas en `build/icon.png` y `resources/icon.png`. **Pero** el sustituto no es el monograma «T» con curva ascendente que el usuario eligió y no se lee a 16 px (UXP-04); sigue sin poder darse por resuelto el comentario «el logo no me gusta nada».

## Resultado de las sesiones

- Perfil A: recorrido completo (aviso + tour de 10 pasos a 1280 + 15 secciones + casos límite), 10 hallazgos (1 alta, 3 medias, 6 bajas).
- Perfil B: recorrido completo (aviso + 15 secciones en tres combinaciones de tamaño y tema), 3 hallazgos propios (bajas) más los compartidos.
- No se pudo comprobar en este entorno: tour a 1024 × 700, estados de error de red reales (sin conexión con los proveedores: «Probar conexión» no devuelve ningún error visible con el perfil limpio) y los iconos instalados en el sistema.

## Evidencia

Capturas en `docs/qa/capturas/`: `ux-perfil-indep-<sección>-1280.png` (15, tema claro), `ux-perfil-resp-<sección>-1024-dark.png` (15, tema oscuro), las de «Antes de empezar» (`ux-perfil-indep-antes-de-empezar-*`, `ux-perfil-resp-antes-de-empezar-1280-dark.png`), el tour (`ux-perfil-indep-tour-paso-{2,3,4,9}-1280.png`), `ux-perfil-icono-comparativa.png` y las citadas en cada hallazgo.

## Correcciones

### Correcciones · noticias

- **UXP-05 · resuelto.** Los titulares y resúmenes de todas las fuentes (RSS, Atom, CNMV y demás organismos, NewsAPI, Finnhub, Alpha Vantage y GDELT) pasan una sola vez por `decodeHtmlEntities` (`src/main/news/connectors/entities.ts`, sin dependencias nuevas: entidades con nombre comunes y numéricas decimales y hexadecimales) al normalizarse en el conector. «A&amp;amp;P» en el XML de la CNMV llega como «A&P LIFESCIENCE FUND, FI»; el doble escape no se decodifica dos veces («&amp;amp;» queda «&amp;»). El renderer sigue pintándolo como texto (no hay `dangerouslySetInnerHTML`). Pruebas: `entities.test.ts` y «entidades HTML en titulares y resúmenes (UXP-05)» en `rss.test.ts`. Antes: `docs/qa/capturas/ux-perfil-indep-noticias-1280.png`. Los titulares guardados antes del cambio conservan su texto (sin migración); los nuevos llegan decodificados y no se duplican, porque la deduplicación casa primero por URL canónica.

### Correcciones · marca (monograma «T»)

- **UXP-04 · resuelto en el dibujo; la integración en la barra lateral queda para «Iconos con el monograma, marca y menú lateral alcanzables».** Se retira «Vector de consenso» y se dibuja la marca elegida por el usuario: un monograma «T» cuyo travesaño es una curva ascendente (sube, hace una meseta sobre el tallo y vuelve a subir). Se reescriben `build/icon.svg`, `src/renderer/src/assets/brand/tradia-mark.svg` (trazo de 5/32, 3,75 px a 24 px) y las 8 SVG de `resources/tray/`, con una silueta simplificada y un trazo de 2 px exactos a 16 px. Los 4 estados de bandeja se distinguen ahora por la forma del distintivo, no solo por el color: en línea, punto lleno; sin conexión, anillo hueco; en pausa, dos barras; detenida, cuadrado. Se ve en las Template, que solo usan negro. Concepto, construcción, tamaños y usos: `docs/diseno-identidad.md`. Antes: `docs/qa/capturas/ux-perfil-icono-comparativa.png`. Después: `docs/qa/capturas/marca-monograma-escalas.png` (16, 24, 32, 256 y 1024 px, en claro y oscuro, con el ráster de 16 px ampliado). La aceptación final del logo depende del usuario.

### Correcciones · marca y barra

- **UXP-04 · integración resuelta.** La barra lateral y «Antes de empezar» muestran el monograma «T» de onda ascendente a 32 px junto a «Tradia» (`TradiaBrand`, `role="img"` con nombre «Tradia» y símbolo decorativo), en claro y oscuro. En la barra, la marca queda fija arriba y no se desplaza con la lista. `npm run icons` regenera `build/icon.png`, `.icns`, `.ico`, `resources/icon.png` y los 16 PNG de bandeja con los mismos bytes que ya estaban versionados; `scripts/iconos.test.ts` pasa sin cambios. Antes: `ux-perfil-indep-inicio-1280.png`. Después: `e2e-espaciado/marca-barra-lateral-light.png`, `e2e-espaciado/marca-barra-lateral-dark.png`, `e2e-espaciado/marca-antes-de-empezar-light.png` y `e2e-espaciado/marca-antes-de-empezar-dark.png`.
- **UXP-01 · resuelto.** La lista del menú desplaza dentro de la barra (`.nav` con `overflow-y: auto`), con la marca fija encima. Con los tokens `--space-*`, la barra mide 796 px: 16 de relleno, 32 de marca, 16 de separación, 15 entradas de 44 px con 4 px entre ellas y 16 abajo. A 1280 × 800 se ven las 15 entradas sin desplazar. A 1024 × 700 la lista desplaza y, mientras quedan entradas ocultas, aparece un degradado inferior de 48 px (`aside.side[data-more-below]::after`, calculado por `useScrollHint`) que se retira al llegar al final. La entrada enfocada con Tab se desplaza a la vista sin quedar bajo el degradado (`scroll-padding-block-end`). El contorno de foco va hacia dentro para que no se recorte. Lo comprueba «el menú lateral: 15 entradas…» en `e2e/layout-espaciado.spec.ts`: entradas visibles a 1280, indicio a 1024, «Ajustes» alcanzable con rueda y con Tab. También hay pruebas unitarias en `src/renderer/src/hooks/useScrollHint.test.tsx`. Antes: `ux-perfil-indep-inicio-1280.png` y `ux-perfil-indep-estrategias-1024-barra-estado.png`. Después: `e2e-espaciado/barra-lateral-1280.png`, `e2e-espaciado/barra-lateral-1024-indicio.png` y `e2e-espaciado/barra-lateral-1024-final.png`.
- **UXP-10 · resuelto.** Hay reglas globales con especificidad nula en `styles.css`, así que una regla propia de cada pantalla sigue prevaleciendo:
  - Casillas y radios: 20 × 20 px visibles.
  - Etiqueta que contiene una casilla: 44 px de alto clicables.
  - Selectores: 44 px de alto (el de «Minutos de antelación» de Ajustes, además, con el mismo borde y relleno que los campos del formulario).
  - Enlaces en línea sin clase: relleno vertical de `calc(var(--space-3) - 0.5em)`. Así el área clicable llega al menos a 24 px de alto (WCAG 2.5.8) sin cambiar la altura de la línea.
  
  Los enlaces en línea quedan a 24 px y no a 44 px a propósito: subirlos a 44 px separaría las líneas de texto, y WCAG 2.5.8 exime a los enlaces dentro de una frase. La regla 9 de `docs/diseno-espaciado.md` lo recoge.
  
  Lo comprueba «casillas, selectores y enlaces en línea alcanzan el área mínima» en el E2E. Mide el tamaño y, con `elementFromPoint`, que el clic entre a 1 px de cada borde. Los controles medidos son las casillas «Activa» de Fuentes, las de declaración de Dinero real y Ajustes, los selectores de Ajustes y los enlaces «Ajustes» (Calendario), «Revisar cuenta paper» (Órdenes) y «lista de comprobación» (Ajustes). Con el CSS anterior esta prueba fallaba en 9 casos: casillas de 13 × 13, selector de 23 px y enlaces de 19 px. Antes: `ux-perfil-indep-fuentes-1280.png` y `ux-perfil-indep-dinero-real-1280.png`. Después: `e2e-espaciado/controles-dinero-real.png`, `e2e-espaciado/fuentes-1280.png` y `e2e-espaciado/ajustes-1280.png`.

### Correcciones · tour y pantallas

Capturas de después en `docs/qa/capturas/e2e-espaciado/`, regeneradas por `e2e/layout-espaciado.spec.ts`, que comprueba cada punto a 1280 × 800 y a 1024 × 700.

- **UXP-02 · resuelto en «Correcciones del E2E de espaciado» (UXE-03), no se toca aquí.** La barra de estado ocupa una sola línea de 48 px a los dos tamaños, con etiquetas cortas por debajo de 1200 px. El spec la mide en Inicio. Antes: `ux-perfil-indep-estrategias-1024-barra-estado.png`. Después: `e2e-espaciado/inicio-1024.png`.
- **UXP-03 · resuelto.** Las anclas de los pasos 2, 4 y 10 pasan a la cabecera de su bloque, siguiendo el método de UXE-01 (paso 9). En el paso 2 es «Situación del mercado» con su resumen (`Dashboard.tsx`). En el paso 4, «Canales de información bajo tu control» con sus acciones (`SourcesPage.tsx`). En el paso 10, el título y la explicación de «Proveedores de datos» (`DataProvidersSettings.tsx`). La columna de título de Ajustes ya no se estira al alto del panel (`.settings-section > div:first-of-type { align-self: start }`). El foco mide de 64 a 132 px, en lugar de 723 a 2 029 px.
  Al medir apareció otro fallo, en el paso 10: al abrir Ajustes, los mensajes de carga de General, Notificaciones y Avisos desaparecen después de lanzar el desplazamiento suave. La página se encoge 216 px y el ancla quedaba por encima de la vista. `useTourAnchor` vuelve ahora a alinear el ancla si el contenido de su contenedor cambia de alto y el ancla no queda entera a la vista. Solo cambia la colocación; la espera del ancla sigue igual.
  En los pasos 2, 4, 8, 9 y 10, a los dos tamaños, el spec exige un foco de 400 px como mucho (salvo el 8, cuyo ancla es el panel entero) y ningún solape entre el globo y el ancla. Pruebas de interfaz: `Onboarding.test.tsx` (las anclas de los pasos 2, 4, 9 y 10 no contienen tablas, listas, formularios ni secciones) y `useTourAnchor.test.tsx` (realineado tras la carga). Antes: `ux-perfil-indep-tour-paso-{2,4,9}-1280.png`. Después: `e2e-espaciado/tour-paso-{2,4,9,10}.png` y `tour-paso-{2,4,9,10}-1024.png`.
- **UXP-06 · resuelto.** El error del ticker ocupa siempre su propia fila (`.market-error { flex-basis: 100% }` en `market.css`) y ya no compite con el campo. Con 36 caracteres, el campo mide 418 px a 1280 y 382 px a 1024, igual que sin error. Antes: `ux-perfil-indep-mercado-error-ticker-1280.png`. Después: `e2e-espaciado/mercado-error-ticker-1280.png` y `-1024.png`.
- **UXP-07 · resuelto.** La causa no era un margen. Al navegar, `StrategiesPage` enfoca su contenedor y el navegador lo desplazaba hasta el borde de `main`, comiéndose el margen de página. `.strategies-page` lleva `scroll-margin-top: var(--page-block)`, así que el editor arranca a 40 px de la cabecera a 1280 y a 32 px a 1024. «Volver sin guardar» queda a 12 px del título. Antes: `ux-perfil-indep-editor-estrategia-1024.png`. Después: `e2e-espaciado/estrategias-editor-1280.png` y `-1024.png`.
- **UXP-08 · resuelto.** «Legal» está fuera de `Preferencias` y conservaba el relleno superior global de `.settings-section` (32 px), que se sumaba a la separación de la pila. Ahora usa el mismo ritmo que el resto: sin relleno y con el filete en medio del hueco (`settings.css`). Las 15 secciones de Ajustes quedan a 32 px. Antes: `ux-perfil-indep-ajustes-ayuda-legal-1280.png`. Después: `e2e-espaciado/ajustes-ayuda-legal-1280.png` y `-1024.png`.
- **UXP-09 · resuelto, sin cambiar ningún texto de riesgo.** «Preparación del corto», «Límites de capital real» y la confirmación final iban a todo el ancho y fuera de la estructura título/panel. Ahora se apilan a 24 px en la columna de «Cuenta de broker · Dinero real», bajo la tarjeta de claves (`SettingsSection` con `after`, `.settings-stack`). La confirmación (frase, motivos pendientes y botón) pasa a una tarjeta con el título «Confirmación de los límites». Ya no hay huecos dobles: el aviso de estado vacío no suma separación y la lista de requisitos pendientes no añade su margen. El spec exige 4 tarjetas a 24 px, con relleno de 24 px y 12 px de título a contenido. `SettingsPage.test.tsx` comprueba el orden y el contenido de las tarjetas. Antes: `ux-perfil-indep-ajustes-corto-1280.png`. Después: `e2e-espaciado/ajustes-dinero-real-1280.png` y `-1024.png`.
- **UXP-11 · resuelto.** En la cabecera de Diario, el botón va alineado abajo y, cuando pasa a otra fila, queda a 24 px de la descripción. Deshabilitado usa superficie y borde neutros con texto atenuado (contraste ≥ 4,5:1, medido por el spec), en lugar de texto gris sobre el azul de acento. Antes: `ux-perfil-resp-diario-1024-dark.png`. Después: `e2e-espaciado/diario-1024.png` y `diario-1280.png`.
- **UXP-12 · resuelto.** «Conciliación con el broker» pasa debajo de la cabecera, al ancho de la pila (igual que filtros y tabla). Tiene la caja de las demás tarjetas: borde de 1 px, radio medio y relleno de 24 px, sin el filete verde que parecía un estado «correcto». La línea «Actualizado…» queda a 12 px de la descripción. Antes: `ux-perfil-resp-ordenes-1024-dark.png`. Después: `e2e-espaciado/ordenes-1024.png` y `ordenes-1280.png`.
- **UXP-13 · resuelto.** El estado y el aviso de capital forman una sola caja roja (`.live-alert` en `ChecklistPage.tsx`). Primero va el estado («Dinero real bloqueado · faltan 7 de 7 requisitos»), en tamaño grande y seminegrita. Debajo, alineado con su texto, va el aviso general, que conserva el mismo texto. Si el estado es «Listo para confirmar», mantiene su fondo verde dentro de la caja. `ChecklistPage.test.tsx` y el spec comprueban que hay un solo aviso con el estado delante. Antes: `ux-perfil-resp-dinero-real-1280.png`. Después: `e2e-espaciado/dinero-real-1280.png` y `-1024.png`. «Estado del escalado» muestra sus 5 datos en una fila a 1280 y a 1024 (`.live-scaling .live-result-facts` a 5 columnas en `live.css`), así que «Drawdown real» ya no queda solo en una segunda fila. Por debajo de 1000 px vuelve a 2 columnas, y por debajo de 700 px, a 1.
