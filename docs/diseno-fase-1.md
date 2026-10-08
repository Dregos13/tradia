# Diseño de fase 1 · Datos de mercado

La especificación visual completa, los tokens y las maquetas autocontenidas están en `.orquesta/design/c778c0bf/` y se replican en `.orquesta/design/fase-1/` para el contrato de la fase.

## Principios de implementación

- Extender el sistema **Cuaderno cuantitativo** de fase 0–1; no crear una identidad paralela.
- Mantener visibles procedencia, fecha de observación, ajuste de precios y estado de calidad.
- Usar números tabulares para cotizaciones, variaciones, fechas y valores macro.
- Distinguir velas alcistas y bajistas con color **y** forma: cuerpo vacío para alcista, sólido/rayado para bajista.
- Aplicar los cinco estados de datos con símbolo, texto y color: `Fiable`, `Actualizando`, `Desactualizado`, `No fiable` y `Datos simulados`.
- Mostrar el estado en tres escalas: insignia junto al dato, aviso dentro del gráfico/tarjeta y banner global solo cuando cae un proveedor y afecta a varias series.
- No usar un dato `No fiable` en cálculos o señales. Un dato `Desactualizado` conserva su último valor, pero indica qué sesión falta.
- Mantener `Datos simulados` visible durante toda la sesión de prueba.

## Estructura de las superficies

### Mercado

Lista de seguimiento de hasta 25 activos, alta por ticker, acción `Añadir universo inicial`, baja directa, selector 1A/3A/5A, velas ajustadas, SMA 20/50/200, RSI 14 y ATR 14. La lista precede al gráfico en ventanas estrechas.

### Contexto macro

Tarjetas en orden estable para DFF, IPC, DGS2, DGS10, T10Y2Y y VIXCLS. Cada tarjeta incluye código, nombre, valor/unidad, variación, frecuencia, fecha de observación, minigráfico y frescura.

### Ajustes y vacíos

Bloques independientes para Tiingo y FRED con campo de contraseña, `Guardar` y `Probar conexión`. La clave guardada se vacía y solo se representa como `Guardada y cifrada`. Los vacíos principales son `Conecta tus fuentes de datos` y `Tu lista está vacía`.

## Accesibilidad

- Contraste WCAG 2.2 AA. El mínimo calculado de los estados sobre su superficie es 5,59:1; el mínimo de las velas sobre la superficie del gráfico es 5,30:1.
- Objetivos interactivos de 44 × 44 px y foco exterior de 3 px con separación de 2 px.
- `role="status"` para progreso y recuperación; `role="alert"` para cambios críticos nuevos.
- Los minigráficos tienen alternativa textual de tendencia; el gráfico de velas necesita resumen accesible y una tabla de datos en producción.
- Respetar `prefers-reduced-motion`; ninguna información depende de animación.

## Cadenas que deben permanecer comprobables

Para pruebas E2E, mantener los textos o añadir `data-testid` semánticos para: `Añadir`, `Quitar {ticker}`, `Añadir universo inicial`, `Probar conexión`, `Fiable`, `Desactualizado`, `No fiable` y `Datos simulados`.
