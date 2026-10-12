# Diseño · Tour guiado, «Primeros pasos», «Probar conexión» y datos desactualizados

Este documento continúa el **Cuaderno cuantitativo** (ver `docs/diseno-fase-6-7.md`). Resuelve tres problemas que ha detectado el usuario: la app es «un lío enorme» para quien llega nuevo, no se puede comprobar que Tiingo y FRED funcionan, y los datos desactualizados se muestran de varias formas contradictorias.

- Tokens: `src/renderer/src/design/onboarding.tokens.json`. No crea colores nuevos: todos salen de `base.tokens.json` y de `market.tokens.json` (`color.dataStatus`).
- Maquetas: `06-tour-guiado.html`, `07-primeros-pasos.html`, `08-probar-conexion.html` y `09-datos-desactualizados.html` en la carpeta de diseño de la fase.
- Implementan: `fe-tour-guiado` (tour, «Primeros pasos» y «Ver el tour de nuevo») y `fe-datos-conexion` («Probar conexión» y `DataFreshness`).
- Este documento no cambia ningún componente ni pantalla existente. Solo define qué atributos `data-tour` debe añadir Frontend.

## Principios

1. **El tour enseña, no actúa.** Navega por hash y resalta elementos, pero nunca pulsa un botón, guarda un ajuste, activa la parada ni toca el dinero real.
2. **El aviso de riesgo va siempre antes.** El tour solo arranca cuando `RiskGate` ya ha dejado pasar al usuario. Nunca lo sustituye ni lo salta.
3. **Una sola verdad sobre los datos.** Toda la app usa un único componente de frescura (`DataFreshness`), con la misma fecha, el mismo motivo y las mismas acciones en cualquier pantalla.
4. **Cada error tiene su salida.** Ningún estado de conexión o de datos se queda en «Error»: siempre dice qué pasa y qué botón lo resuelve.
5. **La clave nunca vuelve.** Ni la prueba de conexión ni sus mensajes muestran, repiten ni enmascaran parcialmente la clave.

## 1. Tour guiado

### Cuándo aparece

| Situación                                                                                                                        | Comportamiento                                                                                                                                   |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Perfil vacío, después de aceptar el aviso de riesgo                                                                              | Arranca solo en el paso 1.                                                                                                                       |
| `onboardingTourVersion` distinto de `ONBOARDING_TOUR_VERSION` y sin completar                                                    | Arranca solo en el paso guardado o, si no hay ninguno, en el 1.                                                                                  |
| Tour completado o saltado (`onboardingTourCompletedAt` con fecha y versión vigente)                                              | No vuelve a aparecer solo.                                                                                                                       |
| Tour en pausa (Esc o «Cerrar»)                                                                                                   | No vuelve a abrirse en la misma sesión. En el siguiente arranque se reabre en el paso guardado. También se puede retomar desde Inicio o Ajustes. |
| Hay un diálogo abierto (`role="dialog"` o `role="alertdialog"`, p. ej. reanudar tras la parada) o el aviso legal está a la vista | Espera a que se cierre.                                                                                                                          |
| «Ver el tour de nuevo» en Ajustes                                                                                                | Arranca en el paso 1, aunque esté completado. Al terminar o saltar se actualiza la fecha.                                                        |

Persistencia: `onboardingTourVersion` y `onboardingTourCompletedAt` en AppSettings (contrato). El paso en curso se guarda en `localStorage` con la clave `tradia.tour.step` (número de 1 a 10, sin datos personales). Se borra al completar o saltar.

### Anatomía

- **Velo** (`color.tour.scrim`) sobre toda la ventana, incluidas la barra lateral, la franja y la barra de estado.
- **Recorte** del elemento ancla, con un margen de 8 px y radio de 12 px. Encima, un **anillo** de foco de 3 px (`spotlightRing`) con un **halo** de superficie de 2 px (`spotlightHalo`). El halo es necesario porque en tema claro el anillo azul sobre el velo solo da 1,39:1.
- **Globo** (`popover`) de 360 px, con radio de 16 px y la sombra flotante. Va junto al ancla (derecha, abajo, izquierda o arriba, en ese orden de preferencia), separado 16 px y a 20 px del borde de la ventana como mínimo.
- Contenido del globo, de arriba abajo:
  1. Etiqueta `Paso 3 de 10` (`stepLabel`) y el botón de cerrar (icono X, 44 × 44, `aria-label="Cerrar el tour y retomarlo más tarde"`).
  2. Título (`h2`, 18/26, semibold).
  3. Texto (14/20, 2 o 3 frases como mucho).
  4. Progreso: 10 segmentos de 20 × 4 px, decorativos (`aria-hidden`).
  5. Acciones: `Saltar tour` (botón de texto, a la izquierda), `Atrás` (secundario) y `Siguiente` (primario), todos de 44 px de alto como mínimo.
- Por debajo de 760 px de ancho, el globo pasa a ser una hoja inferior a todo el ancho, con 20 px de margen. El recorte se mantiene.
- Si el ancla no existe o no se ve (la pantalla aún carga, está vacía o tiene un error), el globo se centra **sin recorte** y el paso sigue siendo válido. El texto no cambia. Se espera al ancla un máximo de 1,5 s antes de centrar.

El elemento resaltado es **inerte** mientras dura el tour: todo lo que hay fuera del globo lleva `inert`. Así no se puede activar por error la parada, un formulario ni el dinero real.

### Pasos y textos finales

El aviso de riesgo (`RiskGate`) se muestra antes y no cuenta como paso. Cada paso navega primero a su ruta (`window.location.hash`), espera al ancla, la desplaza a la vista (`scrollIntoView({ block: 'center' })`) y después mueve el foco al título del globo.

| #   | Ruta           | Ancla (`data-tour`)   | Dónde se pone                                                                       | Selector de respaldo                                   |
| --- | -------------- | --------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | (la actual)    | — (globo centrado)    | —                                                                                   | —                                                      |
| 2   | `#inicio`      | `inicio-situacion`    | Contenedor `.dashboard-grid` de `Dashboard.tsx`                                     | `.dashboard-grid`                                      |
| 3   | `#mercado`     | `mercado-lista`       | La lista de seguimiento de `MarketWorkspace.tsx`                                    | `section[aria-label="Datos de mercado"]`               |
| 4   | `#fuentes`     | `fuentes-lista`       | Sección principal de `news/SourcesPage.tsx` (lista y «Añadir fuente»)               | `#contenido`                                           |
| 5   | `#estrategias` | `estrategias-lista`   | Lista de estrategias de `StrategiesPage.tsx`                                        | `#contenido`                                           |
| 6   | `#riesgo`      | `parada`              | Botón «Parada» de `risk/KillSwitchControl.tsx`, en la cabecera de todas las páginas | `.top`                                                 |
| 7   | `#ordenes`     | `ordenes-paper`       | Tabla (o estado vacío) de `OrdersPage.tsx`                                          | `#contenido`                                           |
| 8   | `#ia`          | `ia-regimen`          | Bloque «Régimen del mercado» de `ai/RegimePanel.tsx`                                | `section:has(#ai-regime-title)` y, si no, `#contenido` |
| 9   | `#dinero-real` | `dinero-real-lista`   | Sección de la lista de comprobación de `ChecklistPage.tsx`                          | `#contenido`                                           |
| 10  | `#ajustes`     | `ajustes-proveedores` | Sección «Proveedores de datos» de `DataProvidersSettings.tsx`                       | `section[aria-label="Proveedores de datos"]`           |

Todas las rutas existen hoy en `App.tsx` (`inicio`, `mercado`, `fuentes`, `noticias`, `estrategias`, `riesgo`, `ordenes`, `ia`, `salud-modelos`, `dinero-real` y `ajustes`).

**Paso 1 · Bienvenida**

- Título: `Te enseñamos Tradia en 2 minutos`
- Texto: `Tradia vigila el mercado, prueba estrategias con datos del pasado y te avisa con probabilidades, no con corazonadas. Por defecto todo es simulado: no se mueve dinero real. Son 10 pasos y puedes saltarlos cuando quieras.`
- Botones: `Saltar tour` · `Empezar` (sin «Atrás»).

**Paso 2 · Inicio**

- Título: `Inicio: el estado de un vistazo`
- Texto: `Aquí ves la situación del mercado, las señales del día, tus posiciones en paper y si los datos están al día. Si algo necesita tu atención, aparece primero aquí.`

**Paso 3 · Mercado y lista de seguimiento**

- Título: `Mercado: tu lista de seguimiento`
- Texto: `Añade los activos que quieres vigilar. Tradia descarga sus velas diarias de Tiingo y los indicadores macro de FRED. Sin claves de los proveedores no hay datos reales.`

**Paso 4 · Fuentes y Noticias**

- Título: `Fuentes y Noticias`
- Texto: `Elige de dónde llegan las noticias (RSS, fuentes oficiales y APIs). En Noticias verás cada titular con su fiabilidad. Un titular sin confirmar nunca crea una señal por sí solo.`

**Paso 5 · Estrategias y backtest**

- Título: `Estrategias: probadas con el pasado`
- Texto: `Cada estrategia tiene su ficha: en qué régimen funciona, en cuál falla y su backtest con datos que no ha visto. Si no supera la validación, no se usa.`

**Paso 6 · Riesgo y parada**

- Título: `Riesgo manda sobre todo lo demás`
- Texto: `Todas las señales pasan por el motor de riesgo, con sus límites de pérdida y de exposición. Este botón detiene al instante todas las órdenes nuevas. El tour no lo pulsa: solo te enseña dónde está.`

**Paso 7 · Señales y Órdenes en paper**

- Título: `Señales y órdenes en paper`
- Texto: `Las señales aprobadas por Riesgo se convierten en órdenes simuladas (paper). Aquí ves cada orden, su estado y su conciliación con el broker. Arriba, la cabecera indica siempre el modo: «Señales + paper trading».`

**Paso 8 · IA y Salud de modelos**

- Título: `IA: régimen y probabilidades`
- Texto: `La IA clasifica el régimen del mercado y estima la probabilidad de subida o bajada, con su ficha y su calibración. En Salud de modelos verás si un modelo se degrada y cuándo toca reentrenarlo. La IA nunca se salta a Riesgo.`

**Paso 9 · Dinero real (bloqueado)**

- Título: `Dinero real: bloqueado hasta que cumplas la lista`
- Texto: `El modo real está bloqueado. Para activarlo hacen falta meses de validación en paper, la parada probada, alertas activas, claves sin permiso de retirada, un plan de contingencia, revisión legal y fiscal y tus límites confirmados por escrito. No hay atajos.`

**Paso 10 · Ajustes**

- Título: `Ajustes: conecta tus datos`
- Texto: `Pega aquí tus claves de Tiingo y FRED y pulsa «Probar conexión» en cada una. Verás «Conectado» y la fecha del último dato, o el motivo exacto si falla. Puedes volver a ver este tour desde aquí.`
- Botones: `Atrás` · `Terminar` (secundario) · `Terminar y añadir claves` (primario). El segundo marca el tour como completado, cierra y pone el foco en el campo «Clave de API de Tiingo».

### Comportamiento y teclado

| Acción    | Botón                                                             | Teclado                                                         | Efecto                                                                                                                                       |
| --------- | ----------------------------------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Siguiente | `Siguiente` (`Empezar` en el 1)                                   | `Intro` o `Espacio` sobre el botón; `→` con el foco en el globo | Va al paso siguiente y guarda `tradia.tour.step`.                                                                                            |
| Atrás     | `Atrás` (no aparece en el 1)                                      | `←` con el foco en el globo                                     | Va al paso anterior.                                                                                                                         |
| Saltar    | `Saltar tour`                                                     | —                                                               | Cierra sin confirmación, guarda la versión y `onboardingTourCompletedAt`, y anuncia: `Tour omitido. Puedes verlo cuando quieras en Ajustes.` |
| Pausar    | X `Cerrar`                                                        | `Esc`                                                           | Cierra, conserva el paso y anuncia: `Tour en pausa en el paso 4 de 10. Retómalo desde Inicio o Ajustes.`                                     |
| Retomar   | `Retomar el tour (paso 4 de 10)` en «Primeros pasos» y en Ajustes | —                                                               | Abre en el paso guardado.                                                                                                                    |
| Relanzar  | `Ver el tour de nuevo` en Ajustes, sección «Ayuda»                | —                                                               | Abre en el paso 1.                                                                                                                           |
| Terminar  | `Terminar` o `Terminar y añadir claves`                           | —                                                               | Guarda la versión y la fecha y borra el paso.                                                                                                |

- **Foco atrapado** en el globo: `Tab` y `Mayús+Tab` recorren X → `Saltar tour` → `Atrás` → `Siguiente` y vuelven al principio.
- Al abrir y en cada cambio de paso, el foco va al **título** del globo (`tabIndex=-1`), no al botón. Así el lector de pantalla lee el paso completo y `Intro` no avanza dos pasos por error.
- `→` y `←` solo actúan cuando el foco está dentro del globo. Nunca se capturan en campos de texto.
- Al cerrar, el foco vuelve al `h1` de la página en la que se queda el usuario. Si el tour se lanzó desde Ajustes, vuelve al botón que lo abrió (salvo con «Terminar y añadir claves»).
- Mientras el tour está abierto, la navegación por hash del propio tour no dispara el foco al `h1` de `App.tsx`: el foco sigue en el globo.

### Lector de pantalla

- El globo es `role="dialog"`, con `aria-modal="true"`, `aria-labelledby` apuntando al título y `aria-describedby` al texto.
- El título incluye el progreso para quien no ve la etiqueta: `<span class="sr-only">Paso 3 de 10. </span>Mercado: tu lista de seguimiento`. La etiqueta visible `Paso 3 de 10` lleva `aria-hidden` para que no se lea dos veces.
- Los avisos de saltar y pausar se emiten en una región `role="status"` fuera del diálogo, que sigue en el DOM al cerrarse.
- El recorte y el velo son `aria-hidden`. El resto de la app es `inert`, y el lector no lo recorre.

### Movimiento reducido

Con `prefers-reduced-motion: reduce`, el recorte salta de un ancla a otra sin transición, el globo aparece sin desvanecido y `scrollIntoView` usa `behavior: 'auto'`. Sin esa preferencia, el recorte se desplaza en 200 ms y el globo entra en 120 ms (`motion` de los tokens).

### Estados del tour

- **Cargando el ancla:** globo centrado con el texto del paso y `aria-busy="true"` durante como mucho 1,5 s. No hay esqueleto propio.
- **Ancla ausente o pantalla en error:** globo centrado sin recorte. El texto del paso no cambia y no se muestra ningún error del tour.
- **Error al guardar el progreso** (`settings:update` falla al terminar o saltar): el tour se cierra igual y la región de estado dice `No pudimos guardar que has visto el tour; puede volver a aparecer la próxima vez.`
- **Sin permisos:** no aplica; el tour no pide permisos. Si el usuario no ha aceptado el aviso de riesgo, el tour no existe todavía.

## 2. Tarjeta «Primeros pasos» en Inicio

Va arriba en Inicio, antes de `HomePhaseNotices`, con el ancho del contenido. Es una sola hoja con líneas, sin tarjetas anidadas.

- Título (`h2`): `Primeros pasos`. A la derecha, `2 de 3 hechos` (texto, cifras tabulares).
- Tres filas, cada una con icono y etiqueta de estado (`firstSteps.done` o `pending`), un texto y una acción:

| #   | Texto                                                                                         | Hecho cuando                                                                        | Acción si falta                                                                         |
| --- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 1   | `Añade tus claves de Tiingo y FRED` · `Sin ellas no hay velas ni datos macro reales.`         | `secrets.hasKey('tiingo')` y `hasKey('fred')`                                       | `Añadir claves` → `#ajustes`, foco en el campo de Tiingo (o en FRED si Tiingo ya está)  |
| 2   | `Prueba la conexión` · `Comprueba que cada proveedor responde y hasta qué fecha tiene datos.` | Último resultado `ok` en los dos proveedores (data-status `provider:*` en `fiable`) | `Probar conexión` → `#ajustes`, foco en el primer «Probar conexión» que no esté en `ok` |
| 3   | `Añade tus fuentes de noticias` · `Elige al menos una fuente para recibir titulares.`         | Al menos una fuente activa                                                          | `Añadir fuente` → `#fuentes`                                                            |

- Si el paso 2 falló (`clave-rechazada`, `cuota`, `sin-red` o `error`), la fila usa `firstSteps.attention`, con la etiqueta `Revisar` y el motivo corto: `Tiingo rechazó la clave`.
- Pie: `Retomar el tour (paso 4 de 10)` si hay un tour en pausa; si no, `Ver el tour`.
- **Cargando:** `Comprobando tu configuración…` con las tres filas en `pending` y sin acciones.
- **Error:** `No pudimos comprobar tu configuración.` con el botón `Reintentar`.
- **Sin permisos (llavero del sistema no disponible):** la fila 1 dice `El llavero del sistema no está disponible, así que no se pueden guardar claves.` con la acción `Ver ayuda en Ajustes`.
- **Todo hecho:** la tarjeta se reduce a una línea de éxito: `Todo listo: Tradia ya recibe datos y noticias.`, con el botón `Ocultar`. Al ocultarla no vuelve a aparecer (`localStorage`: `tradia.firstSteps.hidden`). Si después falta una clave, reaparece.

## 3. «Probar conexión» (Ajustes › Proveedores de datos)

Sustituye al botón deshabilitado y al texto «estará disponible…» de `DataProvidersSettings.tsx`. El botón está **siempre habilitado** salvo mientras prueba. Sin clave, devuelve `sin-clave` con su acción; nunca queda un botón gris sin explicación.

Bajo el botón, una línea de resultado con `role="status"` (`aria-live="polite"`) y una etiqueta de estado (icono y texto, nunca solo color).

| Estado (`ProviderTestResult.status`) | Etiqueta              | Texto (Tiingo; con FRED, igual cambiando el nombre)                                                                  | Acción                                                                  |
| ------------------------------------ | --------------------- | -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| (nunca probado)                      | `Sin probar`          | `Aún no has probado la conexión.`                                                                                    | `Probar conexión`                                                       |
| probando                             | `Probando`            | `Probando la conexión con Tiingo…` (botón: `Probando…`, `aria-disabled`)                                             | —                                                                       |
| `ok`                                 | `Conectado`           | `Conectado. Último dato disponible: vie 10 oct 2026. Comprobado hoy a las 18:42 (312 ms).`                           | `Actualizar datos ahora` (`market.refreshNow`)                          |
| `sin-clave`                          | `Sin clave`           | `Falta la clave de Tiingo. Pégala arriba y pulsa «Guardar clave de Tiingo».`                                         | `Añadir clave` (foco en el campo)                                       |
| `clave-rechazada`                    | `Clave rechazada`     | `Tiingo ha rechazado la clave. Comprueba que la has copiado entera o genera una nueva en tu cuenta.`                 | `Cambiar clave` (foco en el campo) · enlace `Abrir mi cuenta de Tiingo` |
| `cuota`                              | `Cuota agotada`       | `Has agotado la cuota de peticiones de Tiingo. Se renueva sola; vuelve a probar más tarde.`                          | `Probar de nuevo`                                                       |
| `sin-red`                            | `Sin red`             | `No hay conexión a internet. Tradia volverá a intentarlo al recuperar la red.`                                       | `Probar de nuevo`                                                       |
| `error`                              | `Error del proveedor` | `Tiingo no ha respondido como esperábamos: {message}. Vuelve a probar; si se repite, revisa el estado del servicio.` | `Probar de nuevo`                                                       |

- Enlaces de cuenta (externos, con `(abre en el navegador)` solo para lector de pantalla): Tiingo `https://www.tiingo.com/account/api/token` y FRED `https://fredaccount.stlouisfed.org/apikeys`.
- **Fechas:** `latestDataDate` es una fecha de sesión (día de mercado) y se muestra sin hora: `vie 10 oct 2026`. `checkedAt` se muestra en la zona horaria local del usuario: `hoy a las 18:42`, `ayer a las 09:10` o `8 oct a las 09:10`. «Hoy» se calcula con la fecha local, nunca con UTC.
- `{message}` es el texto del backend, que nunca contiene la clave. Frontend no concatena nunca el valor del campo en ningún texto, `aria-label` ni registro.
- Al guardar una clave nueva, el resultado anterior se borra y vuelve a `Sin probar`. No se prueba sola: lo decide el usuario.
- Tras un `ok`, el estado de `provider:tiingo` en data-status pasa a `fiable` y el indicador de frescura se recalcula.

## 4. Indicador único «Datos desactualizados desde …» (`DataFreshness`)

Un único componente con dos presentaciones que leen el mismo cálculo:

- **Franja** (`variant="banner"`): sustituye a las franjas por proveedor de `ProviderBanner`. Es una sola franja en `main`, arriba, para toda la app.
- **Chip** (`variant="inline"`): va en la cabecera de Inicio, Mercado, Macro e IA, al lado del título de la sección o de `Datos al cierre…`.

### Cálculo compartido

- Entradas: las entradas de data-status `ticker:*`, `macro:*` y `provider:*`.
- Estado agregado, por prioridad: `offline` (conectividad) > `unreliable` (alguna `no-fiable`) > `stale` (alguna `desactualizado`) > `catchingUp` (alguna `actualizando`) > `noData` (ninguna con `lastOkAt`) > `current`.
- **«Desde»**: el `lastOkAt` **más antiguo** entre las entradas afectadas. Es una fecha de sesión, sin hora: `Datos desactualizados desde el vie 3 oct 2026`.
- **Motivo**: el `reason` del backend de la entrada más antigua. Si falta, se usa `Faltan {n} sesiones: la última esperada es la del {fecha}.`
- La regla de qué es «desactualizado» (calendario de mercado y margen) es de Backend (`be-frescura-datos`). Frontend no la recalcula: un fin de semana o un festivo no muestran nada.

### Estados y textos

| Estado       | Franja                                                                                                                                    | Chip                             | Acciones                                                           |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `current`    | (no se muestra)                                                                                                                           | `Al día · cierre del vie 10 oct` | —                                                                  |
| `catchingUp` | `Poniéndose al día…` · `Descargando 3 de 7 activos. Régimen, predicciones y señales esperan a terminar.`                                  | `Poniéndose al día…`             | —                                                                  |
| `stale`      | **`Datos desactualizados desde el vie 3 oct 2026`** · `{motivo}` · `Régimen, predicciones y señales están en pausa hasta ponerse al día.` | `Desactualizado desde 3 oct`     | `Actualizar ahora` (primario) · `Probar conexión` · `Ver detalles` |
| `unreliable` | **`Datos no fiables desde el vie 3 oct 2026`** · `{motivo}` · misma línea de pausa                                                        | `No fiable desde 3 oct`          | igual que `stale`                                                  |
| `offline`    | **`Sin conexión: datos del vie 3 oct 2026`** · `Tradia se pondrá al día sola al volver la red.`                                           | `Sin conexión · datos del 3 oct` | `Ver detalles` (sin «Actualizar ahora», que no tendría efecto)     |
| `noData`     | **`Aún no hay datos de mercado`** · `Añade tus claves de Tiingo y FRED para empezar.`                                                     | `Sin datos`                      | `Ir a Ajustes`                                                     |

- `Actualizar ahora` llama a `market.refreshNow()`. Mientras espera: `Actualizando…` (`aria-disabled`). Respuestas, en una región `role="status"`: aceptada → `Actualización solicitada. Esperando datos verificados.`; rechazos con los textos actuales de `ProviderBanner` (`sin-conexion`, `sin-proveedor`, `sin-activos`, `en-curso`); fallo → `No pudimos iniciar la actualización. Inténtalo de nuevo.`; al ponerse al día, la franja desaparece y se anuncia `Datos al día.`
- `Probar conexión` lleva a `#ajustes` con el foco en el botón «Probar conexión» del proveedor afectado más antiguo.
- `Ver detalles` es un `<details>` con una lista, una fila por proveedor y una por grupo: `Tiingo · AAPL, MSFT, SPY · último dato vie 3 oct · Desactualizado` y `FRED · DFF · último dato mar 30 sep · No fiable`. Cada fila lleva su motivo.
- La franja es `role="region"` con `aria-label="Estado de los datos"` y una región `role="status"` dentro para los cambios. No usa `role="alert"`: se queda mientras dura el problema y no debe interrumpir en cada pantalla.
- **Cálculo en pausa en cada pantalla:** IA, régimen y predicción muestran, en el lugar del dato, `En pausa: datos desactualizados desde el vie 3 oct 2026.` con el chip. No muestran un número viejo como si fuera actual.
- Con `OfflineBanner` visible, la franja de datos no repite el «Sin conexión» global: muestra solo la fecha de los datos y `Ver detalles`.

## 5. Accesibilidad (AA)

- **Contraste** (calculado con WCAG 2.2; el detalle está en los tokens):
  - Título del globo 15,55:1 (claro) y 15,15:1 (oscuro); texto 6,20:1 y 9,10:1.
  - Etiqueta `Paso n de 10`: 6,47:1 y 5,62:1.
  - Todas las etiquetas de estado de conexión y frescura sobre su superficie, entre 5,49:1 y 8,49:1. Texto de tinta sobre las superficies de franja, 11,39:1 o más.
  - Anillo del resaltado sobre la superficie: 5,40:1 (claro) y 8,45:1 (oscuro). Halo sobre el velo en claro: 3,89:1 (no textual, mínimo 3:1).
  - Foco visible dentro de las franjas amarilla y roja: 4,52:1 y 4,50:1 (claro), y 6,42:1 y 7,19:1 (oscuro). Todos superan el 3:1 de componente.
- **Foco** visible con el `outline` de 3 px existente. El orden de tabulación sigue al orden visual. No hay trampas de foco salvo la del diálogo del tour, que se libera con `Esc`.
- **Objetivos** de 44 × 44 px como mínimo: botones del globo, X, acciones de franja y de chip (el chip mide 32 px de alto, pero su acción es un botón de 44 px o el chip entero con área ampliada).
- **Sin depender del color**: cada estado lleva icono y palabra.
- **Movimiento reducido**: sección 1. El icono de carga no gira con `prefers-reduced-motion`.
- **Textos alternativos**: los iconos son `aria-hidden` porque la palabra va al lado. Los enlaces externos llevan `(abre en el navegador)` solo para lector de pantalla, con la clase `sr-only`, nunca visible. Hoy `sr-only` solo existe con ámbito de página (`journal.css`, `strategies.css` y `orders.css`). Frontend la sube a `styles.css` como clase global; así también se corrige el fallo de «(abre en el navegador externo)» visible en Noticias.

## 6. Notas para implementar

- Atributos `data-tour` que añadir (sin cambiar el aspecto): `inicio-situacion`, `mercado-lista`, `fuentes-lista`, `estrategias-lista`, `parada`, `ordenes-paper`, `ia-regimen`, `dinero-real-lista` y `ajustes-proveedores`.
- La lista de pasos debe vivir en un único arreglo tipado (`TOUR_STEPS`) con `id`, `route`, `anchor`, `fallback`, `title` y `body`, para que las pruebas recorran los mismos datos que se ven.
- El recorte se dibuja con un único elemento posicionado y `box-shadow: 0 0 0 9999px var(--tour-scrim)`, recalculado con `ResizeObserver` y al desplazar.
- Ajustes, sección «Ayuda» (al final, antes de «Legal»): `Ver el tour de nuevo` y, si hay pausa, `Retomar el tour (paso n de 10)`.
- Los tokens se exponen con el mismo patrón de `tokens.ts`; no se copian valores a mano en CSS.
