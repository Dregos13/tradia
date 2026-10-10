# Variables del modelo predictivo

Especificación exacta de las 16 variables de entrada del modelo y de la
semántica de sus salidas. Es el contrato entre `ml/` (Python, entrenamiento)
y `src/main/ai/prediction/` (TypeScript, servicio en la app): ambos calculan
las mismas variables y obtienen las mismas probabilidades dentro de la
tolerancia de paridad **1e-6**, comprobada con `parity-fixture.json`.

## Entrada

- Una serie de velas diarias `{date, open, high, low, close, volume}`
  (`date` en `YYYY-MM-DD`), ordenada de antigua a reciente, **con la historia
  completa disponible del activo**.
- Los precios son los **ajustados** por splits y dividendos
  (`COALESCE(adj_*, crudo)` en la base, ver `ml/export_candles.py`).
- La sesión `t` solo usa velas con índice `≤ t` (sin look-ahead).
- **Importante:** RSI, ATR y EMA se siembran al inicio de la serie y
  arrastran estado (suavizado de Wilder / recurrencia de la EMA). Recortar
  la historia cambia los valores: hay que calcularlos siempre sobre la serie
  completa, igual que hace la app en `src/shared/indicators.ts`.

Las tres funciones replican las de `src/shared/indicators.ts`:

- `SMA(v, p)`: media simple; primer valor en el índice `p − 1`.
- `EMA(v, p)`: sembrada en `p − 1` con la SMA de las primeras `p`
  observaciones; `k = 2 / (p + 1)`.
- `RSI(14)`: Wilder. `avgGain`/`avgLoss` se siembran con la media de los
  primeros 14 cambios; recurrencia `m = (m·13 + x)/14`. Si `avgLoss = 0`:
  `100` si `avgGain > 0`, `50` si no.
- `ATR(14)`: Wilder sobre el rango verdadero `TR_i = max(h_i − l_i,
  |h_i − c_{i−1}|, |l_i − c_{i−1}|)`; en la primera vela `TR = h − l`.
  Siembra: media simple de los primeros 14 TR; recurrencia igual que RSI.
- `σ_p(x)`: desviación típica **poblacional** (ddof = 0) —
  `sqrt(mean((x − mean)²))`.
- `r_i`: retorno diario simple `c_i / c_{i−1} − 1`.

## Las 16 variables (orden del tensor de entrada)

El tensor de entrada de ambos ONNX es `input`, `float32`, forma `[N, 16]`,
con las columnas **en este orden exacto**:

| # | Nombre | Definición en la sesión `t` |
| - | --- | --- |
| 1 | `ret_1` | `c_t / c_{t−1} − 1` |
| 2 | `ret_5` | `c_t / c_{t−5} − 1` |
| 3 | `ret_10` | `c_t / c_{t−10} − 1` |
| 4 | `ret_21` | `c_t / c_{t−21} − 1` |
| 5 | `sma_ratio_10` | `c_t / SMA(c,10)_t − 1` |
| 6 | `sma_ratio_20` | `c_t / SMA(c,20)_t − 1` |
| 7 | `sma_ratio_50` | `c_t / SMA(c,50)_t − 1` |
| 8 | `ema_ratio_12_26` | `EMA(c,12)_t / EMA(c,26)_t − 1` |
| 9 | `rsi_14` | `RSI(14)_t` (0–100, Wilder) |
| 10 | `atr_14_pct` | `ATR(14)_t / c_t` |
| 11 | `vol_5` | `σ_p(r_{t−4..t})` (5 retornos) |
| 12 | `vol_20` | `σ_p(r_{t−19..t})` (20 retornos) |
| 13 | `range_pct` | `(h_t − l_t) / c_t` |
| 14 | `close_pos` | `(c_t − l_t) / (h_t − l_t)`; `0.5` si `h_t = l_t` |
| 15 | `gap_pct` | `o_t / c_{t−1} − 1` |
| 16 | `vol_rel_20` | `v_t / SMA(v,20)_t`; `1.0` si la media es `0` |

Todas están definidas a partir de `t = 49` (la más exigente es
`sma_ratio_50`).

## Etiquetas (solo entrenamiento)

- `y_up = 1` si `c_{t+5} > c_t` (subida **estricta** a `HORIZON_DAYS = 5`
  sesiones), si no `0`. Es la misma resolución que la app guarda en
  `predictions.acierto`.
- `y_vol = σ_p(r_{t+1..t+5})`: volatilidad realizada de los 5 retornos
  diarios siguientes (tanto por uno). Es el objetivo del regresor.

## Salidas servidas

- `model.onnx` (clasificador): salidas `label` e `probabilities` (`[N,2]`);
  `rawProbUp = probabilities[:,1]`.
- `pipeline.json` → `calibrator`: regresión isotónica ajustada solo con el
  tramo de validación. La probabilidad servida es

  ```
  probUp   = clip(interp_lineal(rawProbUp, xThresholds, yThresholds), 0, 1)
  probDown = 1 − probUp
  ```

  con interpolación lineal entre umbrales y extrapolación plana fuera del
  rango (`out_of_bounds='clip'` de `IsotonicRegression`).
- `vol.onnx` (regresor): una salida continua;
  `expectedVolatility = max(0, salida)` (tanto por uno, horizonte 5
  sesiones).

## Paridad con Node

`parity-fixture.json` contiene las velas completas de 2 activos y, para las
últimas 8 sesiones con variables definidas de cada uno, el vector de
variables esperado y las salidas esperadas (`rawProbUp`, `probUp`,
`probDown`, `expectedVolatility`). Los valores esperados se calcularon con
el ONNX exportado (no con LightGBM), así el fixture también verifica la
conversión. La prueba de Node debe calcular las variables sobre la historia
completa del fixture y comparar con tolerancia `1e-6`.
