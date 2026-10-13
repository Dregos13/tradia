# Perfiles · claridad de datos y conectores (Tiingo sin cobertura para EUR)

_Claude · Sonnet (Testing) · 13-10-2026 · rama `orquesta/hay-un-problema-tiingo-no-devuelve-datos-0c9aa9`.
No se ha cambiado código de `src` ni de `e2e`._

## Veredicto

- **Se entiende, con un fallo grave.** El rechazo de EUR al añadirlo, el aviso
  de un EUR heredado y las tarjetas de Conectores se leen a la primera. El
  resto de la app sigue al día.
- **Alta:** al **quitar** EUR de la lista, el aviso no desaparece (ni en la
  sesión ni tras reiniciar). La persona hace lo que se le pide y el aviso
  sigue ahí (H1).
- **«Datos actualizados.» confirmado:** no aparece con ningún fallo parcial ni
  total en los casos probados (ver más abajo).
- Con las acciones y los textos de EUR no hay hallazgos de contraste ni de
  teclado.

## Cómo se probó

| Qué | Cómo |
| --- | --- |
| Build | `npm run build` (typecheck + `electron-vite build`) · EXIT 0 |
| App | Electron compilada (`out/`) con `TRADIA_E2E=1`, proveedor simulado, perfil limpio, reloj anclado al 6 oct 2026 |
| Guiones | Playwright fuera del repositorio (`/Users/dregos/qa-tiingo-claridad/{a,a2,b,c,d}.spec.ts`); registros en `…/out/*.log` |
| EUR heredado | La API ya rechaza EUR, así que se siembra como lo tendría quien lo guardó antes: con la app cerrada, `insert into watchlist(ticker,alta,orden)` en `tradia.db` y se reabre sin tocar nada más |
| Capturas | `docs/qa/capturas/perfiles-tiingo-*.png` |

Para reproducirlo a mano: `npm run build`, abrir con `TRADIA_E2E=1` y seguir los
pasos de cada perfil. El simulado declara EUR «sin cobertura» por defecto
(`TRADIA_E2E_UNCOVERED_TICKERS`).

## Sesión A · Profesional independiente que organiza varios proyectos

| # | Paso | ¿Se entendió sin ayuda? | Observado |
| --- | --- | --- | --- |
| A1 | Abrir Mercado con la lista vacía | Sí | «Tu lista está vacía.» y la ayuda «Acciones y ETF: AAPL, SPY o FXE. Divisas: EUR/USD o EURUSD.» |
| A2 | Añadir AAPL y MSFT | Sí | «AAPL se ha añadido…»; filas «✓ Fiable · ◇ Datos simulados» |
| A3 | Escribir `EUR` y pulsar Añadir | **Sí, con matiz** (H4) | Título «EUR no está disponible»; «Tiingo no ofrece datos para EUR. Puedes añadir EUR/USD, una divisa con calendario 24/5, o cambiar por FXE, un ETF que sigue una exposición parecida.» Botones «Añadir EUR/USD (divisa)», «Cambiar por FXE», «Ver conectores». La lista no cambia (`AAPL,MSFT`). El foco queda en el campo (`aria-invalid=true`) (`capturas/perfiles-tiingo-a-rechazo-eur.png`) |
| A4 | Aceptar «Cambiar por FXE» | Sí | «FXE se ha añadido a tu lista.»; lista `AAPL,MSFT,FXE`; ficha de FXE con velas |
| A5 | En otro perfil: `EUR/USD` | Sí | «EUR/USD se ha añadido a tu lista: divisa · 24/5 · cartera simulada.»; fila «Divisa · 24/5 · cartera simulada» |
| A6 | Casos límite: vacío, `€`, 80 caracteres, `spy`, duplicado | Sí | Vacío, `€` y 80 caracteres: «Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.»; `spy` se añade como SPY; duplicado «SPY ya está en tu lista.» |
| A7 | Teclado tras el rechazo | Sí | Enter envía; Tab recorre Añadir → Añadir EUR/USD → Cambiar por FXE → Ver conectores |
| A8 | Ajustes › Conectores, sin probar | Sí | Ambas tarjetas «Sin comprobar», «Última comprobación: Todavía no se ha comprobado», «Siguiente paso: Prueba la conexión…» |
| A9 | «Probar conexión» de Tiingo y FRED | Sí | «Funciona», «Última comprobación hoy a las 22:21», «Último dato 6 oct 2026»; Tiingo «No hay activos marcados sin cobertura.» y, con EUR/USD, «Divisas de tu lista: EUR/USD · cubierta por Tiingo FX» (`capturas/perfiles-tiingo-a-conectores.png`) |

## Sesión B · Responsable de equipo que revisa entregas

Lista con SPY, AAPL y un EUR heredado sin velas.

| # | Paso | ¿Se entendió sin ayuda? | Observado |
| --- | --- | --- | --- |
| B1 | Abrir la app (Inicio) | Sí | Aviso ámbar «1 activo necesita atención · EUR no está disponible en Tiingo · Solo EUR queda en pausa. Los demás activos, predicciones y señales siguen al día.» con «Cambiar por FXE» y «Quitar de la lista» (`capturas/perfiles-tiingo-b-aviso.png`). No usa rojo ni habla de caída |
| B2 | «Por qué ocurre con EUR» | **Parcial** (H5) | «Tiingo no ofrece datos para EUR en este conector. Puedes quitarlo… o cambiarlo por FXE.» y «…sin datos en fin de semana y con datos en los festivos de EE. UU.» |
| B3 | Comprobar que el resto sigue | **Parcial** (H3) | Régimen, macro (VIX, DGS10, CPIAUCSL «Fiable»), SPY y AAPL «Fiable». `freshness.state = current`. Pero la tarjeta «Precios · Simulado» de Inicio pasa a «Sin evaluar» |
| B4 | Mercado | Sí | Fila «EUR · Sin datos en Tiingo»; SPY y AAPL «Fiable» |
| B5 | Ajustes › Conectores › Probar conexión | Sí | Tiingo «Funciona» y debajo «EUR no está disponible en Tiingo. Alternativa disponible: FXE.» (`capturas/perfiles-tiingo-b-conectores-eur.png`). No hay contradicción |
| B6 | «Actualizar datos ahora» | Sí | «Actualizados 2 de 3 · sin datos: EUR». No aparece «Datos actualizados.» |
| B7 | Teclado en el aviso | Sí | Cambiar por FXE → Quitar EUR de la lista → Por qué ocurre con EUR; todos con nombre accesible propio |
| B8 | «Quitar de la lista» | **No** (H1) | La lista pasa a `SPY,AAPL` y aparece «EUR se ha quitado de tu lista.», pero el aviso «EUR no está disponible en Tiingo» **sigue** 15 s después, en Mercado y tras reiniciar |
| B9 | Con el proveedor caído y EUR | Parcial (H6) | Dos avisos: «Datos desactualizados desde el 6 oct 2026… Régimen, predicciones y señales en pausa hasta ponerse al día.» y el de EUR. «Ver detalles» no coincide con «Por qué ocurre» |

## ¿Aparece «Datos actualizados.» con fallos parciales?

**Desmentido.** Se buscó el texto en pantalla en estos estados y no aparece:

| Estado | Mensaje mostrado |
| --- | --- |
| 2 de 3 activos con EUR sin cobertura (Conectores › Actualizar datos ahora) | «Actualizados 2 de 3 · sin datos: EUR» |
| Aviso de Inicio con EUR sin cobertura | Sin «Datos actualizados.» |
| Proveedor caído (`simulateProviderFailure(true)`) con el reloj avanzado | `getByText('Datos actualizados.').count() === 0` |

## Hallazgos por severidad

### H1 · Alta · El aviso de EUR no desaparece al quitar el activo

- **Pasos:** sembrar EUR heredado (ver «Cómo se probó»), abrir la app, pulsar «Quitar de la lista» en el aviso (o «Quitar EUR de la lista»).
- **Esperado:** EUR sale de la lista y el aviso desaparece (guía: «ocultar tras quitar»).
- **Obtenido:** la lista queda `SPY,AAPL` y el mensaje «EUR se ha quitado de tu lista.» aparece, pero `dataStatus.freshness().uncovered` sigue devolviendo EUR y el aviso se mantiene 1, 3, 8 y 15 s después, en Mercado y tras reiniciar la app. La persona no puede librarse del aviso.
- **Causa probable:** `removeWatchlistTicker` (`repository.ts`) no borra la fila `ticker:EUR` de `data_status`, y `health.ts` (~915) construye `uncovered` solo con ese estado, sin cruzarlo con la lista. El E2E existente (`data-uncovered-banner.spec.ts`) oculta el fallo porque publica el resumen por IPC.
- **Evidencia:** `…/out/c.log` («t+15 banner headings=2 … freshness.uncovered=[EUR]») y `…/out/d.log` («Tras quitar y reiniciar: lista=SPY,AAPL uncovered=[EUR]»).
- **Rol:** backend.

### H2 · Media · El mismo aviso aparece dos veces en Inicio

- **Pasos:** con EUR heredado, abrir Inicio.
- **Esperado:** un solo aviso por activo.
- **Obtenido:** dos copias idénticas, una arriba (`data-freshness-banner`, «Estado de los datos») y otra dentro de «Conexión y fuentes» (`data-freshness-inline`, «Frescura de datos»). Ambas son regiones `role=status`, así que un lector de pantalla lo anuncia dos veces, y el Tab pasa por dos juegos de botones. En Mercado también hay dos (arriba y bajo el título).
- **Evidencia:** `capturas/perfiles-tiingo-b-inicio-duplicado.png`; `c.log` («Inicio: headings EUR = 2»).
- **Rol:** frontend.

### H3 · Media · «Precios · Simulado» pasa a «Sin evaluar» por un solo activo

- **Pasos:** con EUR heredado, abrir Inicio › «Conexión y fuentes».
- **Esperado:** «Disponible», como antes de que apareciera EUR, porque SPY y AAPL están al día y el aviso dice que «los demás activos siguen al día».
- **Obtenido:** «Precios · Simulado · Último cierre 6 oct 2026 · Sin evaluar».
- **Evidencia:** `b3.log`, bloque «Conexión y fuentes».
- **Rol:** frontend.

### H4 · Baja · El rechazo usa jerga sin explicar

- **Pasos:** escribir `EUR` y pulsar Añadir.
- **Esperado:** texto sin términos técnicos (la persona no sabe qué es un ETF ni «calendario 24/5»).
- **Obtenido:** «una divisa con calendario 24/5… un ETF que sigue una exposición parecida». Además el título dice «EUR no está disponible» sin «en Tiingo» (la guía lo fija). Un tercer botón, «Ver conectores», no se explica.
- **Rol:** frontend (textos).

### H5 · Baja · «Por qué ocurre» arrastra jerga

- **Pasos:** abrir «Por qué ocurre con EUR».
- **Obtenido:** «calendario 24/5, sin datos en fin de semana y con datos en los festivos de EE. UU.». La razón técnica del backend (`ticker 'EUR' no existe`) no se muestra, bien.
- **Esperado:** una frase corta sobre qué cubre Tiingo (acciones y ETF de EE. UU.).
- **Rol:** frontend (textos).

### H6 · Baja · Aviso de datos atrasados con el texto antiguo

- **Pasos:** forzar fallo del proveedor y avanzar el reloj.
- **Obtenido:** «Datos desactualizados… Régimen, predicciones y señales en pausa hasta ponerse al día.» con «Ver detalles» (la guía pide «Por qué ocurre»). Sigue sin contrastarse con el motor si de verdad se pausa (pendiente de `fix-1`/`supervise-10`).
- **Esperado:** texto verificado contra el motor y mismo vocabulario que el aviso por activo.
- **Rol:** frontend.

### H7 · Baja · Dos acciones en «Siguiente paso» de un conector que funciona

- **Pasos:** probar Tiingo con éxito.
- **Obtenido:** «Probar conexión» y «Actualizar datos ahora» en el mismo bloque; la guía pide una sola acción principal.
- **Rol:** frontend / design.

## Lo que no se pudo comprobar

- Con clave real de Tiingo (solo lo puede hacer la persona usuaria).
- Instalador y revisión visual en Windows y Linux.
- Contraste medido con herramienta: solo revisión visual en el tema claro (el E2E propio de la tarea anterior ya lo mide).

## Limpieza

Los guiones y los registros están fuera del repositorio. No se ha creado ningún
spec en `e2e/`. Las únicas altas del árbol son este informe y las seis capturas
`perfiles-tiingo-*.png`.

## Correcciones de H2–H6 (frontend)

_Cambios en `DataFreshness.tsx`, `UncoveredAssets.tsx`, `Watchlist.tsx`, `ConnectionBlock.tsx` y `ProviderConnectionResult.tsx`. H1 lo corrigió backend._

| Hallazgo | Qué se corrigió |
| --- | --- |
| H2 | El aviso por activo sin cobertura solo se pinta en la franja global (`variant="banner"`). La variante en línea de Inicio, Mercado, Macro e IA no renderiza nada (ni su `role=group`) cuando el único problema son activos sin cobertura, y su región de resultado de acción solo existe en la franja. Un único encabezado y un único juego de botones en el orden de Tab. |
| H3 | «Precios» de «Conexión y fuentes» ignora las filas `sin-cobertura` al evaluar el conector: con SPY y AAPL al día muestra «Disponible». Si todas las filas fueran sin cobertura sigue en «Sin evaluar». |
| H4 | Rechazo: título «EUR no está disponible en Tiingo»; «fondo cotizado en bolsa que se mueve de forma parecida» y «para seguir el tipo de cambio» en lugar de «ETF», «calendario 24/5» y «exposición parecida»; el enlace dice «Abrir Ajustes › Conectores». «Por qué ocurre»: una frase sobre qué cubre Tiingo (ETF explicado como «fondos cotizados») y, para EUR, «Solo tiene datos de lunes a viernes». |
| H5 | «Ver detalles» pasa a «Por qué ocurre». La frase de pausa ahora es «Mientras los datos estén atrasados no se calculan régimen, predicciones ni señales nuevas para esos activos. Lo ya calculado se conserva.» y solo se muestra con el estado `stale`. |
| H6 | En un conector que funciona, «Siguiente paso» contiene solo «Actualizar datos ahora»; «Probar conexión» queda como botón secundario fuera del bloque. Con clave rechazada o ausente, la única acción es «Revisar la clave»/«Añadir clave»; en el resto, «Probar conexión». El foco vuelve al botón de prueba si cambia de bloque. |

### Comprobación del motor que respalda el texto de H5

- `src/main/signals/engine.ts` (`evaluateTicker`): si la última vela es anterior a `expectedSessionDate(ticker)` devuelve `stale-data` y no evalúa ni emite señal.
- `src/main/ai/prediction/service.ts`: con la última vela por detrás de la sesión esperada no se llaman a `predictSessions`; las predicciones ya emitidas sí se siguen resolviendo.
- `src/main/ai/regime/service.ts`: no recalcula el régimen de ese activo y el resumen lo marca `stale`, sin habilitar ni desactivar estrategias.
- La guarda es **por activo y por fecha de vela**. Con estado `no-fiable` el motor no pausa nada por sí mismo (no hay lectura de `no-fiable` en señales ni en régimen), así que la frase ya no se muestra con datos no fiables. Antes se afirmaba una pausa global («Régimen, predicciones y señales en pausa») sin respaldo para ese estado.
