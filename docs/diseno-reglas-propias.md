# Diseño · reglas propias y estado de la suscripción

Esta extensión mantiene el **Cuaderno cuantitativo**: reglas y resultados se presentan como evidencia auditable, no como promesa. Amplía `docs/diseno-fase-2.md` y sustituye únicamente la antigua sección «Ajustes del LLM» de `docs/diseno-fase-6-7.md`. No existe ninguna opción de API de pago.

Las maquetas autocontenidas están en `.orquesta/design/7d9830c6/`. Producción debe consumir los tokens existentes de `src/renderer/src/design/`; `.orquesta/` nunca forma parte del runtime.

## Principios de interacción

1. La gramática aparece junto al campo: ayuda de una línea, ejemplos insertables y una referencia compacta. No se obliga a abrir un manual.
2. La validez se conoce antes de guardar o lanzar. Cada error nombra campo, problema y posición; nunca se sustituye por un error general al enviar.
3. `Stop` y `Objetivo` siguen siendo obligatorios como campos: para no aplicar uno se escribe literalmente `ninguno`.
4. El backtest, el estrés y la comparación por régimen se habilitan o bloquean con la misma validación. El bloqueo siempre explica el motivo antes de la acción.
5. La pérdida de Claude Code no oculta noticias: Tradia pasa al analizador local, lo dice en Noticias y Ajustes y notifica una sola vez por transición de estado.
6. «Suscripción (Claude Code)» y «Analizador local» son las únicas opciones visibles y accesibles.

## 1. Editor de reglas del formulario

### Estructura

La sección se titula `Reglas ejecutables` y abre con:

> `Escribe qué debe ocurrir para entrar y salir. Tradia comprueba cada regla mientras escribes.`

> `Las decisiones se calculan al cierre de la vela y se ejecutan en la apertura siguiente.`

En ventanas anchas hay dos columnas: los cuatro campos a la izquierda y `Lo que puedes usar` a la derecha. A 700 px se apilan, primero los campos y después la referencia. La referencia no es flotante en ventana estrecha.

Cada campo usa una etiqueta visible, ayuda, editor monoespaciado, resultado de validación y contador `n/500`. Los ejemplos son botones; al pulsarlos reemplazan el contenido del campo, validan y dejan el foco en el editor, con el cursor al final.

| Campo | Ayuda exacta | Ejemplos insertables exactos |
| --- | --- | --- |
| `Entrada` | `Una condición que indique cuándo abrir una posición larga.` | `cruza_arriba(sma(rapida), sma(lenta))`; `cruza_arriba(rsi(14), 30) y no (cierre < sma(200))` |
| `Salida` | `Una condición que indique cuándo cerrar la posición.` | `rsi(14) > 70 o cruza_abajo(sma(rapida), sma(lenta))` |
| `Stop` | `Distancia máxima de pérdida: porcentaje, múltiplo de ATR o ninguno.` | `2%`; `1,5 * atr(14)`; `ninguno` |
| `Objetivo` | `Distancia para tomar beneficio: porcentaje, múltiplo de ATR o ninguno.` | `6%`; `3 * atr(14)`; `ninguno` |

`Lo que puedes usar` enumera sin abreviaturas ocultas:

- Precio: `cierre`, `apertura`, `maximo`, `minimo`, `volumen`.
- Indicadores: `sma(n)` — media simple; `ema(n)` — media exponencial; `rsi(n)` — fuerza relativa; `atr(n)` — rango verdadero medio; `maximo(n)` — máximo de las n velas anteriores; `minimo(n)` — mínimo de las n velas anteriores.
- Cruces: `cruza_arriba(a, b)` y `cruza_abajo(a, b)`.
- Lógica: `y`, `o`, `no`.
- Comparaciones: `>`, `<`, `>=`, `<=`, `=`.
- Operaciones: `+`, `-`, `*`, `/` y paréntesis.
- Periodos: entero entre 1 y 500 o nombre de parámetro.

La lista `Parámetros de esta estrategia` muestra pares nombre/valor, por ejemplo `rapida · 20` y `lenta · 50`, y el texto:

> `Usa el nombre sin comillas. Si lo cambias en Parámetros, la regla se vuelve a validar.`

### Validación en vivo

Validar al escribir con un breve debounce visual de 150–250 ms; no anunciar el estado válido en cada tecla. El error se muestra en el mismo campo, enlazado mediante `aria-describedby`, y el editor recibe `aria-invalid="true"`.

Formato final:

> `{mensaje} · caracteres {inicio}–{fin}.`

Ejemplo:

> `Falta “)” para cerrar “cruza_arriba” · caracteres 1–13.`

Los índices que devuelve el analizador son el contrato; la interfaz los convierte a posiciones humanas empezando en 1. Al aparecer un error tras editar, el foco no se mueve. Al enviar con errores, el resumen superior usa `role="alert"`, escribe `Hay {n} errores. Corrige {primer campo} antes de guardar.` y el foco va al primer campo inválido. Cuando el usuario pulsa el mensaje de posición o intenta guardar, el rango `start/end` se selecciona en el editor con `setSelectionRange`.

### Estados del editor

| Estado | Texto y comportamiento | ARIA |
| --- | --- | --- |
| Vacío | `Completa las cuatro reglas. En Stop y Objetivo también puedes escribir ninguno.` Cada campo: `Escribe una regla o inserta un ejemplo.` Guardar desactivado. | Mensaje persistente `role="status"`; no alerta al cargar. |
| Válido | Cada campo: `Válida`. Resumen: `Reglas válidas · se pueden guardar y ejecutar.` | Resumen `role="status"` solo tras pasar de error a válido. |
| Error | Mensaje específico y posición en su campo. Resumen `Hay 1 error. Corrige Entrada antes de guardar.` | Campo con `aria-invalid`; error enlazado; resumen `role="alert"` tras enviar. |
| Cargando | `Cargando reglas de la estrategia…`; esqueletos con la geometría de los cuatro editores; sin estado válido momentáneo. | Contenedor `aria-busy="true"`; una región `role="status"`. |
| Guardando | Botón `Guardando…`; campos y ejemplos bloqueados sin borrar contenido. | Formulario `aria-busy="true"`; anunciar una vez. |
| Éxito | `Nueva versión guardada · las reglas se pueden ejecutar.` | `role="status"`; el foco permanece en Guardar. |
| Error de guardado | `No pudimos guardar la estrategia. Tus cambios se conservan; inténtalo de nuevo.` | `role="alert"`; no limpiar campos. |
| Sin permisos | `Necesitas permiso de edición. Puedes consultar las reglas, pero no cambiarlas.` | Editores `readonly`, no `disabled`, para conservar lectura y selección. |

### Orden de foco

`Saltar al contenido` → `Volver sin guardar` → navegación de secciones → `Entrada` → sus ejemplos → `Salida` → su ejemplo → `Stop` → sus ejemplos → `Objetivo` → sus ejemplos → `Ver reglas de sintaxis` → `Volver sin guardar` → `Guardar…`. La lista informativa de indicadores y parámetros no recibe foco. Todos los botones miden al menos 44 × 44 px; los ejemplos visualmente compactos mantienen una caja de interacción de 44 px en producción.

## 2. Ficha de estrategia propia

Entre cabecera y `Resumen de evidencia` se muestra siempre uno de estos estados.

### Ejecutable

Etiqueta: `Reglas ejecutables`.

> `Reglas listas para ejecutar`

> `Entrada, salida, stop y objetivo son válidos para esta versión. Puedes lanzar un backtest o las pruebas de estrés.`

Las acciones se llaman `Lanzar backtest`, `Ejecutar pruebas de estrés` y `Ejecutar comparación`. Un resultado correcto queda en `Historial` con versión, procedencia, periodo y enlace `Consultar informe`.

### Reglas no ejecutables

Etiqueta: `Reglas no ejecutables`.

> `Estas reglas no se pueden ejecutar: {primer mensaje del analizador} en {campo}, caracteres {inicio}–{fin}.`

Acción: `Editar reglas`.

El lanzador, el estrés y la comparación siguen en el orden de lectura y son botones enfocables con `aria-disabled="true"`, no controles retirados del DOM. Debajo de cada acción:

> `Desactivado hasta que las reglas se puedan ejecutar.`

El manejador de activación no ejecuta nada cuando `aria-disabled` es verdadero. No usar un tooltip como explicación.

### Estados de la ficha

| Estado | Texto y comportamiento | ARIA |
| --- | --- | --- |
| Vacío | `Aún no hay reglas ejecutables` + `Completa Entrada, Salida, Stop y Objetivo para probar esta estrategia.` + `Editar reglas`. | Región persistente `role="status"`. |
| Válido | Estado ejecutable anterior; acciones activas. | Si acaba de corregirse, `role="status"`; al cargar es información normal. |
| Error de reglas | Estado no ejecutable anterior; acciones con `aria-disabled`. | No `role="alert"` al cargar. Si aparece tras guardar, `role="alert"`. |
| Cargando | `Comprobando si las reglas se pueden ejecutar…`; las tres acciones se muestran bloqueadas. | Sección `aria-busy="true"`; texto `role="status"`. |
| Error técnico | `No se pudieron comprobar las reglas` + `El lanzador y las pruebas de estrés permanecen desactivados. Conservamos la ficha; prueba de nuevo.` + `Probar de nuevo`. | `role="alert"`; fallo cerrado: no habilitar con caché. |
| Sin permisos | `Necesitas permiso de edición para cambiar estas reglas. Sí puedes lanzar pruebas de esta versión si son ejecutables.` | Estado `role="status"`; se oculta `Editar reglas`, no las pruebas permitidas. |

Orden de foco: volver → selector de versión → editar (si procede) → `Editar reglas` del aviso (si procede) → contenido de ficha → `Lanzar backtest` → `Ejecutar pruebas de estrés` → `Ejecutar comparación` → historial. En una versión histórica, las reglas son solo lectura y las pruebas conservan la política ya definida para versiones históricas.

## 3. Ajustes › Análisis de noticias

El título final es `Análisis de noticias`, no `Análisis de noticias con LLM`. Descripción:

> `Elige la suscripción de Claude Code o el analizador local. Las noticias no crean señales por sí solas.`

Solo hay dos radios:

- `Suscripción (Claude Code)` — `Usa la sesión iniciada en este equipo. Si falla, Tradia continúa con el analizador local.`
- `Analizador local` — `Funciona sin sesión. Es más limitado, pero mantiene el análisis básico en el equipo.`

Con Suscripción se muestran `Ruta de Claude Code (opcional)`, ayuda `Déjala vacía para buscar claude automáticamente.`, `Máximo diario`, ayuda `Titulares por día.` y `Hoy: {usados} de {máximo} titulares`.

Con Analizador local:

> `Analizador local seleccionado`

> `No necesita sesión y seguirá funcionando aunque Claude Code no esté disponible.`

Acciones: `Probar de nuevo` y `Guardar ajustes`. Tras guardar: `Ajustes de análisis guardados.` Tras una prueba correcta:

> `Suscripción disponible`

> `Claude Code responde y la sesión está iniciada. El analizador local queda como respaldo.`

### Estados de Ajustes

| Estado | Texto final | ARIA |
| --- | --- | --- |
| Vacío/no configurado | `Elige cómo analizar las noticias` + `Selecciona Suscripción (Claude Code) o Analizador local y guarda los ajustes.` | `role="status"`; Guardar inactivo hasta elegir. |
| Válido | Estado `Suscripción disponible` o `Analizador local seleccionado`. | Resultado de prueba/guardado `role="status"`. |
| Error | Motivo y resolución de la tabla siguiente; conserva valores; `Probar de nuevo`. | `role="alert"` cuando cambia desde disponible; persistente sin alerta al reabrir. |
| Cargando | `Cargando ajustes de análisis…`; controles no aparecen habilitados de forma transitoria. | Sección `aria-busy="true"`; `role="status"`. |
| Probando | `Comprobando la suscripción…`; botón `Probando…`; evitar doble petición. | Formulario `aria-busy="true"`; resultado en región viva. |
| Sin permisos | `Necesitas permiso de edición` + `Puedes consultar el analizador elegido, pero no cambiarlo ni probar la suscripción.` | Campos visibles `disabled`; texto `role="status"`. |

Orden de foco: navegación de Ajustes → `Suscripción (Claude Code)` → `Analizador local` → ruta (solo Suscripción) → máximo diario → `Probar de nuevo` → `Guardar ajustes`. Los radios se recorren como un solo grupo con flechas según el comportamiento nativo.

## 4. Suscripción caída en Noticias y Ajustes

El aviso aparece después del título de Noticias y antes de los titulares. Ajustes lo muestra dentro de `Análisis de noticias`, antes de las acciones. Ambos usan el mismo estado y texto; en Noticias se sustituye la última frase por `Mientras tanto, las noticias se analizan con el analizador local.`

| Estado recibido | Título exacto | Paso exacto en Ajustes |
| --- | --- | --- |
| `cli-no-encontrada` | `Suscripción no disponible · CLI no encontrada` | `Instala Claude Code y vuelve a abrir Tradia. Si ya está instalado, indica su ruta en este ajuste. Mientras tanto, se usa el analizador local.` |
| `sin-sesion` | `Suscripción no disponible · sesión no iniciada` | `Abre un terminal, ejecuta claude y después /login. Vuelve aquí y prueba de nuevo. Mientras tanto, se usa el analizador local.` |
| `tope-diario` | `Suscripción en pausa · tope diario alcanzado` | `Espera al próximo día o aumenta el máximo diario de titulares. Hasta entonces se usa el analizador local.` |
| `error` | `No se pudo usar la suscripción` | `Comprueba la conexión y vuelve a probar. Mientras tanto, se usa el analizador local.` |

En Noticias, cada variante conserva la acción `Probar de nuevo`. Durante la prueba:

> `Comprobando la suscripción…`

> `Los titulares siguen visibles. No se enviará otra comprobación hasta que termine esta.`

Si se recupera:

> `Suscripción recuperada · los nuevos titulares volverán a analizarse con Claude Code.`

El aviso de error es `role="alert"` únicamente en la transición desde `ok`. Si la página se abre cuando el fallo ya existía, es una región nombrada, sin interrupción asertiva. La comprobación usa `aria-busy="true"`; el éxito usa `role="status"`. El foco permanece en `Probar de nuevo` después del resultado. Orden: título → aviso → `Probar de nuevo` → filtros → titulares.

### Notificación del sistema

Enviar una sola notificación al pasar de `ok` a un estado de fallo. Fallos repetidos con el mismo estado, incluida una sucesión de titulares, no vuelven a notificar. Si cambia el motivo mientras ya está fallando, se actualiza la interfaz pero no se envía otra notificación. Solo una recuperación a `ok` rearma el aviso.

Título de fallo para todos los motivos:

> `Tradia usa el analizador local`

Cuerpo por motivo:

- CLI no encontrada: `No se encontró Claude Code. Abre Ajustes › Análisis de noticias para resolverlo.`
- Sesión no iniciada: `La sesión de Claude Code no está iniciada. Abre Ajustes › Análisis de noticias para resolverlo.`
- Tope diario: `Se alcanzó el máximo diario de titulares. Tradia usa el analizador local hasta el próximo día.`
- Error: `Claude Code devolvió un error. Tradia usa el analizador local; abre Ajustes para volver a probar.`

Al recuperarse, una sola notificación:

- Título: `Suscripción de Claude recuperada`.
- Cuerpo: `Tradia vuelve a analizar los nuevos titulares con Claude Code.`

La activación de la notificación abre `Ajustes › Análisis de noticias`. No incluir rutas, salida de terminal, titulares ni datos sensibles.

## Contraste, tema oscuro y movimiento

Se reutilizan exclusivamente pares ya verificados:

| Uso | Tema claro | Contraste | Tema oscuro | Contraste |
| --- | --- | ---: | --- | ---: |
| Texto secundario | `#566174` / `#FFFEFA` | 6,20:1 | `#B8C1CE` / `#151F30` | 9,10:1 |
| Información/selección | `#1746C6` / `#E5EBFF` | 6,47:1 | `#8EACFF` / `#1B3265` | 5,62:1 |
| Válido | `#126B4B` / `#DDF3E9` | 5,59:1 | `#65D6A4` / `#12382C` | 7,19:1 |
| Atención | `#765500` / `#F5EAC2` | 5,68:1 | `#F4CB62` / `#3E3214` | 8,12:1 |
| Error | `#A12232` / `#FBE4E7` | 6,22:1 | `#FF8D9B` / `#4B1C26` | 6,39:1 |

El color siempre se acompaña de texto. Foco visible de 3 px con separación de 2 px. No se anima el resultado de validación; los esqueletos se vuelven estáticos con `prefers-reduced-motion`. A 200 % de zoom no hay desplazamiento horizontal del documento.

## Maquetas y contrato de implementación

- `.orquesta/design/7d9830c6/01-editor-reglas.html`: campos, ejemplos, catálogo, parámetros y estados.
- `.orquesta/design/7d9830c6/02-ficha-estrategia.html`: ejecutable/no ejecutable, acciones bloqueadas e historial.
- `.orquesta/design/7d9830c6/03-ajustes-noticias.html`: dos analizadores y estado de suscripción en Ajustes.
- `.orquesta/design/7d9830c6/04-aviso-suscripcion.html`: aviso en Noticias, cuatro motivos y notificación del sistema.

Los valores de mercado, fechas y titulares de las maquetas son ilustrativos. Los textos de control, estado, error y recuperación de este documento son finales y comprobables. Si el analizador devuelve un mensaje técnico, se registra; la interfaz usa el texto seguro definido aquí.

## Extensión: reglas de corto

El editor de estrategias propias añade `Entrada en corto` y `Salida del corto` entre
Salida y Stop, con los mismos tokens, editores y validación. Son opcionales: dejar
ambas vacías conserva una estrategia de largo. Si se escribe una, la otra debe
completarse y muestra su error aunque esté vacía, con `aria-describedby`, posición
y anuncio `aria-live="polite"`.

- `Insertar cruce de medias en corto` inserta `cruza_abajo(sma(rapida), sma(lenta))`.
- `Insertar salida del corto por cruce` inserta `cruza_arriba(sma(rapida), sma(lenta))`.
- Ambos botones funcionan por teclado y devuelven el foco y el cursor al editor.
- La ficha muestra `Opera en: largo`, `Opera en: corto` o `Opera en: largo y corto`
  según `strategySide`, y las dos reglas de corto; vacías se leen `No configurada`.
- El informe incluye la columna `Lado` con `Largo` o `Corto` en cada operación.

El aviso de dinero real es provisional en esta entrega: la tarea `fe-corto-real`
lo sustituye por el estado de los límites confirmados cuando el backend termine
la puerta del corto real. No representa un cambio de la decisión del usuario de
permitir cortos con los techos conservadores.
