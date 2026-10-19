# Tradia · Pantallas y dominios de «Telemetría de box»

Extensión de la marca aprobada en `guia.md` y `tokens.json`. Modo de uso: operar durante sesiones largas, con riesgo y frescura visibles. Idea visual: la pantalla del ingeniero de pista, con carriles de medida, cifras alineadas y una sola señal de acción en lima. El símbolo Arco, los colores base y las familias tipográficas se conservan.

## Entrega e integración

- `dominio.tokens.json` contiene diez objetos superiores: `ai`, `broker`, `dashboard`, `data-clarity`, `live`, `market`, `news`, `onboarding`, `risk`, `strategy`. Cada objeto sustituye los valores de su archivo homónimo, sin añadir ni retirar claves, índices de arrays o tipos. Conserva etiquetas, iconos, códigos, descripciones y pistas de estado. Se actualizan también metadatos de contraste y las copias locales de tipografía y superficies para impedir que una pantalla restaure la marca anterior.
- El objeto `base` no forma parte de esta entrega. Sus valores siguen siendo los de `tokens.json`; los domina `fe-base-identidad`.
- El código de la app nunca importa ni lee `.orquesta/`. Frontend debe copiar cada objeto al JSON correspondiente de `src/renderer/src/design/`, y aplicar los estilos por pantalla. La copia versionada de estos valores está en `docs/diseno/dominio.tokens.json`.
- Las maquetas contienen CSS, SVG y cuatro fuentes WOFF2 incrustadas. No hacen peticiones externas ni llaman IPC. Son especificaciones visuales: los controles no ejecutan operaciones, guardan ajustes ni aceptan el aviso legal. Solo funcionan la navegación entre muestras, las casillas locales y los desplegables de estados.
- `00-indice.html` es el visor de revisión; su texto y controles de tamaño pertenecen a la documentación. El desplegable «Estados» al pie de cada muestra también es documentación, no una función que deba añadirse a la app.
- `contraste-dominio.json` conserva los pares, valores y ratios sin redondear a dos decimales. La tabla de esta guía es su presentación para implementación y revisión.

## Maquetas y textos

Existen `-oscuro.html` y `-claro.html` para cada uno de los cinco grupos. Ambos siguen `prefers-color-scheme`; `?tema=oscuro` o `?tema=claro` fija una variante únicamente para revisión. No se añade un selector de tema al producto.

| Archivo (sin sufijo de tema) | Contenido y elemento memorable                                                                                                               | Procedencia del texto                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `01-marco-inicio`            | Marco completo; Inicio por carriles, con fuentes y señales como primeras lecturas. Cifras macro alineadas sobre una misma línea de medida.   | `App.tsx`, `SystemStatus.tsx`, `dashboard/Dashboard.tsx`, `ConnectionBlock.tsx`, `SignalsBlock.tsx`, `PositionsBlock.tsx`. |
| `02-mercado`                 | Seguimiento y gráfico de velas dominante; alcista vacía frente a bajista sólida; RSI y ATR en carriles subordinados.                         | `market/AssetSearch.tsx`, `Watchlist.tsx`, `PriceChart.tsx`.                                                               |
| `03-estrategias-riesgo`      | Dos pantallas sucesivas, con anclas `#estrategias` y `#riesgo`. Biblioteca como tabla de evidencia; límites como formulario de reglaje.      | `strategies/StrategyLibrary.tsx`, `risk/RiskPage.tsx`, `LimitsForm.tsx`, `VetoLog.tsx`.                                    |
| `04-noticias-ajustes`        | Dos pantallas sucesivas, anclas `#noticias` y `#ajustes`. Titulares en cinta temporal y configuración en filas de etiqueta, ayuda y control. | `news/NewsFeed.tsx`, `SettingsPage.tsx`, `settings/AiSettings.tsx`.                                                        |
| `05-aviso-bienvenida`        | Aviso completo, seguido de la bienvenida y primeros pasos (`#bienvenida`). El mensaje de capital en riesgo domina sobre la marca.            | `RiskDisclaimer.tsx`, `shared/riskDisclaimer.ts`, `onboarding/tourSteps.ts`, `FirstStepsCard.tsx`.                         |

Los titulares de Noticias son las fixtures existentes de `e2e/news-phase.spec.ts` y `e2e/news-sentiment.spec.ts`; no son noticias actuales. Los nombres de estrategias son los del catálogo de backtest. Precios, horas, rentabilidades y volúmenes son datos ilustrativos para comprobar densidad y alineación, nunca evidencia de rendimiento. Las etiquetas, ayudas, mensajes de error y los tres párrafos del aviso legal mantienen el texto de la app. Los valores iniciales mostrados de Riesgo proceden de `RISK_DEFAULTS`; cualquier dato de la app real prevalece sobre la muestra. No copiar datos de maqueta al estado de aplicación.

Los archivos que reúnen dos pantallas son hojas de presentación, no una propuesta de fusionar rutas. Mantener todas las secciones, filtros, acciones, campos, indicadores y validaciones existentes aunque una muestra solo muestre una parte representativa. No cambiar roles, selectores ni textos de pruebas E2E.

## Composición y escala

La barra lateral de 228 px es el marco existente exigido por la tarea. Dentro de ella no hay rejilla de tarjetas: Inicio se compone de carriles a todo el ancho (`layout.dashboard.* = span 12`), con columna de título de 200 px y contenido flexible. Las métricas, las tablas y las posiciones se separan por reglas de 1 px y espacio. No introducir sombras alrededor de estos carriles.

A 1440 px: margen de página 32 px, intervalos 24/32 px, bloque principal de hasta 1120 px según la base, controles de 44 px mínimo. La maqueta reserva algo más de ancho exterior para leer tablas; el contenedor de producción conserva el límite normativo de los tokens. A menos de 1050 px la lista de seguimiento pasa encima del gráfico; a menos de 760 px los carriles tienen una columna y la navegación conserva todos sus destinos mediante desplazamiento horizontal. Es adaptación a ventanas estrechas de Electron, no una plataforma móvil nueva. Una tabla ancha tiene desplazamiento dentro de su propia región con foco; no provoca desbordamiento de la ventana ni oculta columnas.

Sora 400/500/600/700 para texto, controles y títulos; IBM Plex Mono 400/500/600 para cifras, horas, precios, códigos y porcentajes. Escala heredada: 13/18, 14/21, 16/24, 18/26, 24/30 y 36/40 px; portada del aviso 48/52 px. Los metadatos no deben reducirse para encajar. En `data-clarity`, se conservan sus nombres especiales de escala (`caption`, `small`, `body`, `titleSmall`, `title`, `display`) y se alinean sus valores con los niveles de la marca. La lectura de frases permanece en Sora; la monoespaciada identifica medidas, no decora.

Proporción: acero en aproximadamente 93 % del área, texto y medidas en 5 %, lima en 2 %. La navegación activa, la acción principal y el foco comparten lima. Los colores de estado son excepciones semánticas puntuales. En claro, la lima de texto y trazo es `#4A6500`; `#C6F432` nunca se pone como texto sobre blanco.

El cursor «AHORA» y la zona de previsión de la dirección de marca se aplican únicamente a visualizaciones que ya contengan predicción. Las medias móviles del gráfico de Mercado son medidas históricas: no se prolongan hacia el futuro, no se colorean como predicción y no se añade un área de pronóstico inexistente.

## Componentes

| Componente             | Regla y estados                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Botón principal        | Una acción dominante por contexto; fondo `accent`, texto `inverse`, radio 4 px, alto mínimo 44 px. Hover `accentHover`; pulsado conserva su etiqueta; ocupado mantiene el ancho y el texto existente («Guardando…», «Probando…»). Deshabilitado usa `surfaceStrong` y `textMuted`, borde discontinuo; no bajar la opacidad del texto. |
| Secundario y peligro   | Secundario: `surface`, `text`, borde `borderStrong`. Hover `surfaceStrong`. Parada: octágono, texto «Parada» y tinta crítica; nunca lima. Mantener pulsado, ocupado y confirmación de reanudación existentes. No hacer que una maqueta active la parada real.                                                                         |
| Campo y selector       | Etiqueta visible encima, ayuda junto al campo y error asociado por `aria-describedby`. Texto `text`, placeholder `textMuted`, borde `borderStrong` (3:1), alto mínimo 44 px. Inválido: tinta crítica, icono y mensaje, además de `aria-invalid`. Solo lectura conserva contraste y nombre; no confundir con deshabilitado.            |
| Checkbox e interruptor | Área de etiqueta de al menos 44 × 44 px, casilla visible y nombre accesible. Activo: marca y posición, además del color. No reducir el área de clic al dibujo de 18 px.                                                                                                                                                               |
| Carril y tarjeta       | Carril para agrupar datos, regla `border` decorativa de 1 px y 24 px de separación. Una tarjeta solo cuando agrupa un objeto accionable o protege contenido (gráfico, ficha, diálogo). Radio de 4–6 px; nada de rejillas de indicadores con sombras.                                                                                  |
| Tabla                  | Cabecera `surfaceStrong`, texto `text`/`textMuted`, nombres a la izquierda, medidas IBM Plex Mono a la derecha; signos, unidades y decimales completos. Filas separadas, hover `surfaceSubtle`. Mantener `caption`, `th scope`, nombre de región y foco del desplazamiento. No truncar nombres de estrategia como solución al ancho.  |
| Insignia               | Texto de estado e icono/código existente, borde de 1 px en la misma tinta y fondo específico. Como es informativa, puede medir 24–28 px; si es accionable, el objetivo llega a 44 px. No usar una insignia verde para paper ni lima para una subida. Conservar los códigos OF/AG/PR/RD y los nombres de fiabilidad.                   |
| Foco                   | Anillo de 2 px en `focus`, separado 2 px del control. No eliminar el foco al pulsar Tab ni recortarlo en `overflow`. En el botón de dinero real el anillo usa el texto de su franja y mantiene separación sobre el relleno.                                                                                                           |
| Mensaje                | Superficie e icono del estado; cuerpo legible, sin opacidad. Error con `role=alert`, progreso con `role=status` y zona ocupada con `aria-busy`. Reservar espacio al actualizar para no desplazar la acción principal.                                                                                                                 |
| Diálogo y tour         | Mantener captura y restauración del foco, Escape y fondo inerte existentes. Sombra solo flotante. Aviso legal: lectura completa y «He leído y acepto» antes de habilitar «Continuar»; nunca quitar el requisito ni preseleccionarlo.                                                                                                  |

Los bordes `border` y la retícula del gráfico son decorativos: no identifican controles ni límites que deban percibirse. Cuando un borde sea necesario para localizar un control, usar `borderStrong`, no oscurecer al azar una regla decorativa. En oscuro las superficies se separan por luminancia, sin halos.

## Semántica por dominio y pistas no cromáticas

- Mercado y P&L: subida `#3CCB8A` / `#0B7548`, bajada `#FF6B6B` / `#C0282B`; conservar signos, «Alcista»/«Bajista» y cuerpos vacíos/sólidos. Mecha acero. El gráfico no promete una subida por usar el acento de marca.
- Series históricas: SMA 20 cian informativo continuo; SMA 50 ámbar discontinuo 7/4; SMA 200 acero punteado 2/4. Mostrar la muestra de trazo junto al nombre y conservar los checkboxes existentes. RSI cian y ATR ámbar viven en paneles rotulados separados. Para series macro simultáneas, conservar leyenda, unidad y etiqueta de serie y variar el trazo por CSS/opciones de gráfico; no agregar claves a los JSON. La lima se reserva a probabilidad/predicción calculada y a selección, nunca a entrenamiento histórico por defecto.
- Riesgo: verde «Operativo»/«Aprobada», ámbar «Modo cautela»/«Tamaño reducido», rosa crítico «Parada activa»/«Vetada», cian «Reanudando». El octágono, el triángulo y el texto conservan el significado en monocromo.
- Dinero real: rosa de capital dedicado `#FF9FAC` / `#9F253D`, distinto del rojo de pérdida. Franja persistente «DINERO REAL» con escudo, contraste inverso y acciones propias; paper es cian con «Paper», «Simulación» o el texto actual. El modo activo real nunca se muestra como éxito verde. Los techos y permisos del corto no cambian.
- Datos y conectores: verde con check = fiables; cian con progreso = comprobando/actualizando; ámbar con reloj = desactualizados; crítico con alerta = no fiables; naranja con desconexión = sin red. «Sin cobertura» y «Actualización parcial» conservan su texto y recuentos; no simular una caída general del proveedor.
- Noticias: máxima rosa crítico, media ámbar, por activo cian, baja acero. Fiabilidad siempre mantiene nombre/código; oficial y agencia no se confunden con confirmación. «Sin verificar · no genera señales» usa naranja, escudo y borde discontinuo, y no se habilita por un cambio visual. Impacto se comunica también con 1, 2 o 3 barras.
- IA: régimen y salud conservan sus nombres e iconos; estimación primaria en lima y complementaria en acero. Probabilidad no equivale a aprobación de Riesgo. Desactivada/degradada conserva estado explícito y no se suaviza con el acento.
- Estrategias y backtest: investigación en acero con matraz, paper cian, activa verde, degradada ámbar, retirada acero con archivo. Mapa de resultados: rellenos suaves de débil/medio/robusto con cifra en `text`, borde de control `borderStrong` y selección en `accent`; el resultado no se comunica solo por el tono del relleno.

Las claves `symbol` que ya contienen emojis se conservan por compatibilidad de datos; no crear nuevos iconos emoji. El renderer muestra el código, el texto y los SVG existentes de su familia. No cambiar la API de presentación durante esta renovación.

## Vacío, cargando, error, éxito y sin permisos

Las muestras de estados están al final de cada pantalla; se abren en «Estados» en la hoja de diseño. En el producto aparecen en su ubicación actual. No mostrar todos los estados juntos.

| Situación                       | Tratamiento y texto existente                                                                                                                                                                                                                                                                                                              |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Sin señales o posiciones        | Mensaje dentro del carril, conservando contexto: «Todavía no hay señales.» / «No hay posiciones simuladas abiertas. Aparecerán al aprobarse una señal.» y la acción existente de estrategia.                                                                                                                                               |
| Sin histórico                   | Área del gráfico estable con «El histórico todavía no está disponible.» y «Las velas aparecerán cuando termine la descarga y el ajuste.». No dibujar datos ficticios como fallback.                                                                                                                                                        |
| Sin estrategias                 | «Aún no hay estrategias», explicación y «Crear estrategia». Con filtro: «No hay estrategias con este estado».                                                                                                                                                                                                                              |
| Sin noticias                    | «No hay noticias disponibles. Añade una fuente para recibir titulares.» y «Añadir una fuente»; con filtros, conservar explicación y «Restablecer filtros».                                                                                                                                                                                 |
| Cargando                        | «Consultando velas…», «Cargando estado de riesgo…», «Cargando noticias…», «Cargando ajustes de análisis…». Conservar lo último válido si hoy se conserva; sin animación brillante ni parpadeo. Respetar `prefers-reduced-motion`.                                                                                                          |
| Error                           | Mensaje real de la operación, icono y recuperación existente. Para fallo de dibujo, conservar la tabla OHLCV: «No pudimos dibujar el gráfico. Puedes consultar las velas en la tabla de datos.».                                                                                                                                           |
| Éxito                           | Texto y check verde junto a la operación («Límites guardados», prueba de notificación enviada). No cambiar el color de toda la pantalla.                                                                                                                                                                                                   |
| Sin permisos del sistema        | «No se pudo enviar la prueba. Revisa los permisos de notificaciones del sistema e inténtalo de nuevo.»; mantener la acción de prueba. Si no hay llavero: «El llavero del sistema no está disponible, así que no se pueden guardar claves.» y «Ver ayuda en Ajustes». No aparentar credenciales guardadas ni inventar un permiso concedido. |
| Sin conexión o datos no fiables | Conservar fecha del último dato, aviso y bloqueo de señales que ya aplica el motor. No sustituir una hora desconocida por «ahora».                                                                                                                                                                                                         |

## Contraste de dominio

Cálculo WCAG 2.2: sRGB linealizado, luminancia relativa 0,2126 R + 0,7152 G + 0,0722 B y cociente `(Lmáx + 0,05)/(Lmín + 0,05)`. Umbral 4,5:1 para todo texto normal, 3:1 para series, mechas, selección y segmentos informativos. Ratios de la tabla redondeados solo al mostrar; el verificador compara valores completos.

Se verifican 430 combinaciones, 215 por tema. Cada token de estado se contrasta con su propia superficie. Series y elementos sin superficie propia se contrastan con `surface`. La franja real se verifica con `lightText`/`darkText` sobre su relleno normal y hover; su texto secundario va sobre `live.surface`. Los rellenos de heatmap se verifican con `text` encima. La retícula, velos y halos de separación no contienen información y no se contabilizan como series: la forma se da mediante texto, trazos o bordes de control que sí cumplen. No bajar la opacidad de texto de eventos finalizados (`calendar.past.opacity = 1`). Los pares base se mantienen en la guía de marca.

| Token o par                               | Claro · tinta / fondo · ratio | Oscuro · tinta / fondo · ratio | Mínimo |
| ----------------------------------------- | ----------------------------- | ------------------------------ | ------ |
| `ai.color.regime.trend`                   | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `ai.color.regime.sideways`                | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.regime.highVolatility`          | #7F5E00 / #FFF2BF · **5.34**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `ai.color.regime.lowVolatility`           | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `ai.color.regime.unknown`                 | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.eligibility.enabled`            | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `ai.color.eligibility.disabled`           | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `ai.color.eligibility.degraded`           | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `ai.color.probability.primary`            | #4A6500 / #EDF7CF · **5.97**  | #C6F432 / #1D2610 · **12.26**  | 4.5:1  |
| `ai.color.probability.complement`         | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.probability.unavailable`        | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.modelFitness.eligible`          | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `ai.color.modelFitness.synthetic`         | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `ai.color.modelFitness.unrated`           | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.sentiment.favorable`            | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `ai.color.sentiment.neutral`              | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.sentiment.unfavorable`          | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `ai.color.sentiment.mixed`                | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `ai.color.sentiment.notAnalyzed`          | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.verification.unverified`        | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `ai.color.health.healthy`                 | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `ai.color.health.watch`                   | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `ai.color.health.degraded`                | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `ai.color.health.unknown`                 | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `ai.color.chart.calibrationIdeal`         | #525F6C / #FFFFFF · **6.54**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `ai.color.chart.calibrationObserved`      | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `ai.color.chart.reference`                | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `broker.color.paper`                      | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `broker.color.orderStatus.pending`        | #7A5900 / #FFF2BF · **5.74**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `broker.color.orderStatus.sent`           | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `broker.color.orderStatus.partial`        | #7A5900 / #FFF2BF · **5.74**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `broker.color.orderStatus.filled`         | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `broker.color.orderStatus.cancelled`      | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `broker.color.orderStatus.rejected`       | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `broker.color.orderStatus.orphaned`       | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `broker.color.reconciliation.matched`     | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `broker.color.reconciliation.running`     | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `broker.color.reconciliation.mismatch`    | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `broker.color.reconciliation.unknown`     | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `broker.color.deviation.within`           | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `broker.color.deviation.outside`          | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `dashboard.color.signal.approved`         | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `dashboard.color.signal.vetoed`           | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `dashboard.color.signal.conflict`         | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `dashboard.color.signal.informative`      | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `dashboard.color.strategy.active`         | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `dashboard.color.strategy.paper`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `dashboard.color.strategy.degraded`       | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `dashboard.color.strategy.paused`         | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `dashboard.color.chart.positive`          | #0B7548 / #FFFFFF · **5.75**  | #3CCB8A / #10161C · **8.76**   | 3:1    |
| `dashboard.color.chart.negative`          | #B0202E / #FFFFFF · **6.79**  | #FF7D87 / #10161C · **7.40**   | 3:1    |
| `dashboard.color.chart.threshold`         | #7A5900 / #FFFFFF · **6.45**  | #EBC05A / #10161C · **10.59**  | 3:1    |
| `dashboard.color.chart.neutral`           | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `data-clarity.color.semantic.covered`     | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `data-clarity.color.semantic.uncovered`   | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `data-clarity.color.semantic.partial`     | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `data-clarity.color.semantic.critical`    | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `data-clarity.color.semantic.offline`     | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `data-clarity.color.semantic.info`        | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `live.color.requirement.complete`         | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `live.color.requirement.pending`          | #9F253D / #F9E4EB · **6.17**  | #FF9FAC / #341A23 · **8.20**   | 4.5:1  |
| `live.color.requirement.review`           | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `live.color.requirement.locked`           | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `live.color.liveMode.blocked`             | #9F253D / #F9E4EB · **6.17**  | #FF9FAC / #341A23 · **8.20**   | 4.5:1  |
| `live.color.liveMode.ready`               | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `live.color.liveMode.active`              | #9F253D / #F9E4EB · **6.17**  | #FF9FAC / #341A23 · **8.20**   | 4.5:1  |
| `live.color.liveMode.suspended`           | #9F253D / #F9E4EB · **6.17**  | #FF9FAC / #341A23 · **8.20**   | 4.5:1  |
| `live.color.smoke.notRun`                 | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `live.color.smoke.running`                | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `live.color.smoke.reconciled`             | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `live.color.smoke.failed`                 | #9F253D / #F9E4EB · **6.17**  | #FF9FAC / #341A23 · **8.20**   | 4.5:1  |
| `live.color.scaling.locked`               | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `live.color.scaling.evidence`             | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `live.color.scaling.eligible`             | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `market.color.candle.up`                  | #0B7548 / #FFFFFF · **5.75**  | #3CCB8A / #10161C · **8.76**   | 3:1    |
| `market.color.candle.down`                | #C0282B / #FFFFFF · **5.87**  | #FF6B6B / #10161C · **6.56**   | 3:1    |
| `market.color.candle.wick`                | #5B6B7A / #FFFFFF · **5.48**  | #93A1AF / #10161C · **6.90**   | 3:1    |
| `market.color.candle.crosshair`           | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `market.color.dataStatus.reliable`        | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `market.color.dataStatus.updating`        | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `market.color.dataStatus.stale`           | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `market.color.dataStatus.unreliable`      | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `market.color.dataStatus.simulated`       | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `market.color.series.price`               | #0C1218 / #FFFFFF · **18.83** | #E4EAF0 / #10161C · **15.02**  | 3:1    |
| `market.color.series.sma20`               | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `market.color.series.sma50`               | #7F5E00 / #FFFFFF · **5.99**  | #FFD23F / #10161C · **12.61**  | 3:1    |
| `market.color.series.sma200`              | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `market.color.series.dff`                 | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `market.color.series.cpi`                 | #A3460E / #FFFFFF · **6.11**  | #FF9A5C / #10161C · **8.69**   | 3:1    |
| `market.color.series.yield2y`             | #0B7548 / #FFFFFF · **5.75**  | #3CCB8A / #10161C · **8.76**   | 3:1    |
| `market.color.series.yield10y`            | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `market.color.series.spread`              | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `market.color.series.vix`                 | #B0202E / #FFFFFF · **6.79**  | #FF7D87 / #10161C · **7.40**   | 3:1    |
| `market.color.series.rsi`                 | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `market.color.series.atr`                 | #7F5E00 / #FFFFFF · **5.99**  | #FFD23F / #10161C · **12.61**  | 3:1    |
| `news.color.state.online`                 | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `news.color.state.offline`                | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `news.color.state.paused`                 | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `news.color.state.info`                   | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.state.alert`                  | #7F5E00 / #FFF2BF · **5.34**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `news.color.state.critical`               | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `news.color.state.success`                | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `news.color.reliability.oficial`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.reliability.agencia`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.reliability.prensa`           | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `news.color.reliability.redes`            | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `news.color.newsPriority.maxima`          | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `news.color.newsPriority.media`           | #7F5E00 / #FFF2BF · **5.34**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `news.color.newsPriority.activo`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.newsPriority.baja`            | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `news.color.confirmation.confirmada`      | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `news.color.confirmation.sinConfirmar`    | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `news.color.impactLevel.alto`             | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `news.color.impactLevel.medio`            | #7F5E00 / #FFF2BF · **5.34**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `news.color.impactLevel.bajo`             | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `news.color.calendar.upcoming`            | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.calendar.past`                | #525F6C / #E7ECF0 · **5.50**  | #8796A5 / #1C252E · **5.12**   | 4.5:1  |
| `news.color.calendar.earnings`            | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `news.color.connectionTest.testing`       | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.connectionTest.success`       | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `news.color.connectionTest.error`         | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `news.color.candle.up`                    | #0B7548 / #FFFFFF · **5.75**  | #3CCB8A / #10161C · **8.76**   | 3:1    |
| `news.color.candle.down`                  | #C0282B / #FFFFFF · **5.87**  | #FF6B6B / #10161C · **6.56**   | 3:1    |
| `news.color.candle.wick`                  | #5B6B7A / #FFFFFF · **5.48**  | #93A1AF / #10161C · **6.90**   | 3:1    |
| `news.color.candle.crosshair`             | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `news.color.dataStatus.reliable`          | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `news.color.dataStatus.updating`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.dataStatus.stale`             | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `news.color.dataStatus.unreliable`        | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `news.color.dataStatus.simulated`         | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `news.color.series.price`                 | #0C1218 / #FFFFFF · **18.83** | #E4EAF0 / #10161C · **15.02**  | 3:1    |
| `news.color.series.sma20`                 | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `news.color.series.sma50`                 | #7F5E00 / #FFFFFF · **5.99**  | #FFD23F / #10161C · **12.61**  | 3:1    |
| `news.color.series.sma200`                | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `news.color.series.dff`                   | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `news.color.series.cpi`                   | #A3460E / #FFFFFF · **6.11**  | #FF9A5C / #10161C · **8.69**   | 3:1    |
| `news.color.series.yield2y`               | #0B7548 / #FFFFFF · **5.75**  | #3CCB8A / #10161C · **8.76**   | 3:1    |
| `news.color.series.yield10y`              | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `news.color.series.spread`                | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `news.color.series.vix`                   | #B0202E / #FFFFFF · **6.79**  | #FF7D87 / #10161C · **7.40**   | 3:1    |
| `news.color.series.rsi`                   | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `news.color.series.atr`                   | #7F5E00 / #FFFFFF · **5.99**  | #FFD23F / #10161C · **12.61**  | 3:1    |
| `onboarding.color.tour.spotlightRing`     | #4A6500 / #FFFFFF · **6.66**  | #C6F432 / #10161C · **14.21**  | 3:1    |
| `onboarding.color.tour.popover.border`    | #738392 / #FFFFFF · **3.90**  | #66747F / #10161C · **3.79**   | 3:1    |
| `onboarding.color.tour.popover.title`     | #0C1218 / #FFFFFF · **18.83** | #E4EAF0 / #10161C · **15.02**  | 3:1    |
| `onboarding.color.tour.popover.body`      | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `onboarding.color.tour.progressDone`      | #0A6390 / #FFFFFF · **6.56**  | #C6F432 / #10161C · **14.21**  | 3:1    |
| `onboarding.color.tour.progressPending`   | #738392 / #FFFFFF · **3.90**  | #66747F / #10161C · **3.79**   | 3:1    |
| `onboarding.color.tour.stepLabel`         | #4A6500 / #FFFFFF · **6.66**  | #C6F432 / #10161C · **14.21**  | 4.5:1  |
| `onboarding.color.firstSteps.done`        | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `onboarding.color.firstSteps.pending`     | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `onboarding.color.firstSteps.attention`   | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `onboarding.color.connection.idle`        | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `onboarding.color.connection.testing`     | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `onboarding.color.connection.ok`          | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `onboarding.color.connection.missingKey`  | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `onboarding.color.connection.rejectedKey` | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `onboarding.color.connection.quota`       | #7F5E00 / #FFF2BF · **5.34**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `onboarding.color.connection.offline`     | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `onboarding.color.connection.error`       | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `onboarding.color.freshness.current`      | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `onboarding.color.freshness.catchingUp`   | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `onboarding.color.freshness.stale`        | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `onboarding.color.freshness.unreliable`   | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `onboarding.color.freshness.noData`       | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `onboarding.color.freshness.offline`      | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `risk.color.riskStatus.safe`              | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `risk.color.riskStatus.caution`           | #7A5900 / #FFF2BF · **5.74**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `risk.color.riskStatus.stopped`           | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `risk.color.riskStatus.resuming`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `risk.color.riskStatus.simulation`        | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `risk.color.decision.approved`            | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `risk.color.decision.reduced`             | #7A5900 / #FFF2BF · **5.74**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `risk.color.decision.vetoed`              | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `strategy.color.strategyStatus.research`  | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `strategy.color.strategyStatus.paper`     | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `strategy.color.strategyStatus.active`    | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `strategy.color.strategyStatus.degraded`  | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `strategy.color.strategyStatus.retired`   | #475563 / #E7ECF0 · **6.43**  | #9AA8B6 / #1C252E · **6.39**   | 4.5:1  |
| `strategy.color.chart.equity`             | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `strategy.color.chart.benchmark`          | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `strategy.color.chart.positive`           | #0B7548 / #FFFFFF · **5.75**  | #3CCB8A / #10161C · **8.76**   | 3:1    |
| `strategy.color.chart.negative`           | #B0202E / #FFFFFF · **6.79**  | #FF7D87 / #10161C · **7.40**   | 3:1    |
| `strategy.color.chart.neutral`            | #525F6C / #FFFFFF · **6.54**  | #8796A5 / #10161C · **6.01**   | 3:1    |
| `strategy.color.chart.training`           | #0A6390 / #FFFFFF · **6.56**  | #6CC6F2 / #10161C · **9.53**   | 3:1    |
| `strategy.color.chart.validation`         | #7F5E00 / #FFFFFF · **5.99**  | #EBC05A / #10161C · **10.59**  | 3:1    |
| `strategy.color.chart.lockedTest`         | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 3:1    |
| `strategy.color.heatmap.selected`         | #4A6500 / #FFFFFF · **6.66**  | #C6F432 / #10161C · **14.21**  | 3:1    |
| `strategy.color.notice.method`            | #7A5900 / #FFF2BF · **5.74**  | #FFD23F / #302709 · **10.24**  | 4.5:1  |
| `strategy.color.notice.critical`          | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `strategy.color.notice.info`              | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `live.color.live.banner`                  | #FFFFFF / #9F253D · **7.48**  | #0A0E12 / #FF9FAC · **9.97**   | 4.5:1  |
| `live.color.live.bannerHover`             | #FFFFFF / #7E1830 · **10.19** | #0A0E12 / #FFBBC5 · **12.14**  | 4.5:1  |
| `live.color.live.text`                    | #9F253D / #F9E4EB · **6.17**  | #FF9FAC / #341A23 · **8.20**   | 4.5:1  |
| `strategy.color.heatmap.low`              | #0C1218 / #FBE3E5 · **15.44** | #E4EAF0 / #3A1519 · **13.32**  | 4.5:1  |
| `strategy.color.heatmap.mid`              | #0C1218 / #F5ECCB · **15.91** | #E4EAF0 / #2E2610 · **12.37**  | 4.5:1  |
| `strategy.color.heatmap.high`             | #0C1218 / #DCF2E7 · **16.05** | #E4EAF0 / #0E271D · **13.06**  | 4.5:1  |
| `data-clarity.contrastPairs[0]`           | #0C1218 / #EEF2F5 · **16.73** | #E4EAF0 / #0A0E12 · **15.98**  | 4.5:1  |
| `data-clarity.contrastPairs[1]`           | #0C1218 / #FFFFFF · **18.83** | #E4EAF0 / #10161C · **15.02**  | 4.5:1  |
| `data-clarity.contrastPairs[2]`           | #0C1218 / #E3E9EE · **15.38** | #E4EAF0 / #07090C · **16.45**  | 4.5:1  |
| `data-clarity.contrastPairs[3]`           | #475563 / #EEF2F5 · **6.79**  | #9AA8B6 / #0A0E12 · **7.98**   | 4.5:1  |
| `data-clarity.contrastPairs[4]`           | #475563 / #FFFFFF · **7.64**  | #9AA8B6 / #10161C · **7.50**   | 4.5:1  |
| `data-clarity.contrastPairs[5]`           | #FFFFFF / #4A6500 · **6.66**  | #0A0E12 / #C6F432 · **15.11**  | 4.5:1  |
| `data-clarity.contrastPairs[6]`           | #4A6500 / #FFFFFF · **6.66**  | #C6F432 / #10161C · **14.21**  | 4.5:1  |
| `data-clarity.contrastPairs[7]`           | #4A6500 / #FFFFFF · **6.66**  | #C6F432 / #10161C · **14.21**  | 4.5:1  |
| `data-clarity.contrastPairs[8]`           | #7A5900 / #F5ECCB · **5.45**  | #EBC05A / #2E2610 · **8.72**   | 4.5:1  |
| `data-clarity.contrastPairs[9]`           | #0C1218 / #F5ECCB · **15.91** | #E4EAF0 / #2E2610 · **12.37**  | 4.5:1  |
| `data-clarity.contrastPairs[10]`          | #B0202E / #FBE3E5 · **5.57**  | #FF7D87 / #3A1519 · **6.56**   | 4.5:1  |
| `data-clarity.contrastPairs[11]`          | #0C1218 / #FBE3E5 · **15.44** | #E4EAF0 / #3A1519 · **13.32**  | 4.5:1  |
| `data-clarity.contrastPairs[12]`          | #0B7548 / #DCF2E7 · **4.90**  | #3CCB8A / #0E271D · **7.61**   | 4.5:1  |
| `data-clarity.contrastPairs[13]`          | #0C1218 / #DCF2E7 · **16.05** | #E4EAF0 / #0E271D · **13.06**  | 4.5:1  |
| `data-clarity.contrastPairs[14]`          | #A3460E / #FBE6D8 · **5.06**  | #FF9A5C / #33200F · **7.41**   | 4.5:1  |
| `data-clarity.contrastPairs[15]`          | #0C1218 / #FBE6D8 · **15.61** | #E4EAF0 / #33200F · **12.79**  | 4.5:1  |
| `data-clarity.contrastPairs[16]`          | #0A6390 / #DDEFF8 · **5.55**  | #6CC6F2 / #0E2431 · **8.36**   | 4.5:1  |
| `data-clarity.contrastPairs[17]`          | #0C1218 / #DDEFF8 · **15.94** | #E4EAF0 / #0E2431 · **13.17**  | 4.5:1  |
