# Diseño de fase 5 · Broker paper, órdenes y desviación

Esta fase extiende el **Cuaderno cuantitativo** de Tradia: convierte una señal aprobada en una ejecución simulada verificable, sin presentar la app como terminal ni insinuar operativa con dinero real. La fuente ejecutable de los tokens es `src/renderer/src/design/broker.tokens.json`; hereda `base.tokens.json` y `risk.tokens.json`. La identidad conserva papel cálido, tinta azul, títulos editoriales y datos monoespaciados.

## Principios y navegación

1. **Paper siempre visible.** Toda superficie que permita conectar, ejecutar o revisar órdenes muestra la insignia con icono de matraz y texto completo `Solo paper · sin dinero real`. Nunca se abrevia a un punto morado.
2. **Resultado, no espectáculo.** No hay cinta de precios, destellos ni verde/rojo como único significado. Cada estado combina icono, texto y, como refuerzo, color.
3. **Trazabilidad primero.** Hora, precio pedido, precio ejecutado, slippage y estrategia permanecen visibles y se pueden relacionar con el Diario.
4. **Anomalías concretas.** Un aviso nombra activo, valor de la app y valor del broker. No usar `Algo ha ido mal` cuando se conoce la diferencia.

La navegación de escritorio queda: `Inicio`, `Mercado`, `Noticias`, `Calendario`, `Estrategias`, `Riesgo`, `Diario`, **`Órdenes`**, **`Real vs backtest`**, `Ajustes`. Los dos destinos nuevos van inmediatamente después de Diario. En 700 px el menú lateral se compacta con el patrón existente; si se usa menú desplegable, conserva ese orden y un objetivo mínimo de 44 px.

El banner global se coloca bajo la cabecera. Prioridad: `Parada activa` → `Sin conexión` → `Descuadre con el broker`. Si coinciden, el primer banner resume los demás con enlaces; nunca apilar más de dos. La parada y la desconexión bloquean nuevas ejecuciones, pero no ocultan las órdenes ya registradas.

## Ajustes · Cuenta de broker · Paper

La sección se sitúa antes de canales de entrega. Encabezado: `Cuenta de broker · Paper` y la insignia permanente. Texto de apoyo: `Conecta una cuenta de Alpaca Paper. Tradia no admite cuentas live ni puede retirar fondos.` No ofrecer campo de URL: el endpoint paper es fijo.

### Sin conectar

- Campos `Clave de API` y `Secreto de API`, ambos `type=password`, con autocompletado desactivado y acción accesible `Mostrar/Ocultar` opcional. El valor se enmascara mientras se escribe y se borra del renderer al terminar.
- Ayuda: `Las claves se cifran en el llavero del sistema y nunca vuelven a mostrarse.`
- Acción primaria `Probar conexión`; deshabilitada si falta un campo. No hay un botón separado `Guardar`: una prueba correcta conecta y guarda.
- Error de validación junto al campo: `Introduce la clave de API` / `Introduce el secreto de API`; el foco va al primer error.

### Comprobando

Los campos quedan bloqueados y enmascarados. El botón mantiene 44 px, muestra indicador giratorio y texto `Comprobando cuenta paper…`; el contenedor usa `aria-busy="true"` y un estado vivo moderado. No cambiar el ancho del botón.

### Conectada

Cabecera de estado: icono de verificación + `Cuenta paper conectada`; debajo `Alpaca · Cuenta •••• 4821` y `Saldo paper 100.245,30 USD`, con número tabular. Las credenciales se sustituyen por `Clave y secreto guardados de forma cifrada` y acción `Reemplazar claves`.

Interruptor `Ejecutar señales aprobadas en paper`, activo por defecto después de conectar. Ayuda: `Las señales aprobadas o reducidas por Riesgo se enviarán al broker paper. La parada de emergencia sigue teniendo prioridad.` El interruptor comunica `Activado/Desactivado` además de la posición y mantiene etiqueta clicable de 44 px.

Acciones: `Probar de nuevo` secundaria y `Desconectar` destructiva secundaria. Desconectar abre un diálogo: título `Desconectar la cuenta paper`, explicación `Tradia dejará de enviar órdenes y borrará las claves guardadas. Las órdenes y el Diario se conservan.`, botones `Mantener conectada` y `Desconectar y borrar claves`. El foco inicial va a la opción segura; Escape cancela y al cerrar se devuelve el foco al disparador.

### Error y sin permisos

Mensaje inline con icono, título y motivo utilizable:

- autenticación: `No se pudo autenticar la cuenta paper. Revisa la clave y el secreto.`
- endpoint live: `Estas claves no corresponden a una cuenta paper. No se han guardado.`
- red: `No se pudo contactar con Alpaca Paper. Comprueba la conexión e inténtalo de nuevo.`
- sin llavero: `No hay un llavero seguro disponible. Tradia no guardará las claves. Activa gnome-keyring o KWallet y vuelve a intentarlo.`

Conservar los campos para corregir salvo en claves live o ausencia de llavero, donde se vacían. El error usa `role="alert"`; no mostrar secretos ni fragmentos en mensajes o registros. Tras conexión correcta, `Cuenta paper conectada` se anuncia con `role="status"` y el foco pasa al resumen.

## Página Órdenes

Cabecera: título `Órdenes`, insignia paper, subtítulo `Ejecuciones simuladas enviadas por Tradia` y hora de actualización. A la derecha, el bloque compacto de conciliación descrito después.

Barra de filtros: `Estado` (Todos, Pendiente, Enviada, Parcial, Ejecutada, Cancelada, Rechazada, Huérfana), `Estrategia`, búsqueda `Activo` y `Limpiar filtros`. Cada control tiene etiqueta visible. El recuento lee `24 órdenes` o `3 de 24 órdenes`.

La tabla ordena por hora descendente y usa columnas: `Hora`, `Activo`, `Tipo`, `Lado`, `Cantidad`, `Precio pedido`, `Precio ejecutado`, `Slippage`, `Estrategia`, `Estado`, `Acciones`.

- Hora: local y zona visible en la cabecera o ayuda; detalle expone ISO. Cifras tabulares.
- Tipo: `Mercado`, `Limitada`, `Stop`, `OCO · objetivo` u `OCO · stop`.
- Lado: flecha SVG coherente + `Compra` o `Venta`; la palabra nunca se omite.
- Precio ausente: raya `—` con texto accesible `Aún no ejecutada`, no cero.
- Slippage: siempre signo, unidad y texto: `+8 pb · desfavorable`, `−3 pb · favorable` o `0 pb · sin desviación`. El cálculo ya tiene en cuenta compra/venta; no inferirlo por color. Pendiente: `— · pendiente de ejecución`.
- Estado: icono + texto completo. Si rechazada, huérfana o parcial, una segunda línea explica el motivo o la cantidad ejecutada.
- `Cancelar` aparece solo para estados cancelables `Pendiente` o `Enviada` que el contrato marque como abiertos. Confirmación inline o diálogo: `Cancelar la orden limitada de 10 AAPL a 226,80 USD`. Durante la petición: `Cancelando…`; éxito: estado `Cancelada`; fallo conserva la fila y explica el motivo.

### Grupo OCO

Una fila padre `Protección OCO · AAPL · 10` controla dos filas hijas indentadas y unidas por un rail de 2 px: `Objetivo · Limitada 234,00 USD` y `Protección · Stop 221,50 USD`. La fila padre muestra el estado agregado. Las patas conservan estado propio. Al ejecutarse una, la otra aparece `Cancelada · contraparte ejecutada`. El grupo es un `<tbody>` con nombre accesible, no una tarjeta dentro de la tabla.

### Estados

- Cargando: cabecera y filtros estables, 5 filas esqueleto, `aria-busy` y texto `Cargando órdenes…`.
- Vacío inicial: `Todavía no hay órdenes paper` + `Cuando Riesgo apruebe una señal y la ejecución esté activa, aparecerá aquí.` + enlace `Revisar cuenta paper`.
- Vacío filtrado: `No hay órdenes con estos filtros` + `Limpiar filtros`.
- Error con instantánea: conserva la última tabla atenuada y rotulada `Datos de las 15:42`, mensaje `No se pudieron actualizar las órdenes` + `Reintentar`.
- Error sin datos: estado inline con el motivo conocido y `Reintentar`; no sustituye la navegación.
- Sin conexión: banner global; tabla conservada y `Datos congelados desde {hora}`. Cancelar queda deshabilitado con ayuda `Necesitas conexión para cancelar`.
- Éxito de cancelación: actualización de fila y anuncio `Orden limitada de AAPL cancelada`; no toast efímero como única confirmación.

## Conciliación

En Órdenes, un bloque `Conciliación con el broker` muestra la última ejecución: `Sin diferencias · hoy, 15:45`, `2 diferencias · hoy, 15:45`, `Conciliando…` o `Aún no se ha conciliado`. Añade `Próxima comprobación 16:00` y botón `Conciliar ahora`. Durante el proceso el botón dice `Conciliando…`, queda deshabilitado y el estado es vivo. Una ejecución limpia anuncia `Conciliación completa. Sin diferencias.`

El banner global de discrepancia usa `role="alert"`, icono y texto concreto: `Descuadre con el broker · AAPL: Tradia registra 10 acciones; Alpaca Paper, 8.` Acciones `Ver en Órdenes` y `Conciliar ahora`. Si hay varias: mostrar la primera y `+2 diferencias`, con detalle expandible. Al resolverse, retirar el banner y anunciar `Descuadre resuelto`. No permitir cerrar definitivamente un descuadre activo; se puede contraer para la sesión.

## Página Real vs backtest

Cabecera: `Real vs backtest`, insignia paper y texto `Compara las operaciones ejecutadas en paper con la expectativa del último backtest de cada estrategia.` Control segmentado accesible `Semanal` / `Mensual`; el periodo usa semanas de lunes a domingo y meses naturales en `America/New_York`.

Resumen superior: periodo seleccionado, estrategias analizadas, alertas y última actualización. La tabla tiene una fila por estrategia y periodo con: `Estrategia`, `Operaciones`, `Esperado`, `Real`, `Desviación`, `Tasa de acierto`, `Slippage medio`, `Margen` y `Estado`. `Esperado`, `Real` y `Desviación` expresan rentabilidad del periodo en puntos porcentuales y siempre incluyen signo. La celda `Margen` escribe `±2,0 pp · máx. 10 pb`; el estado escribe icono + `Dentro del margen` o icono + `Fuera de margen`. Bajo una alerta: `Desviación −3,6 pp supera ±2,0 pp` o `Slippage 14 pb supera 10 pb`.

El margen configurable vive en un panel `Umbrales de desviación` dentro de esta página y se refleja en Ajustes mediante enlace, sin duplicar fuentes de verdad. Campos numéricos `Rentabilidad · ± pp` y `Slippage medio máximo · pb`, con ayuda `Se aplican a futuros cálculos y al periodo actual al recalcular.` Acción `Guardar márgenes`; éxito inline `Márgenes guardados`; validación `Usa un valor mayor que 0` y límites técnicos definidos por producto. Cambiar el margen no oculta qué umbral generó una alerta histórica.

Estados: esqueletos con geometría estable; vacío `Aún no hay semanas cerradas con operaciones en paper` o `Aún no hay meses cerrados…`; error `No se pudo calcular el informe` + motivo y `Reintentar`; informe parcial conserva filas válidas y marca `No calculado` en la estrategia afectada; éxito de guardado se anuncia sin mover el foco.

## Ventana de 700 px y densidad

La ventana mínima objetivo es 700 px. La barra lateral usa la variante compacta existente. El contenido conserva 20 px laterales. En Órdenes y Real vs backtest, la tabla no se convierte en tarjetas: se mantiene `min-width` (`1180px` y `1040px`) dentro de un contenedor con desplazamiento horizontal, foco visible y aviso `Desplázate horizontalmente para ver todas las columnas`. La primera columna puede permanecer fija si no tapa el foco ni el contenido. Filtros y resúmenes se apilan; botones ocupan ancho completo solo cuando evita truncamiento. El diálogo deja 20 px de margen y no supera el alto disponible.

## Accesibilidad y formato

- Contraste WCAG 2.2 AA en temas claro y oscuro. El modo oscuro usa los tokens heredados, no inversión automática.
- `:focus-visible`: contorno de 3 px con `color.focus`, separado 2 px; nunca eliminarlo. Filas accionables y contenedores desplazables también reciben foco.
- Todos los controles miden al menos 44 × 44 px. Iconos decorativos son `aria-hidden`; botones solo-icono tienen nombre accesible.
- Cifras financieras: familia `numeric`, `font-variant-numeric: tabular-nums`, signo Unicode `−`, separadores españoles y moneda explícita. No alinear con espacios.
- `prefers-reduced-motion`: indicadores conservan texto; transiciones pasan a 0 ms. No animar cambios de precio ni alertas.
- Textos de estado usan lenguaje literal. `Favorable/desfavorable`, `Dentro/Fuera de margen`, `App/Broker` y `Paper` nunca dependen del color.

## Matriz de implementación

| Componente | Estado obligatorio | Texto/acción clave |
| --- | --- | --- |
| `BrokerSettings` | sin conectar, validación, comprobando, conectada, error, sin llavero | Probar, ejecutar, reemplazar, desconectar con confirmación |
| `PaperBadge` | normal, tema oscuro | `Solo paper · sin dinero real` completo |
| `OrdersTable` | cargando, vacío, filtrado vacío, error, datos congelados, éxito | OCO agrupado; cancelar solo abiertas |
| `ReconcileStatus` | sin ejecutar, ejecutando, limpio, descuadre, error | hora, próxima ejecución y `Conciliar ahora` |
| `ReconcileBanner` | una o varias diferencias, resuelta | activo y cantidades app/broker |
| `DeviationTable` | cargando, vacío semanal/mensual, parcial, error, éxito | alerta con icono + texto + motivo |
| `DeviationMargins` | limpio, validación, guardando, éxito, error | márgenes en pp y pb |

Los mockups autocontenidos de `.orquesta/design/cedf884a/` son referencia visual; este documento gobierna comportamiento, copias y estados cuando exista cualquier diferencia.
