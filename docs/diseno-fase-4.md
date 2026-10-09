# Diseño de fase 4 · Panel, diario y operaciones

Esta fase amplía **Cuaderno cuantitativo**: no es una terminal ni un broker. Es una hoja de situación auditable que explica qué observa Tradia, qué señal propone y por qué el motor de riesgo la admite o la veta. La app **informa y simula; no ejecuta órdenes reales**. La fuente ejecutable de los tokens nuevos es `src/renderer/src/design/dashboard.tokens.json`; extiende `base.tokens.json` y `risk.tokens.json`, que siguen siendo la autoridad para superficies, tipografía, foco y riesgo.

## Jerarquía y navegación

La navegación añade `Diario` después de `Riesgo`. Inicio responde, en este orden: **¿puedo confiar en la información?**, **¿qué merece atención?**, **¿qué riesgo simulado existe?** y **¿qué agentes lo produjeron?** No usar tarjetas dentro de tarjetas. Cada bloque es una sección de papel con título, estado y un enlace contextual; filas y divisores estructuran su interior.

La cabecera conserva la parada de fase 3. Bajo ella solo aparecen banners globales persistentes: sin conexión o parada activa. `Sin conexión` implica datos congelados y agentes en pausa; `Parada activa` implica que no se admiten nuevas señales. Si coinciden, la parada se presenta primero y el banner también indica la desconexión.

## Inicio · siete bloques

En 1440 px, el contenido usa una rejilla de 12 columnas, separación de 16 px y máximo de 1440 px. Fila 1: **Conexión y fuentes** 4/12 + **Contexto macro** 8/12. Fila 2: **Señales vivas** 8/12 + **Posiciones simuladas** 4/12. Fila 3: **Drawdown**, **Exposición** y **Estrategias**, 4/12 cada uno. En una ventana de 700 px, la navegación lateral ya existente se compacta y los siete bloques se apilan en ese mismo orden; el contenido tiene 20 px de margen. Nunca ocultar motivo, confianza, límite ni frescura para ganar espacio.

### 1. Conexión y fuentes

Estado principal `En línea`, `Sin conexión` o `Comprobando…`, con icono y texto. Debajo: proveedor de precios, macro y noticias, cada uno con `Disponible`, `Con retraso`, `No disponible` o `Sin configurar`, y última actualización local con zona. Acción `Ver fuentes`. No reducir todo a un punto de color.

### 2. Contexto macro

Reutiliza `MacroCard` y su semántica. Muestra régimen (`Expansión`, `Cautela`, `Tensión` o `Sin clasificar`), VIX, tipos a 10 años e IPC con fecha de observación y fuente. Si un dato está obsoleto, la tarjeta lo nombra; no se calcula una conclusión silenciosa con datos vencidos.

### 3. Señales vivas

Es el bloque dominante. Cada fila contiene hora, activo, dirección (`Compra`/`Venta`), decisión de riesgo, confianza como porcentaje, estrategia(s) y motivo humano en hasta dos líneas. La confianza se muestra como número y barra con `aria-valuenow`, nunca por color solo. `Ver en Diario` abre la entrada correspondiente. Una contradicción no aparece como señal aprobada: se registra como fila `Sin señal · Contradicción` con las propuestas enfrentadas.

### 4. Posiciones simuladas

Título siempre acompañado por la insignia `Simulación`. Columnas: activo, dirección, tamaño, entrada, último precio y P&L. El pie dice `No son posiciones reales`. Importes y porcentajes usan cifras tabulares; positivo/negativo incluye signo y texto accesible.

### 5. Drawdown

Muestra `Actual`, `Máximo permitido` y distancia restante. Barra lineal con marcador de límite, no velocímetro. Ejemplo: `−3,2 % de −10,0 % · quedan 6,8 puntos`. Al 80 % del límite usa cautela; al alcanzarlo usa crítico, anuncia el límite y enlaza a Riesgo.

### 6. Exposición

Dos vistas compactas, `Por activo` y `Por sector`, mediante control segmentado. Barras ordenadas de mayor a menor con porcentaje y límite aplicable. `Otros` solo agrupa elementos menores al 3 % y debe poder desglosarse. No usar gráfico circular: dificulta comparar límites.

### 7. Estado por estrategia

Filas con nombre, versión, estado (`Activa`, `Paper`, `Degradada`, `En pausa`), último cierre evaluado y resultado (`Señal`, `Sin señal`, `Vetada` o `Error`). El estado combina símbolo, etiqueta y color. Enlaces a la ficha de la estrategia y, cuando exista, a la entrada del diario.

## Estados del panel

| Estado | Tratamiento global | Tratamiento dentro de los bloques |
| --- | --- | --- |
| Cargando | Mantener títulos y geometría; `aria-busy="true"` | Esqueletos de 2–4 filas, sin cifras inventadas; texto accesible `Cargando…` |
| Vacío inicial | Sin pantalla vacía global | Cada bloque explica qué falta y la acción: configurar fuentes, activar estrategia o esperar el siguiente cierre |
| Sin conexión | Banner fijo: `Sin conexión · Datos congelados desde {hora}. Los agentes están en pausa.` + `Reintentar` | Se conserva la última instantánea, atenuada y rotulada `Datos de {hora}`; si nunca hubo datos, vacío específico |
| Parada activa | Banner crítico persistente de fase 3 | Señales: `No se admiten nuevas señales`; posiciones y métricas siguen visibles; estrategias indican `Bloqueada por parada` |
| Error parcial | No inutiliza el resto del panel | Mensaje dentro del bloque, última instantánea si existe y `Reintentar` |
| Actualización correcta | Sin toast por cada refresco | Hora `Actualizado {hora}` con `role="status"`; nuevas señales en cabeza sin mover el foco |

## Diario

Cabecera: título, recuento filtrado y botón primario `Exportar CSV`. Debajo, una barra de filtros con `Desde`, `Hasta`, `Tipo`, `Activo`, `Estrategia`, `Resultado`, acción `Aplicar` y acción secundaria `Limpiar`. En 700 px los filtros se muestran en dos columnas y luego en una cuando el contenido ya no admite etiquetas completas. El botón Exportar siempre exporta el conjunto filtrado y lo explica como `Exportar CSV · {n} entradas`.

La tabla se ordena por fecha descendente y tiene: `Fecha`, `Tipo`, `Activo`, `Estrategia`, `Decisión / resultado`, `Motivo` y un botón accesible `Ver detalle de {tipo} de {activo}`. La fila seleccionada usa borde y `aria-selected`, no solo fondo. A 700 px conserva todas las columnas con desplazamiento horizontal (`min-width: 1040px`) y el aviso `Desplázate para ver todas las columnas`; no convertir cada fila en una tarjeta.

El detalle se abre como panel lateral de 420 px en escritorio y como diálogo casi completo a 700 px. Tiene título, fecha ISO visible también en hora local, tipo, activo, estrategias y versiones; después secciones `Motivo`, `Datos usados`, `Resultado`, `Errores` y `Cumplimiento de reglas`. Los datos usados se presentan en pares etiqueta/valor y un bloque JSON plegable solo como opción secundaria. Reglas: icono + `Cumplida`/`Incumplida` + nombre + observado frente a límite. Si una sección no aplica, escribir `No aplica`, no ocultarla ambiguamente.

Estados: esqueletos con cabecera estable al cargar; vacío general `El diario todavía está vacío`; vacío filtrado `No hay entradas con estos filtros` + `Limpiar filtros`; error inline con `Reintentar`; exportación en curso `Preparando CSV…`; éxito `CSV guardado en {ruta}` con `Abrir carpeta`; cancelación silenciosa; error `No se pudo exportar el CSV. No se creó ningún archivo.`

## Ajustes · alertas, rutina, copias y registros

Se integran como secciones consecutivas de `SettingsPage`, usando el patrón existente de título a la izquierda y panel a la derecha. En 700 px título y panel se apilan.

### Canales y eventos

`Notificaciones de escritorio` conserva sus niveles. `Telegram` incluye activar, token del bot, chat, eventos y `Enviar prueba`. `Correo` incluye activar, servidor SMTP, puerto, seguridad, usuario, contraseña, destino, eventos y `Enviar prueba`. Eventos configurables por canal: señal aprobada, señal vetada, límite alcanzado y resúmenes diarios. Los secretos guardados vuelven como `Guardado` y botón `Reemplazar`; nunca se repintan ni se incluyen en errores.

El interruptor no se activa hasta que la configuración requerida sea válida. La prueba muestra `Enviando…`, éxito `Prueba enviada por {canal}` o un error accionable que no revela credenciales. Los controles desactivados siguen explicando por qué. Cada fila y botón mide al menos 44 px.

### Rutina diaria

Tres filas con hora y zona fija visible `America/New_York`: `Resumen previo a la apertura · 08:30`, `Revisión al cierre · 16:15` y `Conciliación · 17:30`. Permitir editar la hora, no la zona en esta fase. Nota: `No se envía en fines de semana ni festivos de mercado. Si el equipo estaba dormido, se envía al despertar con la marca «Con retraso».`

### Copias de seguridad

Cabecera con `Crear copia ahora`, destino local, frecuencia `Diaria · 02:00` y retención `7 copias`. Lista con fecha, tamaño, versión de esquema, estado de integridad y acción `Restaurar`. Cargando mantiene la lista; vacío `Todavía no hay copias`; error conserva las conocidas. Crear: `Creando copia…` y éxito `Copia creada · {fecha}`.

Restaurar siempre abre confirmación: título `Restaurar esta copia`, resumen de fecha, tamaño y esquema, y texto `Tradia guardará primero una copia del estado actual, sustituirá la base local y se reiniciará. Los cambios posteriores a esta copia dejarán de estar activos.` Foco inicial en `Cancelar`; acción crítica `Restaurar y reiniciar`. Durante el proceso no se puede cerrar. Si falla: `No se pudo restaurar. La base actual no se ha sustituido.`

### Registros

Fila `Registros de diagnóstico`, texto `Se guardan localmente y se rotan automáticamente (5 archivos de hasta 5 MB). Los secretos se ocultan.` y botón `Abrir carpeta de registros`. Si el sistema impide abrirla, mostrar la ruta seleccionable y `Copiar ruta`.

## Texto de notificaciones

Todas terminan con la misma línea: **`Aviso informativo: Tradia no ejecuta órdenes reales.`** No truncar esta línea en los canales propios; para notificación del sistema, colocarla antes del detalle menos importante si el sistema operativo limita el cuerpo.

| Caso | Título | Cuerpo |
| --- | --- | --- |
| Aprobada | `Señal aprobada · {activo} {dirección}` | `{motivo} Confianza: {confianza} %. Riesgo: aprobado; posición simulada de {tamaño}. Aviso informativo: Tradia no ejecuta órdenes reales.` |
| Vetada | `Señal vetada · {activo} {dirección}` | `{motivo}. Regla: {regla}; observado {valor}, límite {límite}. Aviso informativo: Tradia no ejecuta órdenes reales.` |
| Límite | `Límite alcanzado · {nombre}` | `{valor actual} frente al límite {límite}. Se ha {efecto: activado la parada / bloqueado nuevas señales}. Aviso informativo: Tradia no ejecuta órdenes reales.` |
| Preapertura | `Resumen previo a la apertura · {fecha}` | `{n} noticias relevantes, {n} eventos de calendario y {n} huecos en seguimiento.{con retraso} Aviso informativo: Tradia no ejecuta órdenes reales.` |
| Cierre | `Revisión al cierre · {fecha}` | `{n} señales, {n} vetos y {n} posiciones simuladas. Drawdown: {valor}. Aviso informativo: Tradia no ejecuta órdenes reales.` |
| Conciliación | `Conciliación completada · {fecha}` | `{resultado: Sin discrepancias / n discrepancias detectadas}. Cartera simulada y diario revisados.{con retraso} Aviso informativo: Tradia no ejecuta órdenes reales.` |

`{con retraso}` es ` Enviado con retraso.` cuando corresponda. La dirección se verbaliza como `compra` o `venta`, nunca como código interno. La confianza se redondea a entero solo en la notificación; el diario conserva el valor completo.

## Accesibilidad y aplicación de tokens

- `dashboard.tokens.json` solo añade semántica de esta fase. Superficies, texto, foco y parada se toman de `base.tokens.json` y `risk.tokens.json`; no copiar hexadecimales a CSS.
- Los pares de señal documentados tienen contraste mínimo 5,59:1 en claro y 6,39:1 en oscuro. Texto normal sobre superficies base conserva AA. Nunca usar el color como única pista.
- Foco visible exterior de 3 px con 2 px de separación usando `color.light.focus` / `color.dark.focus`. Orden de tabulación igual al visual. Al abrir detalle o confirmación, mover foco al título; al cerrar, devolverlo al disparador.
- Objetivo mínimo 44 × 44 px. Iconos decorativos llevan `aria-hidden`; iconos informativos tienen etiqueta textual. Sparklines y barras llevan nombre, valor actual y resumen alternativo.
- Cifras financieras usan `typography.family.numeric`, `font-variant-numeric: tabular-nums`; fechas visibles son locales con zona y `datetime` ISO.
- Respeta `prefers-reduced-motion`: sin barrido de esqueletos, transiciones instantáneas y ninguna animación de celebración. Actualizaciones en vivo usan `aria-live="polite"` y no roban el foco.
- En modo oscuro se usan los pares `dark`/`darkSurface`; no invertir gráficos mediante filtros. La semántica y el orden no cambian entre temas.

## Referencias de entrega

Las maquetas autocontenidas están en `.orquesta/design/efd82664/`: `panel-1440.html`, `panel-700.html`, `diario.html` y `ajustes.html`. `guia.md` resume el traspaso y `tokens.json` enumera los tokens que el frontend debe aplicar. Las maquetas son referencia de jerarquía y contenido; el renderer debe reutilizar componentes y contratos reales existentes.
