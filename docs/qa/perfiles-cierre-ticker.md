# Perfiles · regresión final de EUR sin cobertura en Tiingo

_Claude · Sonnet (Testing) · 14-10-2026 · rama `orquesta/hay-un-problema-tiingo-no-devuelve-datos-0c9aa9`.
No se ha cambiado código de `src` ni se ha añadido ningún spec a `e2e/`._

## Veredicto

- **El problema original está resuelto de punta a punta** con el proveedor simulado de E2E y se entiende sin ayuda. Los dos perfiles completan su recorrido.
- **Sin hallazgos graves ni medios.** Quedan tres hallazgos de gravedad baja, todos de textos o etiquetas (frontend).
- **«Datos actualizados.» no aparece** con ningún fallo parcial. El mensaje dice «Actualizados 2 de 3 · sin datos: EUR» (Conectores) y «Actualizados 1 de 2 · sin datos: EUR» (aviso con datos atrasados).
- **Contraste AA:** 0 incumplimientos en el aviso de datos, la lista de seguimiento y Conectores, en todos los estados probados. El orden de Tab es lógico en las tres pantallas.

## Cómo se probó

| Qué | Cómo |
| --- | --- |
| Build y batería | `npm run build` · EXIT 0. `npm run test:e2e` · **71 pasan, 0 fallan** (5,4 min). `npm run format:check` · en verde |
| App | Electron compilada (`out/`) con `TRADIA_E2E=1`, proveedor simulado, perfil limpio por sesión, reloj anclado al 6 oct 2026 |
| EUR heredado | Se siembra como lo tendría quien lo guardó antes: `TRADIA_E2E_UNCOVERED_TICKERS=''`, se añaden SPY/AAPL/EUR, se reabre con la lista por defecto (EUR sin cobertura) y se adelanta el reloj un día |
| Guiones | Playwright **fuera del repositorio** (`/Users/dregos/qa-cierre-ticker/{a,b,c,d}.spec.ts`, ejecutados con `npx playwright test -c …/playwright.config.ts` desde el worktree); registros en `…/out/*.log` |
| Contraste | Medido por script en cada nodo de texto visible: color de texto compuesto sobre el fondo real heredado de los ancestros; umbral 4,5:1 (3:1 para texto grande). Se midieron 19–21 textos en el aviso y 41 en Conectores. No mide controles ni indicador de foco |
| Orden de Tab | Pulsando Tab desde el primer control de cada zona y anotando el nombre accesible de cada parada |
| Capturas | Las nuevas, en `docs/qa/capturas/cierre-ticker-perfiles-*.png`. Las que regenera la batería se restauraron con `git checkout` |

## Sesión A · Profesional independiente que organiza varios proyectos

Perfil limpio con SPY en la lista.

| # | Paso | Esperado | Observado | Evidencia |
| --- | --- | --- | --- | --- |
| A1 | Mercado → escribir `EUR` → Enter | Rechazo en español que explique que Tiingo no cubre EUR y proponga FXE; la lista no cambia | Título «EUR no está disponible en Tiingo». «Tiingo no ofrece datos para EUR. Puedes añadir EUR/USD para seguir el tipo de cambio, o cambiar por FXE, un fondo cotizado en bolsa que se mueve de forma parecida.» Botones «Añadir EUR/USD (divisa)» y «Cambiar por FXE», y enlace «Abrir Ajustes › Conectores». Lista: `SPY`. Foco en el campo | `capturas/cierre-ticker-perfiles-a-rechazo-eur.png`, `out/a.log` |
| A2 | Tab desde el campo hasta «Cambiar por FXE» y Enter | Se llega con teclado y se añade FXE | Tab: Añadir → Añadir EUR/USD (divisa) → Cambiar por FXE. Enter añade; lista `SPY,FXE`, ambas «✓ Fiable · ◇ Datos simulados» y con velas | `out/a.log` («TAB», «LISTA tras FXE») |
| A3 | Lista de seguimiento: contraste y Tab | AA y orden lógico | 0 fallos de contraste. Tab: Añadir → Añadir universo inicial → SPY → FXE → Quitar FXE → rangos del gráfico | `out/a.log` («CONTRASTE lista», «TAB lista») |
| A4 | Ajustes › Conectores sin probar | Cada conector con estado, última comprobación y siguiente paso | Tiingo y FRED: «Sin comprobar · Aún no has comprobado la conexión.», «Última comprobación: Todavía no se ha comprobado», «Siguiente paso: Prueba la conexión para saber si el conector responde.» y «Probar conexión». Tiingo: «Tiingo cubre todos los activos de tu lista.» | `out/a.log` («CONECTORES sin probar») |
| A5 | «Probar conexión» de Tiingo y FRED con teclado | Estado en llano | Ambos «Funciona», «Última comprobación hoy a las 01:26», «Último dato 6 oct 2026», «Siguiente paso: Actualizar datos ahora» y «Probar conexión» como botón secundario | `capturas/cierre-ticker-perfiles-a-conectores-funciona.png` |
| A6 | Estados de fallo con EUR heredado (clave rechazada, sin conexión, límite, no responde, sin clave) | Estado, motivo y paso concreto en cada caso; la cobertura de EUR aparte | Tiingo «Clave no válida · Cómo arreglarlo: Comprueba que has copiado la clave entera…» con «Revisar la clave» y «Abrir mi cuenta de Tiingo». FRED «Sin conexión · Revisa tu conexión a internet…». Tiingo «Límite alcanzado · Espera a que se renueve la cuota…». Tiingo «No responde · Vuelve a probar; si se repite, revisa el estado del servicio.». FRED «Sin clave · Pega una clave activa y pulsa «Guardar clave de FRED»…» con «Añadir clave». En los de Tiingo, debajo: «EUR no está disponible en Tiingo · Alternativa disponible: FXE.». El estado de FRED no se contagia | `capturas/cierre-ticker-perfiles-a-conectores-clave-rechazada.png`, `out/c.log` |
| A7 | Contraste y Tab en Conectores | AA y orden lógico | 0 fallos en los 6 estados (41 textos medidos en el estado sano). Tab: Actualizar datos ahora → Probar conexión → Ir a la lista (si hay EUR) → Cambiar clave de Tiingo → (FRED) Probar conexión → Cambiar clave de FRED | `out/a.log`, `out/b.log` («TAB conectores EUR») |
| A8 | Fallo parcial: «Actualizar datos ahora» con EUR sin cobertura | Nunca «Datos actualizados.»; cuántos y cuáles | «Actualizados 2 de 3 · sin datos: EUR». `getByText('Datos actualizados.')` = 0 | `out/b.log` («TRAS ACTUALIZAR») |

**¿Se entendió sin ayuda?** Sí: el rechazo dice qué pasa y qué hacer, y en Conectores cada tarjeta responde a «¿funciona?, ¿cuándo se comprobó?, ¿qué hago ahora?». Ver H2 por el vocabulario que aún sobra.

## Sesión B · Responsable de equipo que revisa entregas

Lista SPY + AAPL + EUR heredado.

| # | Paso | Esperado | Observado | Evidencia |
| --- | --- | --- | --- | --- |
| B1 | Abrir Inicio y leer el aviso | Un aviso que nombre solo EUR, sin jerga | «1 activo necesita atención · EUR no está disponible en Tiingo · Solo EUR queda en pausa. Los demás activos, predicciones y señales siguen al día.» con «Cambiar por FXE» y «Quitar de la lista». Un único encabezado de EUR | `capturas/cierre-ticker-perfiles-b-aviso-eur.png` |
| B2 | Abrir «Por qué ocurre con EUR» | Frase corta y sin jerga | «Tiingo ofrece precios diarios de acciones y de fondos cotizados (ETF) de EE. UU.; EUR no es un símbolo disponible en este conector. Puedes quitarlo… o cambiarlo por FXE. Para seguir el tipo de cambio, añade EUR/USD…: es el par que Tiingo sí cubre. Solo tiene datos de lunes a viernes.» No sale ninguna frase técnica del backend. Quedan «ETF», «símbolo», «conector» y «par» (H2) | `out/b.log` («BANNER abierto») |
| B3 | Comprobar que el resto sigue al día | SPY, régimen y predicciones sin pausar | `freshness().state = current`; solo `uncovered = [EUR]`. Inicio: «Precios · Simulado · Último cierre 7 oct 2026 · Disponible»; macro (VIXCLS, DGS10, CPIAUCSL) «✓ Fiable». IA: régimen de SPY «Tendencia · Volatilidad alta» calculado con el cierre del 7 oct; AAPL con datos hasta el 7 oct; EUR queda en su fila como «6 oct 2026 · desactualizado»; la decisión por régimen de las estrategias sigue calculándose. Mercado: SPY y AAPL «✓ Fiable», EUR «Sin datos en Tiingo» | `out/b.log` («FRESHNESS», «IA main», «MERCADO lista») |
| B4 | Un único aviso por activo en Inicio, Mercado e IA | 1 encabezado y 1 botón «Quitar EUR de la lista» | Inicio y IA: 1 encabezado. Mercado: 1 botón «Quitar EUR de la lista» (más «Quitar SPY», que es otra cosa) | `out/b.log` («IA aviso EUR count: 1», «MERCADO botones quitar») |
| B5 | Contraste y Tab en el aviso (Inicio y Mercado) | AA y orden lógico | 0 fallos (19 textos medidos). Tab: Cambiar por FXE → Quitar EUR de la lista → Por qué ocurre con EUR → siguiente zona. Cada botón con nombre accesible propio (H1 por el nombre visible) | `out/b.log` («TAB aviso», «CONTRASTE aviso») |
| B6 | Conectores con EUR | Tiingo funciona y dice qué activos no cubre | Tiingo «Funciona», «Último dato 7 oct 2026». Debajo, «Cobertura de tu lista en Tiingo · EUR no está disponible en Tiingo · Alternativa disponible: FXE.» y «Ir a la lista para quitar o cambiar estos activos». No nombra SPY ni AAPL. Sin contradicción entre «Funciona» y el aviso | `capturas/cierre-ticker-perfiles-b-conectores-eur.png` |
| B7 | Fallo parcial desde Conectores («Actualizar datos ahora») | Nunca «Datos actualizados.»; cuántos y cuáles | «Actualizados 2 de 3 · sin datos: EUR» | `out/b.log` |
| B8 | Fallo parcial con SPY atrasado (proveedor caído, luego recuperado) y «Actualizar ahora» en el aviso, en Inicio y en Mercado | Nunca «Datos actualizados.»; cuántos y cuáles | Aviso «Datos desactualizados desde el 6 oct 2026» → tras pulsar con Enter: «Actualizados 1 de 2 · sin datos: EUR». «Datos actualizados.» = 0 durante 10 s y al final, en ambas pantallas | `capturas/cierre-ticker-perfiles-b-parcial.png`, `out/d.log` |
| B9 | Contraste y Tab con el aviso de datos atrasados | AA y orden lógico | 0 fallos (21 textos). Tab: Actualizar ahora → Probar conexión → siguiente zona. Texto: «Mientras los datos estén atrasados no se calculan régimen, predicciones ni señales nuevas para esos activos. Lo ya calculado se conserva.» (H3) | `out/c.log` |
| B10 | «Quitar EUR de la lista» con teclado (Mercado) | El aviso desaparece sin reiniciar | Enter sobre el botón: lista `SPY,AAPL`; avisos de EUR en Mercado = 0 y en Inicio = 0; `freshness().uncovered = []`; solo queda «EUR se ha quitado de tu lista.» y «Datos al día.» | `capturas/cierre-ticker-perfiles-b-quitado.png`, `out/b.log` |
| B11 | Reiniciar la app | El aviso no vuelve | Lista `SPY,AAPL`, `uncovered = []`, `state = current`, 0 regiones «Estado de los datos» y 0 encabezados de EUR (tras 14 s y un día más de reloj) | `out/b.log` («tras reiniciar») |

**¿Se entendió sin ayuda?** Sí: el aviso dice qué activo, qué consecuencia y qué hacer; el resto de la app sigue al día. La persona solo tropieza con unas pocas palabras (H2).

## ¿Aparece «Datos actualizados.» con fallos parciales?

**No.** Se buscó el texto en pantalla en cada estado:

| Estado | Mensaje mostrado | «Datos actualizados.» |
| --- | --- | --- |
| EUR sin cobertura, «Actualizar datos ahora» en Conectores | «Actualizados 2 de 3 · sin datos: EUR» | 0 |
| SPY atrasado + EUR sin cobertura, «Actualizar ahora» en el aviso (Inicio) | «Actualizados 1 de 2 · sin datos: EUR» | 0 |
| Lo mismo en Mercado | «Actualizados 1 de 2 · sin datos: EUR» | 0 |
| Aviso de EUR sin tocar nada | solo el aviso por activo | 0 |

## Hallazgos

Todos son de gravedad baja: no impiden completar ninguna tarea.

### H1 · Baja · frontend · «Quitar de la lista» no contiene su nombre accesible

- **Pasos:** con EUR heredado, abrir Inicio o Mercado y mirar el botón del aviso.
- **Esperado:** el nombre accesible empieza por o contiene el texto visible (WCAG 2.5.3, «Etiqueta en el nombre»), para que quien usa control por voz diga lo que ve.
- **Observado:** el texto visible es «Quitar de la lista» y el nombre accesible es «Quitar EUR de la lista» (`UncoveredAssets.tsx:105`). «Quitar de la lista» no es una subcadena de «Quitar EUR de la lista», así que decir «pulsar Quitar de la lista» no lo activa. «Cambiar por FXE» sí cumple (su nombre es «Cambiar por FXE para EUR»).
- **Corrección sugerida:** que el texto visible sea «Quitar EUR de la lista» (el nombre que ya usan las pruebas).
- **Evidencia:** `out/b.log` («BANNER botones» frente a «TAB aviso»); `capturas/cierre-ticker-perfiles-b-aviso-eur.png`.

### H2 · Baja · frontend · Quedan términos técnicos en «Por qué ocurre» y en la tarjeta de Tiingo

- **Pasos:** abrir «Por qué ocurre con EUR» y Ajustes › Conectores.
- **Esperado:** sin jerga para quien no opera a diario (criterio de la misión: lenguaje llano).
- **Observado:**
  - «Por qué ocurre»: «fondos cotizados (ETF)», «no es un símbolo disponible en este conector» y «es el par que Tiingo sí cubre».
  - Conectores: la descripción «Precios diarios de acciones y ETF de EE. UU.» y «Prueba la conexión para saber si el conector responde».
  - La frase «Solo tiene datos de lunes a viernes» queda ambigua: no dice si habla de EUR/USD.
- **Corrección sugerida:** «EUR no está entre los activos de Tiingo»; «divisa EUR/USD» en lugar de «par»; «fuente de datos» en lugar de «conector» y quitar «ETF» o explicarlo una vez.
- **Evidencia:** `out/b.log` («BANNER abierto», «CONECTORES con EUR»).

### H3 · Baja · frontend · Con datos atrasados, el aviso no nombra el activo ni el aviso de EUR

- **Pasos:** con EUR heredado, provocar un fallo del proveedor y avanzar el reloj un día; leer el aviso de Inicio.
- **Esperado:** el mismo vocabulario por activo que el aviso de EUR (el activo atrasado nombrado); frases con mayúscula inicial.
- **Observado:** «Datos desactualizados desde el 6 oct 2026 / faltan datos recientes; último dato: 6 oct 2026 / …para esos activos». No dice cuál es el activo atrasado. Mientras el estado es «atrasado», el aviso por activo de EUR no se muestra (0 encabezados, en Inicio y en Mercado); EUR solo vuelve a aparecer en el resultado «Actualizados 1 de 2 · sin datos: EUR». «faltan datos recientes» empieza en minúscula.
- **Nota:** el estado atrasado se forzó con el gancho de prueba y el resumen se congeló para pulsar «Actualizar ahora». No se comprobó con datos reales de Tiingo.
- **Evidencia:** `out/d.log` («EUR heading en toda la página (stale)»), `out/c.log` («AVISO con proveedor caído»).

## Otras observaciones (no son hallazgos)

- **«Quitar» en la lista de seguimiento solo sale en el activo seleccionado** (`Watchlist.tsx:327`), con confirmación. Es el comportamiento existente y no tiene relación con EUR; quien quiera quitar AAPL tiene que seleccionarlo antes.
- **EUR sigue en «Régimen por activo» (IA)** con «6 oct 2026 · desactualizado» mientras esté en la lista. Es coherente con «Solo EUR queda en pausa».
- **Contraste:** solo se mide el texto. Los bordes de los botones y el indicador de foco se vieron en las capturas (foco azul bien visible, por ejemplo en «Ver fuentes»), sin medirse.

## Lo que no se pudo comprobar

- Con clave real de Tiingo: la prueba la hace la persona usuaria (el motivo real dirá «Tiingo no tiene datos de EUR», no «Proveedor simulado»).
- Instalador y revisión visual en Windows y Linux; macOS solo con la app de desarrollo, no con `npm run dist:mac`.
- Tamaño de letra en el sistema operativo y modo oscuro.

## Comandos

- `npm run build && npm run test:e2e`: build EXIT 0; **71 pasan, 0 fallan**.
- Los hallazgos de los informes anteriores (`perfiles-tiingo-claridad.md`: H1 el aviso no desaparecía, H2 el aviso duplicado, H3 «Precios» en «Sin evaluar») **ya no se reproducen**: B3, B4 y B10–B11.
- `npm run format:check`: «All matched files use Prettier code style!».

## Limpieza

Los guiones y los registros están fuera del repositorio. No hay specs en `e2e/`. Las capturas de la batería se restauraron con `git checkout -- docs/qa/capturas`. Las únicas altas del árbol son este informe y las siete capturas `cierre-ticker-perfiles-*.png`.
