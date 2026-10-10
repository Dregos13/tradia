# ml/ — pipeline de entrenamiento del modelo predictivo

Entrena **fuera de la app** el modelo que da la probabilidad de subida a
5 sesiones (`PREDICTION_HORIZON_DAYS` en `src/shared/ai.ts`) y la volatilidad
esperada en ese horizonte, y lo exporta a ONNX para servirlo en Node. La app
nunca entrena: consume los artefactos de `resources/models/<version>/`.

## Requisitos

- Python ≥ 3.9 con `venv` (el `python3` del sistema en macOS sirve).
- En macOS LightGBM necesita OpenMP:

  ```bash
  brew install libomp
  ```

  En Linux suele bastar `libgomp` del sistema; las ruedas de Windows lo
  incluyen.

```bash
python3 -m venv .venv-ml
.venv-ml/bin/pip install -r ml/requirements.txt
```

`.venv-ml/` no se sube al repositorio.

## Piezas

| Archivo | Qué hace |
| --- | --- |
| `export_candles.py` | Lee `userData/tradia.db` en solo lectura y escribe el CSV de velas limpias (precios ajustados, una fuente por serie: la de la vela más reciente del ticker). |
| `make_synthetic.py` | Genera un CSV sintético determinista para desarrollar el pipeline sin datos reales. |
| `features.py` | Las 16 variables, espejo de `src/shared/indicators.ts` (ver `FEATURES.md`). |
| `train.py` | Corte 60/20/20, LightGBM clasificador + regresor de volatilidad, calibración isotónica sobre validación, exportación ONNX y todos los artefactos. |
| `FEATURES.md` | Especificación exacta de variables y salidas (el contrato con el servicio de Node). |

## Entrenar con datos reales

1. Exporta las velas limpias de la app:

   ```bash
   .venv-ml/bin/python ml/export_candles.py --out ml/data/velas.csv
   # o indica la base: --db ~/Library/Application\ Support/tradia/tradia.db
   ```

2. Entrena marcando el origen real:

   ```bash
   .venv-ml/bin/python ml/train.py --data ml/data/velas.csv --origin real
   ```

   `--origin` es `sintetico` por defecto a propósito: solo se declara `real`
   con datos exportados de la app.

3. Revisa la ficha generada en `resources/models/0.1.0/model-card.json`:
   el Brier fuera de muestra tiene que **mejorar** el de referencia para que
   el modelo quede apto para apoyar señales; si no, la ficha queda marcada
   no apta aunque lo actives.

Para desarrollar sin datos reales:

```bash
.venv-ml/bin/python ml/make_synthetic.py --out ml/data/synthetic.csv
.venv-ml/bin/python ml/train.py --data ml/data/synthetic.csv --origin sintetico
```

## Artefactos y cómo entra una versión nueva en la app

Cada ejecución escribe `resources/models/<version>/` (versión = `--version`,
por defecto `0.1.0`):

- `model.onnx` — clasificador de dirección (salida `probabilities`).
- `vol.onnx` — regresor de volatilidad esperada.
- `pipeline.json` — orden de las variables, umbrales de la calibración
  isotónica y hashes; es lo que necesita Node para servir el modelo.
- `model-card.json` — la ficha, con la forma de `ModelCard`
  (`src/shared/ai.ts`): versión, hash SHA-256 del `model.onnx`, horizonte,
  periodos del corte 60/20/20, origen, Brier/log loss fuera de muestra,
  Brier de referencia, bins de calibración y distribución de referencia de
  cada variable. `id` y `registeredAt` vienen a `0`/hora de entrenamiento:
  el servicio de la app los sustituye al registrar la ficha en
  `model_cards`.
- `parity-fixture.json` — velas de entrada, variables y probabilidades
  esperadas para la prueba de paridad de Node (tolerancia 1e-6).

`train.py` actualiza además `resources/models/current.json` con la versión
que acaba de escribir (se desactiva con `--no-activate`). **Así entra una
versión nueva en la app:** se entrena con `--version X.Y.Z`, el pipeline
deja `current.json` apuntando a ella y al empaquetar/ejecutar la app el
servicio de predicción carga `resources/models/<versión actual>` y registra
la ficha en `model_cards`. El flujo seguro es: entrenar → revisar que la
ficha quedó **apta** (`eligible: true`, origen `real` y Brier OOS mejor que
la referencia) → empaquetar. Una ficha no apta igualmente se puede cargar,
pero solo informa: no influye en señales.

## Honestidad y reproducibilidad

- Corte temporal 60/20/20 por activo (mismo reparto que `splitTimeline` del
  backtest) con purgado de 5 sesiones al final de entrenamiento y de
  calibración para que ninguna etiqueta mire dentro del tramo siguiente.
  La prueba final no se usa ni para entrenar ni para calibrar: todas las
  métricas de la ficha se calculan sobre ella con el pipeline servido
  (ONNX + calibración).
- La aptitud es la de `isModelEligible`: `eligible = origen 'real' y
  brierOos < brierBaseline`. Con origen sintético la ficha queda
  `Datos sintéticos · no apto`; con datos reales que no superan la
  referencia, `No supera la referencia · no apto para apoyar señales`.
- Reproducible: con la misma semilla (`--seed`, def. 42) y el mismo CSV, el
  SHA-256 de `model.onnx` y las métricas son idénticos (LightGBM con
  `deterministic`, una hebra y nombre de grafo fijado; el `graph.name`
  aleatorio de onnxmltools se sobrescribe). Para reproducir también la ficha
  byte a byte hay que fijar `--trained-at`.
- Comprobación rápida:

  ```bash
  .venv-ml/bin/python ml/train.py --data <csv> --trained-at 2026-01-01T00:00:00Z
  sha256sum resources/models/0.1.0/model.onnx
  # repetir: el hash y las métricas deben ser idénticos
  ```
