# Diseño de fases 6–7 · IA predictiva y dinero real mínimo

Esta fase extiende el **Cuaderno cuantitativo** de Tradia. La interfaz explica qué ha calculado el sistema, con qué evidencia y qué puede hacer con ello; no presenta una predicción como certeza ni convierte el paso a dinero real en una mejora de plan o un gesto rutinario. Las fuentes ejecutables son `src/renderer/src/design/ai.tokens.json` y `src/renderer/src/design/live.tokens.json`. Ambas heredan los tokens existentes y no modifican pantallas ni tokens de fases anteriores.

## Principios de experiencia

1. **Probabilidad, no promesa.** Se escribe `Probabilidad de subida · 62 % · próximas 5 sesiones`, nunca `Subirá`, `Señal alcista segura` ni un precio objetivo atribuido al modelo. Horizonte, versión y aptitud del modelo acompañan siempre al porcentaje.
2. **Dos ejes de régimen.** Cada activo y el mercado muestran dirección (`Tendencia` o `Lateral`) y volatilidad (`Alta` o `Baja`). Ningún color sustituye esas palabras.
3. **La IA no manda sobre Riesgo.** Predicción y noticias solo confirman o reducen una señal creada por estrategias; no crean una orden por sí solas. El texto `No crea señales por sí solo · Riesgo conserva el veto` aparece junto a predicciones y resúmenes.
4. **Evidencia antes que acción.** Brier, referencia, periodos, calibración, versión, origen de datos y frescura permanecen visibles. Una marca `Datos sintéticos · no apto` bloquea el uso del modelo en señales, aunque sus métricas parezcan buenas.
5. **Degradación sostenida, no dramatización.** Una mala racha aislada se rotula como observación; solo el drift sostenido y los criterios definidos cambian el estado a `Degradada`.
6. **Paper y real son mundos inequívocos.** Paper conserva el morado de fase 5. Real usa una franja roja global con escudo y el texto completo `DINERO REAL`; no se representa con un pequeño punto ni solo con color.
7. **Activación deliberada y reversible.** La interfaz no puede completar requisitos automáticos. El usuario declara los manuales, escribe límites iguales o menores que los techos y confirma una frase exacta. La parada, la pérdida de conexión o un requisito automático incumplido suspenden órdenes nuevas.

## Navegación, jerarquía y responsive

La navegación de escritorio añade `IA` después de `Mercado`, `Salud de modelos` después de `IA` y `Dinero real` antes de `Ajustes`. Las extensiones de `Noticias` y de la ficha de `Estrategias` permanecen en sus destinos existentes.

La franja `DINERO REAL` se coloca inmediatamente bajo la barra de aplicación y antes de cualquier banner de página. Tiene un mínimo de 48 px y permanece en todas las rutas mientras el modo real esté activo o suspendido. En ventanas de 700 px, la navegación usa la variante compacta existente; el contenido conserva 20 px laterales. Tablas de régimen, salud y comparación mantienen su semántica dentro de contenedores desplazables con foco y aviso `Desplázate horizontalmente para ver todas las columnas`. Por debajo de 700 px las secciones se apilan, las acciones críticas ocupan todo el ancho y los diálogos dejan 20 px de margen. La app sigue siendo de escritorio: esta adaptación no cambia las plataformas fijadas.

No se usan tarjetas anidadas. Cada página es una hoja con secciones separadas por líneas; badges, barras y tablas son contenido, no decoración. Cifras, versiones, fechas, PSI, Brier, precios y porcentajes usan la familia numérica y cifras tabulares.

## Página «IA»

### Cabecera y lenguaje de incertidumbre

Título `IA`. Texto: `Régimen, probabilidades calibradas y decisiones de estrategia al cierre diario.` Debajo, un aviso persistente de información:

> `Son estimaciones, no certezas. Los modelos no crean señales por sí solos y nunca evitan el motor de riesgo.`

La cabecera muestra `Datos al cierre del 9 oct 2026 · 22:00 CEST` y acción `Actualizar`. Si hay una instantánea anterior, se escribe su hora; no se disfraza de presente.

### Régimen del mercado

El bloque principal se titula `Régimen del mercado` y usa SPY como referencia explícita. Presenta dos etiquetas con icono y texto: por ejemplo `Tendencia` y `Volatilidad alta`. Debajo:

- `Referencia SPY · cierre 9 oct 2026`.
- `Dirección: ADX(14) 29,4 y pendiente SMA50 positiva`.
- `Volatilidad: realizada 20 sesiones por encima de la mediana de 252`.
- `El régimen se recalcula al cierre; no predice por sí solo.`

La tabla `Régimen por activo` contiene `Activo`, `Dirección`, `Volatilidad`, `Calculado con datos hasta`, `Cambio anterior` y `Estrategias habilitadas`. Las etiquetas siempre escriben su significado. `Cambio anterior` usa texto como `Lateral → Tendencia · 7 oct`, además de una flecha SVG accesoriamente.

### Estrategias según el régimen

Tabla `Estrategias según el régimen` con `Estrategia`, `Estado por régimen`, `Funciona en`, `Falla en` y `Motivo`. Ejemplos finales:

- `Activa por régimen` · `Coincide: Tendencia. No coincide con ningún régimen de fallo.`
- `Desactivada por régimen` · `El mercado está en Tendencia y la estrategia declara que falla en Tendencia.`
- `Desactivada por régimen` · `Solo funciona en Lateral; el régimen actual es Tendencia.`
- `Degradada` · `El drift sostenido tiene prioridad. Revisa Salud de modelos.`
- `Régimen desactualizado` · `El régimen del mercado está desactualizado (último cierre …; se esperaba la sesión del …): no habilita ni desactiva.` — cuando el régimen guardado es anterior a la última sesión esperada; `Degradada` mantiene la prioridad.

Una estrategia desactivada conserva enlace `Ver ficha`; no ofrece un interruptor para eludir el motor. El estado no se expresa solo con opacidad.

### Predicción por activo

Selector de activo con etiqueta visible. El bloque usa esta jerarquía:

- `AAPL · estimación a 5 sesiones`.
- `Probabilidad de subida · 62 %`.
- `Probabilidad de bajada · 38 %`.
- `Volatilidad esperada · 3,8 % a 5 sesiones`.
- `Modelo v0.1.0+7f3a9c2 · calculado 9 oct 2026, 22:04 CEST`.
- Marca de aptitud: `Datos sintéticos · no apto` o `Apto para apoyar señales`.
- Ayuda: `Una probabilidad del 62 % no significa que el precio vaya a subir. Expresa la frecuencia estimada para este horizonte según este modelo.`

Las dos probabilidades comparten una barra de 100 %, pero cada segmento se rotula con porcentaje; la barra tiene `role="img"` y nombre `Probabilidad estimada: subida 62 %, bajada 38 %, horizonte 5 sesiones`. No se usan flechas de compra/venta ni palabras `alcista`/`bajista` como conclusión. Acción `Ver ficha del modelo`.

Si el modelo no es apto, aparece: `Solo información. Este modelo no puede influir en señales porque usa datos sintéticos.` Si es apto: `Puede confirmar o reducir una señal existente. No puede crearla.`

### Estados de «IA»

| Estado                 | Presentación y texto final                                                                                                                                                                                 | Acciones                                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Cargando               | Cabecera estable, esqueletos con la geometría de las dos tablas y del bloque de probabilidad; `Cargando régimen y estimaciones…`; `aria-busy="true"`.                                                      | Ninguna acción que dependa de datos.                    |
| Vacío                  | `Todavía no hay cierres suficientes para clasificar el régimen` + `Se necesitan velas diarias válidas antes de calcular el mercado y los activos.` Predicción: `Aún no hay una versión de modelo cargada.` | `Revisar fuentes de mercado`.                           |
| Error parcial          | Conserva la última instantánea con `Datos de {hora}`. Junto al bloque afectado: `No se pudo actualizar la predicción de AAPL` + causa segura.                                                              | `Reintentar`.                                           |
| Error total            | `No se pudo cargar la página IA` + motivo conocido. No reemplaza navegación ni franja global.                                                                                                              | `Reintentar` y `Ver estado de fuentes`.                 |
| Sin conexión           | Banner `Sin conexión · régimen y predicciones congelados desde {hora}. No se evaluarán señales nuevas.` La instantánea permanece visible.                                                                  | `Reintentar conexión`; Actualizar deshabilitado.        |
| Sin permisos           | `Tradia no puede leer el archivo del modelo` + ruta no sensible o nombre del recurso + `Revisa los permisos del archivo y vuelve a cargarlo.`                                                              | `Abrir ubicación del modelo`, si el sistema lo permite. |
| Éxito de actualización | Sin toast como único resultado: hora actualizada y anuncio vivo `Régimen y predicciones actualizados.`                                                                                                     | El foco permanece en `Actualizar`.                      |

## Ficha del modelo

Cabecera: `Modelo de dirección y volatilidad`, versión `v0.1.0+7f3a9c2`, horizonte `5 sesiones` y marca de aptitud. Si es sintético, la banda completa escribe `Datos sintéticos · no apto` y debajo `Se muestra para verificar la integración. No participa en señales ni órdenes.`

### Identidad y periodos

Lista de definición:

- `Versión`: semver y hash.
- `Archivo`: hash SHA-256 abreviado con acción `Copiar hash`.
- `Entrenamiento`: `2 ene 2015 – 29 dic 2021 · 60 %`.
- `Calibración`: `3 ene 2022 – 30 jun 2024 · 20 %`.
- `Prueba final intacta`: `1 jul 2024 – 30 sep 2026 · 20 %`.
- `Horizonte`: `5 sesiones`.
- `Origen`: `Datos sintéticos` o proveedor y universo reales.
- `Última evaluación`: fecha, hora y zona.

### Brier fuera de muestra

Comparación, no una cifra aislada:

- `Modelo · 0,184`.
- `Referencia · 0,213`.
- `Diferencia · −0,029 · mejor que la referencia`.

Texto de ayuda: `En Brier, menos es mejor. 0 indica probabilidades perfectas; la comparación solo usa la prueba final fuera de muestra.` Cuando no mejora: `No supera la referencia · no apto para apoyar señales.` Una mejora en datos sintéticos no elimina la marca `no apto`.

### Diagrama de calibración

Título `Calibración fuera de muestra`. Eje X `Probabilidad estimada`; eje Y `Frecuencia observada`. Línea discontinua `Calibración ideal`; línea sólida `Modelo`. No se rellena el área, para evitar sugerir volumen. Leyenda visible y descripción: `Cuanto más cerca esté la línea del modelo de la diagonal, mejor corresponden sus porcentajes con lo observado.`

El SVG del gráfico no es la única representación. Una tabla accesible, visible mediante `Ver datos del gráfico`, contiene `Intervalo estimado`, `Probabilidad media`, `Frecuencia observada` y `Casos`. El botón controla un panel con `aria-expanded`; Enter y Espacio lo abren, Escape lo cierra si se presenta como popover, y el foco no salta al gráfico.

### Estados de la ficha

- **Cargando:** identidad estable y esqueletos en métricas/gráfico; `Cargando ficha del modelo…`.
- **Vacío:** `No hay una ficha asociada a esta versión` + `El modelo no puede apoyar señales sin periodos, métricas y calibración guardados.` + `Abrir carpeta de modelos`.
- **Error:** `No se pudo verificar la ficha del modelo` + `El modelo queda no apto hasta resolverlo.` + `Reintentar`.
- **Sin conexión:** la ficha local se mantiene; solo se bloquea cualquier recurso remoto. Texto `Ficha local · no se pudo comprobar si existe una versión posterior.`
- **Sin permisos:** `No se puede leer model-card.json` + recuperación.
- **Éxito:** `Ficha verificada · hash y versión coinciden` como estado persistente y anuncio moderado.

## Ficha de estrategia · ampliación de régimen

En la ficha existente, después de `Mercados y temporalidades`, se añade `Régimen de mercado` con dos grupos editables:

- `Funciona en`: opciones `Tendencia`, `Lateral`, `Volatilidad alta`, `Volatilidad baja`.
- `Falla en`: las mismas opciones.

Cada opción es un checkbox real con etiqueta y objetivo de 44 px, no un chip que dependa del color. Una etiqueta no puede quedar simultáneamente en ambos grupos; el error escribe `Tendencia no puede estar a la vez en “Funciona en” y “Falla en”.` El guardado exitoso anuncia `Régimen de la estrategia guardado.`

### Comparación con y sin filtro

Sección `Efecto del filtro de régimen`. Encabezado común: `Mismos datos, periodo y costes · 2 ene 2018 – 30 sep 2026`. Tabla con columnas `Métrica`, `Sin filtro`, `Con filtro` y `Diferencia`; filas `Rentabilidad`, `Drawdown máximo`, `Sharpe`, `Operaciones` y `Tasa de acierto`. Las diferencias incluyen signo y unidad. Debajo:

> `Esta comparación muestra el efecto del filtro; no demuestra que vaya a mejorar resultados futuros.`

Si no existe par comparable: `Todavía no hay un backtest emparejado con y sin filtro de régimen` + `Ejecutar comparación`. Si difieren periodo, universo o costes, no se comparan: `Comparación no válida · los dos backtests no usan la misma base.`

Estados: esqueletos por fila; vacío anterior; error `No se pudo cargar la comparación`; sin conexión conserva el último resultado con fecha; sin permisos de edición mantiene lectura y escribe `No puedes editar esta estrategia`; éxito de guardado inline.

## Noticias · resumen y sentimiento

Cada noticia añade, debajo de la fuente y la confirmación, un bloque `Análisis automático`:

- `Resumen`: dos frases como máximo, atribuidas al sistema y nunca presentadas como titular original.
- `Activos`: etiquetas por ticker.
- `Sentimiento`: `Favorable`, `Neutral`, `Desfavorable` o `Mixto`, siempre precedido por la palabra `Sentimiento`.
- `Método`: `LLM · claude-haiku-4-5-20251001` o `Análisis local`.
- `Analizado`: fecha y hora.
- Texto fijo: `Puede ajustar la confianza de una señal existente. No crea señales y Riesgo conserva el veto.`

Un titular no confirmado muestra la insignia exacta con escudo de alerta y borde discontinuo: `Sin verificar · no genera señales`. Su análisis, si existe para lectura, se rotula `Solo contexto`; nunca aparece una acción de operar. Si falla el análisis, el titular original y su fuente permanecen visibles.

Estados del bloque: `Analizando titular confirmado…`; `Sin análisis · el LLM está desactivado y el clasificador local no encontró activos`; `No se pudo analizar este titular`; `Pendiente de conexión`; `Sin permiso para usar la clave guardada`; y éxito con método y hora. En carga se usa un esqueleto de dos líneas, no se sustituye el titular.

## Ajustes del LLM

Sección `Análisis de noticias con LLM`. Estado inicial apagado:

> `Desactivado · Tradia usa análisis local sin coste. Activar el LLM puede generar cargos de Anthropic.`

Controles:

- Interruptor `Usar LLM para titulares confirmados`, con `Activado/Desactivado` anunciado además de la posición.
- Campo secreto `Clave de API de Anthropic`; ayuda `Se cifra en el llavero del sistema y no vuelve a mostrarse.`
- Valor fijo visible `Modelo · claude-haiku-4-5-20251001`.
- Campo `Máximo diario de titulares` con valor inicial `200`, mínimo 1 y máximo técnico documentado por implementación.
- Campo `Tope mensual` en euros. Valor de presupuesto actual `0,00 €`; cualquier valor mayor requiere confirmación y no puede superar `30,00 €` sin una decisión de producto nueva.
- Resumen `Hoy: 34 de 200 titulares · Coste estimado 0,18 €` y `Este mes: 3,42 € de 10,00 €` cuando esté activo.
- Acciones `Probar conexión` y `Guardar ajustes`.

Al activar con un presupuesto mayor que cero, diálogo: `Confirmar gasto del LLM`, desglose del tope y texto `Este límite controla el uso de Tradia, pero no sustituye las alertas de facturación de Anthropic.` Acción primaria `Aceptar tope de {importe} al mes`; segura `Seguir con análisis local`.

Estados: comprobando con campos bloqueados y texto; error de autenticación, límite 429 y red con recuperación concreta; sin llavero seguro vacía la clave; sin conexión conserva ajustes y bloquea la prueba; éxito `Conexión correcta · la clave se ha guardado cifrada`; sin permisos `El llavero del sistema no permite leer la clave`.

## Página «Salud de modelos»

Cabecera: `Salud de modelos`. Texto: `Drift de datos, resultados y estrategias. Tradia nunca reentrena automáticamente.` Resumen textual: `1 degradada · 2 en observación · 5 saludables`, con iconos y palabras.

### Tabla de salud

Columnas: `Modelo o estrategia`, `Estado`, `Drift de datos`, `Drift de resultados`, `Persistencia`, `Última revisión` y `Acción`.

- Datos: `PSI > 0,25 en 2 variables · 20 sesiones` o `Dentro del rango`.
- Resultados: `Brier móvil 0,229 · +0,045 frente a ficha` o `Aún no hay 60 predicciones resueltas`.
- Estrategia: `34 operaciones · desviación −36 % · 2 revisiones`.
- Motivo de degradación: `Drift sostenido. No se debe a una sola racha perdedora.`
- Racha aislada: `En observación · racha de 4 pérdidas dentro del máximo de backtest (6). No degrada la estrategia.`

La expansión de fila muestra variables concretas, valor actual, referencia y umbral. `Ver detalle` es un botón con `aria-expanded`; las filas no son enteras clicables.

### Propuestas de reentrenamiento

Una propuesta contiene `Propuesto el`, `Motivo`, `Datos que se usarían`, `Último reentrenamiento`, `Próxima fecha permitida` y advertencia `Reentrenar no sustituye la validación fuera de muestra. La nueva versión no se activa sola.` Acciones `Aprobar y abrir instrucciones` y `Posponer`. Aprobar abre un diálogo informativo sobre el pipeline externo; no ejecuta trabajo silencioso. Posponer pide fecha y motivo.

Cuando el trimestre ya tiene una propuesta: `No se propondrá otro reentrenamiento hasta {fecha}.` Nunca hay un botón `Reentrenar ahora` en una alerta de mala racha.

### Estados de salud

| Estado              | Texto final                                                                                                                |
| ------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Cargando            | `Calculando salud con las últimas revisiones…`; esqueletos de resumen y filas.                                             |
| Vacío inicial       | `Aún no hay predicciones resueltas ni operaciones suficientes` + `La salud aparecerá cuando exista una muestra evaluable.` |
| Vacío de propuestas | `No hay reentrenamientos propuestos` + `Los modelos se mantienen bajo vigilancia.`                                         |
| Error parcial       | Conserva filas válidas; la afectada dice `No evaluado · faltan datos de referencia`.                                       |
| Error total         | `No se pudo calcular la salud de los modelos` + `Reintentar`.                                                              |
| Sin conexión        | `Sin conexión · la revisión queda pausada. Últimos resultados de {hora}.` No cambia estados por ausencia de datos.         |
| Sin permisos        | `No se puede leer la distribución de referencia` + `El modelo queda en observación hasta recuperar el acceso.`             |
| Éxito               | Fecha actualizada y anuncio `Revisión de salud completada. Una estrategia requiere atención.`                              |

## Pantalla «Dinero real»

La pantalla se abre siempre en estado bloqueado hasta que el proceso principal confirme todas las condiciones. Cabecera `Dinero real` y advertencia:

> `Capital real en riesgo. La mayoría de los traders minoristas pierden dinero. Completa cada requisito y confirma límites bajos antes de activar.`

Estado principal con escudo: `Dinero real bloqueado · faltan 4 de 7 requisitos`. No se muestra una celebración al completar; cambia a `Listo para confirmar · revisa los límites una última vez`.

### Lista de comprobación

Cada fila contiene icono, `Cumplido`, `Pendiente` o `Revisar`, título, evidencia, fecha y origen `Verificación automática` o `Declaración del usuario`.

Requisitos finales:

1. `Validación fuera de muestra guardada` · automático, para cada estrategia que operará en real.
2. `Paper continuo durante al menos 3 meses, 30 operaciones y desviación dentro de ±30 %` · automático.
3. `Parada de emergencia probada en los últimos 30 días` · automático.
4. `Canal externo de alertas activo y prueba correcta` · automático.
5. `Claves live sin permiso de retirada` · declaración fechada: `Declaro que estas claves no permiten retirar fondos.`
6. `Plan de contingencia documentado` · declaración fechada y campo/enlace local: `He revisado el plan para caída de internet, broker y equipo.`
7. `Revisión legal y fiscal con profesionales` · declaración fechada: `He revisado con profesionales mis obligaciones legales y fiscales.`

Los cuatro requisitos automáticos no tienen checkbox editable; usan un candado y acción contextual (`Ver validación`, `Ver paper`, `Probar parada`, `Probar alertas`). Los manuales son checkboxes con texto completo y fecha; al desmarcarlos, el modo real se suspende para nuevas órdenes.

### Límites escritos

Panel `Límites de capital real` con techo del sistema y valor elegido. Campos:

- `Capital total en real` · máximo `1.000,00 USD`.
- `Máximo por orden` · máximo `200,00 USD`.
- `Pérdida diaria máxima` · máximo `20,00 USD`.
- `Posiciones abiertas simultáneas` · máximo `2`.

Cada campo muestra `Tu límite` y `Techo fijo de esta fase`. El error es específico: `Tu límite por orden supera el techo de 200,00 USD.` No se permite guardar mientras un valor sea cero, negativo o superior al techo. Éxito: `Límites guardados · todavía debes confirmarlos por escrito.`

Tras guardar, aparece la frase generada con los valores exactos. Ejemplo:

> `ACTIVO DINERO REAL CON 500 USD, 100 USD POR ORDEN, 10 USD DE PÉRDIDA DIARIA Y 1 POSICIÓN`

El usuario no la escribe en la página; la frase se exige dentro del diálogo final y cambia si cambia cualquier límite.

### Botón bloqueado y lista de motivos

El botón mantiene el texto `Activar dinero real`, pero queda deshabilitado cuando falte cualquier condición. Inmediatamente antes del botón hay una región `aria-live="polite"` titulada `No se puede activar todavía` con todos los motivos devueltos por el proceso principal, por ejemplo:

- `Faltan 12 días para completar 3 meses de paper continuo.`
- `Solo hay 24 de 30 operaciones requeridas.`
- `La prueba de parada tiene 41 días; debe tener menos de 30.`
- `No has declarado la revisión legal y fiscal.`
- `Guarda y confirma los límites de capital real.`

No se usa un tooltip como única explicación. Si una llamada IPC directa o la acción de interfaz es rechazada, la misma lista se actualiza y el mensaje de error escribe `Activación rechazada · los requisitos siguen pendientes.` El foco se mueve al encabezado `No se puede activar todavía` solo tras un intento explícito; en carga normal no se roba foco.

### Diálogo de confirmación

Solo se abre tras una respuesta del proceso principal que indique que todos los requisitos están vigentes. Es `role="alertdialog"`, título `Confirmar activación de dinero real` y resume:

- `Broker: Alpaca Live · cuenta •••• 4821`.
- Los cuatro límites elegidos.
- `Las órdenes usan capital real y pueden generar pérdidas.`
- `Riesgo conserva el veto. Sin conexión, con la parada activa o si deja de cumplirse un requisito automático, las órdenes nuevas se suspenden.`

Etiqueta de campo: `Escribe exactamente esta frase para confirmar`. La frase se muestra como texto seleccionable, no como placeholder. El botón final dice `Activar dinero real con estos límites` y sigue deshabilitado hasta coincidencia exacta tras normalizar solo espacios exteriores; no se ignoran mayúsculas ni números. Acción segura `Cancelar y seguir en paper` recibe el foco inicial. Escape cancela, el foco queda atrapado mientras está abierto y vuelve a `Activar dinero real`. Al confirmar, se vuelve a comprobar todo en el proceso principal; un cambio concurrente cierra el diálogo, vuelve a la lista y muestra los requisitos actuales.

### Estados de «Dinero real»

| Estado       | Presentación y recuperación                                                                                                                                       |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cargando     | Filas esqueleto, límites bloqueados y `Comprobando requisitos en el proceso principal…`; no mostrar momentáneamente un botón habilitado.                          |
| Vacío        | `No hay estrategias seleccionadas para dinero real` + `Elige primero qué estrategias podrían operar y vuelve a validar sus fichas.` + `Revisar estrategias`.      |
| Bloqueado    | Recuento y lista completa de motivos; acción deshabilitada.                                                                                                       |
| Listo        | `Todos los requisitos están vigentes` + límites sin error; acción habilitada, todavía sin modo real.                                                              |
| Error        | `No se pudo verificar la lista. Dinero real permanece bloqueado.` + motivo seguro + `Reintentar`. Fallo cerrado, nunca habilitar por caché.                       |
| Sin conexión | `Sin conexión · no se puede activar dinero real.` Si ya estaba activo: `DINERO REAL SUSPENDIDO · no se enviarán órdenes nuevas.`                                  |
| Sin permisos | Para llavero o claves: `Tradia no puede acceder a las claves live. Dinero real permanece bloqueado.` + recuperación.                                              |
| Éxito        | Franja global visible, estado `Dinero real activo` y anuncio asertivo `Dinero real activado con los límites confirmados.` El foco pasa al estado, no a una orden. |

## Franja global «DINERO REAL»

Fondo `color.live.banner`, texto de alto contraste, icono de escudo-alerta y contenido:

> `DINERO REAL · Capital en riesgo · Alpaca Live •••• 4821`

A la derecha: `Capital 500 USD · Orden 100 USD · Pérdida diaria 10 USD · 1 posición` y enlace de 44 px `Ver límites`. Nunca se colapsa a un icono. En 700 px puede ocupar dos líneas; `DINERO REAL` permanece al principio.

Variantes con el mismo rojo y texto/icono:

- `DINERO REAL SUSPENDIDO · Sin conexión · No se enviarán órdenes nuevas`.
- `DINERO REAL SUSPENDIDO · Parada de emergencia activa`.
- `DINERO REAL SUSPENDIDO · Requisito automático vencido: prueba de parada`.

La franja no sustituye el botón global de parada. Si hay parada, la acción disponible es `Ver parada`; si hay desconexión, `Ver conexión`. El rojo cumple AA en ambos temas y el significado depende también de escudo, palabra `DINERO REAL` y estado literal.

## Prueba de humo real y estado del escalado

### Panel de prueba de humo

Título `Prueba de humo · 1,00 USD reales`. Advertencia: `Esta prueba compra una fracción de SPY, la vende y concilia el resultado. Usa dinero real.` Requisitos previos: modo real activo, mercado compatible, conexión, parada inactiva y límites suficientes.

La línea de estado tiene tres pasos textuales:

1. `Compra enviada`.
2. `Posición cerrada`.
3. `Conciliación sin descuadres`.

Cada paso usa icono y hora. Durante el proceso, el paso actual escribe `En curso`; no depende de una animación. El botón `Ejecutar prueba de 1,00 USD` abre una confirmación breve con foco inicial en `Cancelar`. Después de iniciar, no se puede lanzar otra; el botón dice `Prueba en curso…`.

Resultado conciliado:

- `Hora · 10 oct 2026, 15:42:18 CEST`.
- `Precio pedido compra · Mercado`.
- `Precio ejecutado compra · 673,42 USD`.
- `Precio ejecutado cierre · 673,39 USD`.
- `Slippage · +4 pb · desfavorable`.
- `Nocional · 1,00 USD`.
- `Conciliación · Sin diferencias`.
- Acción `Ver entrada en Diario`.

Si se intenta superar un techo: `Orden bloqueada antes de llegar al broker · el nocional 250,00 USD supera el máximo por orden de 100,00 USD.` Si compra, cierre o conciliación falla, se nombra el paso y se ofrece `Reanudar cierre`, `Conciliar de nuevo` o `Ver orden`; nunca se oculta una posición abierta.

Estados: `No ejecutada`; carga del historial; `En curso`; `Cerrada y conciliada`; `Fallida con posición abierta`; `Fallida sin posición`; error de carga; sin conexión con último paso conservado; sin permisos de claves live. Los estados críticos usan `role="alert"`; los progresos, `role="status"`.

### Escalado

Panel `Estado del escalado` siempre no accionable en esta fase. Estado inicial:

> `Escalado bloqueado · esta fase limita el capital a los techos confirmados.`

Muestra evidencia: meses en real, operaciones conciliadas, desviación frente al backtest, drawdown y cumplimiento de reglas. Si aún falta muestra: `Evidencia en curso · 8 de 30 operaciones reales`. Si los resultados respaldan el backtest: `Elegible para evaluación en fase 8 · Tradia no aumenta límites automáticamente.` No existe botón para subir techos; solo `Ver evidencia`.

## Teclado, foco y lectores de pantalla

- Orden lógico: franja global → navegación → título → estado/aviso → filtros → contenido → acciones. Un enlace `Saltar al contenido` es el primer elemento enfocable.
- Todos los controles y filas desplegables tienen al menos 44 × 44 px. `:focus-visible` usa contorno de 3 px `base.color.*.focus`, separado 2 px.
- Enter y Espacio activan botones, checkboxes, switches y desplegables. Escape cierra popovers y diálogos sin aplicar; el foco vuelve al disparador.
- Los diálogos atrapan el foco. En confirmaciones destructivas o de capital real, el foco inicial va a la acción segura.
- Las tablas usan encabezados reales. Los contenedores con scroll reciben `tabindex="0"`, nombre accesible y sombra de continuidad; no capturan flechas cuando no tienen foco.
- Gráficos tienen título, descripción y tabla alternativa. Las líneas se distinguen por patrón además del color.
- Carga usa `aria-busy`; éxito usa `role="status"`; errores y suspensión real usan `role="alert"`. No repetir cada tick de una animación.
- Con `prefers-reduced-motion`, las transiciones duran 0 ms. Los indicadores conservan texto. No se animan porcentajes, precios ni la franja real.

## Tema oscuro y contraste

Los temas usan pares explícitos `light/lightSurface` y `dark/darkSurface`; no se invierten automáticamente. El rojo real está reservado para capital real, suspensión y requisitos pendientes, no para probabilidades. El verde puede indicar cumplimiento o estado saludable, nunca `ganancia segura`.

Los contrastes declarados en los tokens se comprueban entre texto y su superficie semántica. `DINERO REAL` usa blanco sobre `#861F31` en claro y `#2B0710` sobre `#F2A7B2` en oscuro. Los requisitos pendientes usan `#8B1E2D` sobre `#FBE4E7` y `#FFB2BD` sobre `#4B1C26`. Todos superan 4,5:1. Icono, etiqueta y motivo redundan el color.

## Matriz de implementación

| Componente                 | Estados obligatorios                                                | Texto o regla clave                                    |
| -------------------------- | ------------------------------------------------------------------- | ------------------------------------------------------ |
| `RegimeSummary`            | cargando, conocido, sin clasificar, obsoleto, error                 | dos ejes, método y fecha                               |
| `RegimeAssetTable`         | cargando, vacío, error parcial, congelado                           | dirección + volatilidad escritas                       |
| `StrategyRegimeStatus`     | activa, desactivada, degradada, desactualizada                      | motivo humano, sin bypass                              |
| `ProbabilityPanel`         | cargando, disponible, no apto, sin modelo, error                    | porcentaje + horizonte + versión; nunca certeza        |
| `ModelCard`                | completa, sintética, no apta, incompleta, error, sin permisos       | Brier vs referencia, periodos y calibración            |
| `RegimeBacktestComparison` | cargando, comparable, no comparable, vacío, error                   | mismos datos, periodo y costes                         |
| `NewsAnalysis`             | local, LLM, sin analizar, sin verificar, cargando, error            | `Sin verificar · no genera señales`                    |
| `LlmSettings`              | apagado, comprobando, activo, límite, error, sin llavero            | coste, tope y clave cifrada                            |
| `ModelHealthTable`         | saludable, observación, degradado, insuficiente, error              | drift sostenido; mala racha aislada no basta           |
| `RetrainProposal`          | disponible, pospuesta, ya propuesta este trimestre                  | nunca automático                                       |
| `LiveChecklist`            | cargando, bloqueado, listo, error, sin conexión                     | automático bloqueado; manual declarado y fechado       |
| `LiveLimits`               | limpio, validación, guardando, pendiente de frase, confirmado       | valores iguales o menores que techos                   |
| `LiveActivation`           | deshabilitado con motivos, diálogo, comprobación concurrente, éxito | frase exacta y segunda validación en proceso principal |
| `LiveBanner`               | activo, suspendido por red, parada o requisito                      | siempre global, icono + `DINERO REAL`                  |
| `LiveSmokeTest`            | no ejecutada, en curso, conciliada, fallo con/sin posición          | 1 USD, precios, slippage y Diario                      |
| `ScalingStatus`            | bloqueado, evidencia en curso, elegible para evaluación             | sin acción para elevar techos                          |

Los mockups de `.orquesta/design/e43b6d0f/` son referencia visual. Este documento gobierna comportamiento, copias, accesibilidad y estados cuando exista cualquier diferencia.
