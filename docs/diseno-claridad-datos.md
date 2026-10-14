# Claridad de datos y conectores

Esta guía fija la copia y la jerarquía que deben aplicar `DataFreshness`, `Watchlist`, `DataProvidersSettings` y `ProviderConnectionResult`. Mantiene el sistema visual «Cuaderno cuantitativo» y separa dos conceptos que no deben mezclarse:

- **Activo sin cobertura:** problema local del ticker. No convierte a Tiingo en «caído» ni pausa otros activos.
- **Conector con fallo:** problema de acceso, red, cuota o servicio. Afecta a los datos que dependen de ese conector.

Los entregables visuales de la misión están en `.orquesta/design/0c9aa91c/`, pero el renderer no debe importar ni leer esa carpeta. Los valores que se adopten deben copiarse a `src/renderer/src/design/`.

## Contrato de texto

| Estado | Título | Explicación | Acción |
| --- | --- | --- | --- |
| Sin cobertura | `{ticker} no está disponible en Tiingo` | `Solo {ticker} queda en pausa. Los demás activos, predicciones y señales siguen al día.` | `Cambiar por {sugerencia}` y `Quitar de la lista` |
| Conector caído | `{conector} no responde` | `No podemos actualizar {datosAfectados} ahora. Conservamos el último dato verificado y las funciones que dependen de este conector quedan en pausa.` | `Probar conexión` |
| Clave rechazada | `La clave de {conector} no es válida` | `{conector} la ha rechazado. Pega una clave activa y vuelve a comprobar la conexión.` | `Revisar la clave` |
| Cuota | `{conector} ha alcanzado el límite de consultas` | `No podemos descargar más datos por ahora. Conservamos el último dato verificado y volveremos a intentarlo {momento}.` | `Probar conexión` |
| Sin red | `Sin conexión a internet` | `No podemos comprobar si hay datos nuevos. Puedes seguir consultando el último dato guardado; Tradia reintentará cuando vuelva la red.` | `Probar conexión` |
| Parcial | `Se actualizaron {actualizados} de {total} activos` | `{listaActualizados} están al día. {ticker} no está disponible en Tiingo.` | Acción del activo fallido |
| Completo | `Todo al día` | `{total} de {total} activos se actualizaron con el cierre del {fecha}.` | Sin corrección; `Ver mercado` fuera de Mercado |

`Datos actualizados.` solo es válido con éxito completo. Con EUR sin cobertura, el resultado exacto de un refresco de cuatro activos es: `Se actualizaron 3 de 4 activos. AAPL, SPY y NVDA están al día. EUR no está disponible en Tiingo.`

Al intentar añadir EUR, el campo conserva el valor, recibe `aria-invalid="true"` y anuncia: `Tiingo no ofrece datos para EUR. Puedes añadir FXE, un ETF que sigue una exposición parecida.` La acción es `Añadir FXE`; `Cambiar por FXE` queda reservada para sustituir un EUR ya guardado.

## Componentes

### Aviso de datos

- Etiqueta `1 activo necesita atención`, título de 18 px, consecuencia de 16 px y acciones de 44 px.
- Para un activo sin cobertura, usar ámbar y el detalle `Por qué ocurre`. Carmín queda para fallos críticos.
- El orden de teclado es `Cambiar por FXE` → `Quitar de la lista` → `Por qué ocurre`.
- No reducir la opacidad del ticker sin cobertura: pierde legibilidad.

### Lista de seguimiento

- Ticker: 16 px semibold; nombre y estado: 14 px mínimo.
- `Al día` y `Sin cobertura` usan icono y texto, nunca color solo.
- Quitar es reversible y no necesita confirmación. Anunciar `{ticker} se ha quitado de tu lista.`
- Nombre visible: `Quitar de la lista`; nombre accesible: `Quitar {ticker} de la lista`.

### Ajustes › Conectores

El título visible es `Conectores de datos`. Cada tarjeta incluye nombre, función, estado, `Última comprobación`, explicación y un bloque `Siguiente paso` con una acción principal. Tiingo añade `Activos de tu lista sin cobertura`.

Etiquetas de estado: `Sin comprobar`, `Comprobando…`, `Funciona`, `No responde`, `Clave no válida`, `Límite alcanzado` y `Sin conexión`. Un Tiingo que funciona puede mostrar EUR sin cobertura: son estados de distinto nivel y no se contradicen.

## Legibilidad y accesibilidad

- Base y controles: 16/24 px. Secundario: 15/22 px. Metadatos, fechas, ayudas e insignias: 14/20 px mínimo. No usar 12 px para información.
- Título de tarjeta o aviso: 18/26 px. Título de pantalla: 24/32 px.
- Espaciado: 8 px icono–etiqueta, 12 px entre controles, 16 px antes de acciones, 20 px de relleno en tarjetas y 32 px entre secciones.
- Controles: 44 × 44 px mínimo. Texto explicativo: 70ch máximo.
- Foco visible: 3 px sólido, `outline-offset: 2px`, con `#0C60E8` en claro y `#9DB8FF` en oscuro.
- `role="alert"` solo para un fallo nuevo que requiere atención. Carga, éxito y cambios rutinarios usan `role="status" aria-live="polite"`.
- A 200 % de zoom y ≤720 px, aviso, formularios, tarjetas y acciones pasan a una columna sin ocultar fecha, estado, activo ni siguiente paso.

Pares clave, calculados con luminancia relativa sRGB WCAG 2.2: texto/superficie 15,55:1 claro y 15,15:1 oscuro; secundario/superficie 6,20:1 y 9,10:1; botón primario 7,70:1 y 7,40:1; sin cobertura 5,68:1 y 8,12:1; crítico 6,22:1 y 6,39:1; foco/superficie 5,40:1 y 8,45:1. Todos los pares de texto definidos para esta misión superan 4,5:1.

## Estados transversales

- Vacío: `Conecta tus fuentes de datos. Añade una clave de Tiingo para precios y una de FRED para contexto macro.`
- Carga: `Comprobando si hay datos nuevos…`
- Error desconocido: `No pudimos comprobar el estado de los datos.` + `Volver a comprobar`.
- Éxito de clave: `Clave guardada y cifrada.` + `Probar conexión`.
- Sin permisos: `Las alertas de datos están activas, pero el sistema bloquea las notificaciones.` + `Abrir ajustes del sistema`.

La tabla completa de sustituciones, ratios y maquetas se conserva en el entregable de diseño de la misión.
