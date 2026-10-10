#!/usr/bin/env python3
"""Pipeline de entrenamiento del modelo predictivo — fuera de la app.

Entrena un gradient boosting (LightGBM) que da la probabilidad de que el
cierre suba a ``HORIZON_DAYS`` sesiones y otro que estima la volatilidad
realizada en ese horizonte, calibra la probabilidad con regresión isotónica
sobre el tramo de validación y exporta todo a ONNX para servirlo en Node:

    resources/models/<version>/model.onnx          clasificador de dirección
    resources/models/<version>/vol.onnx            regresor de volatilidad
    resources/models/<version>/pipeline.json       orden de variables + calibrador
    resources/models/<version>/model-card.json     ficha (tipo ModelCard de src/shared/ai.ts)
    resources/models/<version>/parity-fixture.json paridad para la prueba en Node
    resources/models/current.json                  versión que carga la app

Corte temporal 60/20/20 por activo (entrenamiento / calibración / prueba),
con un purgado de ``horizonte`` sesiones al final de entrenamiento y de
calibración para que ninguna etiqueta mire dentro del tramo siguiente. La
prueba final no se usa ni para entrenar ni para calibrar.

Reproducible: con la misma semilla y el mismo CSV, el SHA-256 de model.onnx
y las métricas son idénticos (LightGBM con ``deterministic`` y una hebra).

Uso:

    python3 ml/train.py --data velas.csv --origin real
    python3 ml/train.py --data ml/data/synthetic.csv --origin sintetico
    python3 ml/train.py --data velas.csv --version 0.2.0 --seed 42
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import math
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(Path(__file__).resolve().parent))

from features import (  # noqa: E402
    FEATURE_NAMES,
    HORIZON_DAYS,
    Candle,
    feature_row_at,
    forward_labels,
    precompute,
)

PIPELINE_VERSION = "0.1.0"
DEFAULT_SEED = 42
SPLIT_TRAIN = 0.6
SPLIT_VALIDATION = 0.2
# El resto (0,2) es la prueba final.
MIN_SAMPLES_PER_SPLIT = 30
CALIBRATION_BINS = 10
REFERENCE_BINS = 10
# Tolerancia de la autocomprobación LightGBM↔ONNX y de la prueba de paridad
# que ejecuta el servicio de Node (be-prediccion-servicio).
PARITY_TOLERANCE = 1e-6

CLASSIFIER_PARAMS = {
    "n_estimators": 300,
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_child_samples": 20,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
}
REGRESSOR_PARAMS = {
    "n_estimators": 200,
    "learning_rate": 0.05,
    "num_leaves": 31,
    "min_child_samples": 20,
    "feature_fraction": 0.9,
    "bagging_fraction": 0.9,
    "bagging_freq": 1,
    "lambda_l2": 1.0,
}


@dataclass(frozen=True)
class Sample:
    ticker: str
    index: int  # posición de la sesión dentro de la serie del ticker
    date: str
    features: list[float]  # en el orden de FEATURE_NAMES
    y_up: int
    y_vol: float


# ---------------------------------------------------------------------------
# Datos
# ---------------------------------------------------------------------------


def load_candles_csv(path: Path) -> dict[str, list[Candle]]:
    """Lee el CSV (ticker,date,open,high,low,close,volume) ordenado por sesión.

    Valida la estructura mínima de la limpieza de la app: fecha ISO real,
    números finitos, high >= low, precios > 0 y volumen >= 0. Las filas
    inválidas se descartan con aviso (la exportación ya las dejó limpias).
    """
    by_ticker: dict[str, dict[str, Candle]] = {}
    dropped = 0
    with path.open(newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        required = {"ticker", "date", "open", "high", "low", "close", "volume"}
        if reader.fieldnames is None or not required.issubset(set(reader.fieldnames)):
            raise SystemExit(f"error: el CSV necesita las columnas {sorted(required)}")
        for row in reader:
            try:
                candle = Candle(
                    date=str(row["date"]),
                    open=float(row["open"]),
                    high=float(row["high"]),
                    low=float(row["low"]),
                    close=float(row["close"]),
                    volume=float(row["volume"]),
                )
            except (KeyError, TypeError, ValueError):
                dropped += 1
                continue
            ok = (
                all(math.isfinite(v) for v in (candle.open, candle.high, candle.low, candle.close, candle.volume))
                and candle.high >= candle.low
                and min(candle.open, candle.high, candle.low, candle.close) > 0
                and candle.volume >= 0
            )
            try:
                dt_check = datetime.fromisoformat(candle.date)
                ok = ok and dt_check.strftime("%Y-%m-%d") == candle.date
            except ValueError:
                ok = False
            if not ok:
                dropped += 1
                continue
            ticker = str(row["ticker"]).strip().upper()
            by_ticker.setdefault(ticker, {})[candle.date] = candle
    if dropped:
        print(f"aviso: {dropped} filas descartadas por inválidas", file=sys.stderr)
    if not by_ticker:
        raise SystemExit("error: el CSV no contiene velas utilizables")
    return {t: [d[k] for k in sorted(d)] for t, d in sorted(by_ticker.items())}


def build_samples(by_ticker: dict[str, list[Candle]]) -> dict[str, list[Sample]]:
    """Muestras (features, etiqueta) por ticker, ordenadas por sesión."""
    out: dict[str, list[Sample]] = {}
    for ticker, candles in by_ticker.items():
        ind = precompute(candles)
        samples: list[Sample] = []
        for t in range(len(candles)):
            row = feature_row_at(ind, candles, t)
            labels = forward_labels(candles, t)
            if row is None or labels is None:
                continue
            y_up, y_vol = labels
            samples.append(
                Sample(
                    ticker=ticker,
                    index=t,
                    date=candles[t].date,
                    features=[row[name] for name in FEATURE_NAMES],
                    y_up=y_up,
                    y_vol=y_vol,
                )
            )
        out[ticker] = samples
    return out


def split_samples(
    by_ticker: dict[str, list[Candle]],
    samples: dict[str, list[Sample]],
) -> dict[str, list[Sample]]:
    """Corte 60/20/20 por sesiones de cada ticker, con purgado de horizonte.

    El reparto replica ``splitTimeline`` de ``src/main/backtest/validation.ts``
    (floor sobre el número de sesiones del ticker). Las ``HORIZON_DAYS``
    últimas sesiones de entrenamiento y de calibración quedan fuera: su
    etiqueta miraría dentro del tramo siguiente.
    """
    result = {"train": [], "calibration": [], "test": []}
    for ticker, candles in by_ticker.items():
        n = len(candles)
        train_end = max(1, int(math.floor(n * SPLIT_TRAIN)))
        val_end = train_end + max(1, int(math.floor(n * SPLIT_VALIDATION)))
        val_end = min(val_end, n - 1)
        train_limit = train_end - HORIZON_DAYS  # purgado de etiquetas
        val_limit = val_end - HORIZON_DAYS
        for s in samples[ticker]:
            if s.index < train_limit:
                result["train"].append(s)
            elif s.index < val_limit and s.index >= train_end:
                result["calibration"].append(s)
            elif s.index >= val_end:
                result["test"].append(s)
            # Las sesiones del hueco de purgado no entran en ningún tramo.
    return result


def period_of(samples: list[Sample]) -> dict[str, str]:
    dates = sorted(s.date for s in samples)
    return {"startDate": dates[0], "endDate": dates[-1]}


# ---------------------------------------------------------------------------
# Métricas y ficha
# ---------------------------------------------------------------------------


def brier_score(probs: np.ndarray, y: np.ndarray) -> float:
    return float(np.mean((probs - y) ** 2))


def calibration_bins(probs: np.ndarray, y: np.ndarray, bins: int = CALIBRATION_BINS) -> list[dict]:
    """Bins uniformes del diagrama de calibración (solo los no vacíos)."""
    out = []
    edges = np.linspace(0.0, 1.0, bins + 1)
    for i in range(bins):
        lo, hi = edges[i], edges[i + 1]
        mask = (probs >= lo) & (probs < hi) if i < bins - 1 else (probs >= lo) & (probs <= hi)
        count = int(mask.sum())
        if count == 0:
            continue
        out.append(
            {
                "from": float(lo),
                "to": float(hi),
                "meanPredicted": float(probs[mask].mean()),
                "observed": float(y[mask].mean()),
                "count": count,
            }
        )
    return out


def reference_distribution(features: np.ndarray) -> list[dict]:
    """Distribución de referencia por variable sobre el entrenamiento (PSI).

    Bins por deciles con los extremos abiertos (null = -inf/inf), la misma
    forma que espera ``FeatureReference`` de src/shared/ai.ts.
    """
    refs = []
    for j, name in enumerate(FEATURE_NAMES):
        col = features[:, j]
        quantiles = [float(np.quantile(col, k / REFERENCE_BINS)) for k in range(1, REFERENCE_BINS)]
        edges = [-math.inf, *quantiles, math.inf]
        hist = np.histogram(col, bins=edges)[0].astype(float)
        total = hist.sum() or 1.0
        bins = []
        for i in range(REFERENCE_BINS):
            bins.append(
                {
                    "from": None if i == 0 else edges[i],
                    "to": None if i == REFERENCE_BINS - 1 else edges[i + 1],
                    "proportion": float(hist[i] / total),
                }
            )
        refs.append(
            {
                "name": name,
                "mean": float(col.mean()),
                "std": float(col.std()),
                "bins": bins,
            }
        )
    return refs


# ---------------------------------------------------------------------------
# Validación de la ficha contra el tipo ModelCard de src/shared/ai.ts
# ---------------------------------------------------------------------------


def _is_iso_date(value) -> bool:
    """'YYYY-MM-DD' o ISO 8601 con hora (fromisoformat de py3.9 no acepta 'Z')."""
    if not isinstance(value, str) or not value:
        return False
    try:
        datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return False
    return "T" in value or len(value) == 10


def validate_model_card(card: dict) -> list[str]:
    """Comprobación estructural de la ficha contra ``ModelCard`` (ai.ts)."""
    errors: list[str] = []
    period = lambda p: isinstance(p, dict) and isinstance(p.get("startDate"), str) and isinstance(p.get("endDate"), str)
    checks = [
        (isinstance(card.get("id"), int), "id entero"),
        (isinstance(card.get("version"), str) and card["version"], "version"),
        (isinstance(card.get("hash"), str) and len(card["hash"]) == 64, "hash sha256"),
        (isinstance(card.get("horizonDays"), int) and card["horizonDays"] >= 1, "horizonDays"),
        (period(card.get("trainingPeriod")), "trainingPeriod"),
        (period(card.get("calibrationPeriod")), "calibrationPeriod"),
        (period(card.get("testPeriod")), "testPeriod"),
        (card.get("dataOrigin") in ("real", "sintetico"), "dataOrigin"),
        (isinstance(card.get("metrics"), dict), "metrics"),
        (isinstance(card.get("calibration"), list), "calibration"),
        (isinstance(card.get("referenceDistribution"), list), "referenceDistribution"),
        (isinstance(card.get("eligible"), bool), "eligible"),
        (card.get("ineligibleReason") is None or isinstance(card["ineligibleReason"], str), "ineligibleReason"),
        (_is_iso_date(card.get("trainedAt")), "trainedAt ISO"),
        (_is_iso_date(card.get("registeredAt")), "registeredAt ISO"),
    ]
    for ok, name in checks:
        if not ok:
            errors.append(name)
    metrics = card.get("metrics") or {}
    for key in ("brierOos", "brierBaseline"):
        if not isinstance(metrics.get(key), (int, float)):
            errors.append(f"metrics.{key}")
    if metrics.get("logLossOos") is not None and not isinstance(metrics["logLossOos"], (int, float)):
        errors.append("metrics.logLossOos")
    for i, b in enumerate(card.get("calibration") or []):
        if not all(isinstance(b.get(k), (int, float)) for k in ("from", "to", "meanPredicted", "observed")) or not isinstance(b.get("count"), int):
            errors.append(f"calibration[{i}]")
    for i, f in enumerate(card.get("referenceDistribution") or []):
        if not isinstance(f.get("name"), str) or not isinstance(f.get("bins"), list):
            errors.append(f"referenceDistribution[{i}]")
    return errors


# ---------------------------------------------------------------------------
# Entrenamiento y exportación
# ---------------------------------------------------------------------------


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def to_onnx(booster, n_features: int, zipmap: bool | None):
    import onnxmltools
    from onnxmltools.convert.common.data_types import FloatTensorType

    kwargs = {"zipmap": False} if zipmap is False else {}
    model = onnxmltools.convert_lightgbm(
        booster,
        initial_types=[("input", FloatTensorType([None, n_features]))],
        **kwargs,
    )
    # onnxmltools declara las salidas con dimensión fija 1; se corrige a N
    # para que onnxruntime no avise en cada inferencia.
    for output in model.graph.output:
        dims = output.type.tensor_type.shape.dim
        if dims and dims[0].HasField("dim_value") and dims[0].dim_value == 1:
            dims[0].ClearField("dim_value")
            dims[0].dim_param = "N"
    return model


def onnx_probs(model_bytes: bytes, x: np.ndarray) -> np.ndarray:
    """Probabilidad de la clase 1 según el ONNX (salida 'probabilities')."""
    import onnxruntime as rt

    sess = rt.InferenceSession(model_bytes, providers=["CPUExecutionProvider"])
    out_names = [o.name for o in sess.get_outputs()]
    res = sess.run(out_names, {"input": x.astype(np.float32)})
    probs = res[out_names.index("probabilities")]
    return np.asarray(probs)[:, 1].astype(np.float64)


def onnx_values(model_bytes: bytes, x: np.ndarray) -> np.ndarray:
    """Salida continua del regresor ONNX."""
    import onnxruntime as rt

    sess = rt.InferenceSession(model_bytes, providers=["CPUExecutionProvider"])
    ins = sess.get_inputs()
    outs = sess.get_outputs()
    res = sess.run([o.name for o in outs], {ins[0].name: x.astype(np.float32)})
    return np.asarray(res[0]).reshape(-1).astype(np.float64)


def build_fixture(
    by_ticker: dict[str, list[Candle]],
    model_bytes: bytes,
    vol_bytes: bytes,
    calibrator,
    version: str,
    n_tickers: int = 2,
    n_sessions: int = 8,
) -> dict:
    """Fixture de paridad: velas completas + variables + salidas esperadas.

    Las probabilidades esperadas se calculan con el ONNX exportado (no con
    LightGBM), de modo que el fixture también prueba la conversión.
    """
    tickers = sorted(by_ticker)[:n_tickers]
    candles_json = {
        t: [
            {
                "date": c.date,
                "open": c.open,
                "high": c.high,
                "low": c.low,
                "close": c.close,
                "volume": c.volume,
            }
            for c in by_ticker[t]
        ]
        for t in tickers
    }
    samples = []
    for ticker in tickers:
        candles = by_ticker[ticker]
        ind = precompute(candles)
        rows = []
        for t in range(len(candles)):
            feats = feature_row_at(ind, candles, t)
            if feats is not None:
                rows.append((t, feats))
        for t, feats in rows[-n_sessions:]:
            x = np.array([[feats[name] for name in FEATURE_NAMES]], dtype=np.float64)
            raw = float(onnx_probs(model_bytes, x)[0])
            prob_up = float(np.clip(calibrator.predict([raw])[0], 0.0, 1.0))
            vol = float(max(0.0, onnx_values(vol_bytes, x)[0]))
            samples.append(
                {
                    "ticker": ticker,
                    "session": candles[t].date,
                    "features": {name: feats[name] for name in FEATURE_NAMES},
                    "input": [feats[name] for name in FEATURE_NAMES],
                    "rawProbUp": raw,
                    "probUp": prob_up,
                    "probDown": 1.0 - prob_up,
                    "expectedVolatility": vol,
                }
            )
    return {
        "pipelineVersion": version,
        "horizonDays": HORIZON_DAYS,
        "featureNames": FEATURE_NAMES,
        "tolerance": PARITY_TOLERANCE,
        "candles": candles_json,
        "samples": samples,
    }


def write_json(path: Path, payload: dict) -> None:
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, required=True, help="CSV de velas (ver export_candles.py)")
    parser.add_argument("--version", default=PIPELINE_VERSION, help=f"versión del pipeline (def. {PIPELINE_VERSION})")
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED, help=f"semilla (def. {DEFAULT_SEED})")
    parser.add_argument(
        "--origin",
        choices=["real", "sintetico"],
        default="sintetico",
        help="origen de los datos; 'real' exige --data exportado de la app (def. sintetico)",
    )
    parser.add_argument("--out", type=Path, default=REPO_ROOT / "resources" / "models", help="directorio de modelos")
    parser.add_argument("--trained-at", help="ISO 8601 del entrenamiento (def. ahora; fijable para reproducir la ficha)")
    parser.add_argument("--no-activate", action="store_true", help="no actualizar resources/models/current.json")
    args = parser.parse_args()

    import lightgbm as lgb
    from sklearn.isotonic import IsotonicRegression
    from sklearn.metrics import log_loss

    trained_at = args.trained_at or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"

    # -- Datos y muestras -----------------------------------------------------
    by_ticker = load_candles_csv(args.data)
    samples = build_samples(by_ticker)
    splits = split_samples(by_ticker, samples)
    counts = {k: len(v) for k, v in splits.items()}
    print(f"muestras: train={counts['train']} calibración={counts['calibration']} prueba={counts['test']}")
    if min(counts.values()) < MIN_SAMPLES_PER_SPLIT:
        raise SystemExit(
            f"error: hacen falta al menos {MIN_SAMPLES_PER_SPLIT} muestras por tramo "
            f"(train/calibración/prueba = {counts}); hace falta más historia"
        )

    x_train = np.array([s.features for s in splits["train"]], dtype=np.float64)
    y_train = np.array([s.y_up for s in splits["train"]], dtype=np.int64)
    v_train = np.array([s.y_vol for s in splits["train"]], dtype=np.float64)
    x_val = np.array([s.features for s in splits["calibration"]], dtype=np.float64)
    y_val = np.array([s.y_up for s in splits["calibration"]], dtype=np.int64)
    x_test = np.array([s.features for s in splits["test"]], dtype=np.float64)
    y_test = np.array([s.y_up for s in splits["test"]], dtype=np.int64)
    if y_train.min() == y_train.max():
        raise SystemExit("error: el entrenamiento tiene una sola clase; no hay modelo que entrenar")

    # -- Clasificador de dirección -------------------------------------------
    common = {"deterministic": True, "force_col_wise": True, "n_jobs": 1, "seed": args.seed, "verbose": -1}
    clf = lgb.LGBMClassifier(**CLASSIFIER_PARAMS, **common)
    clf.fit(x_train, y_train)
    raw_val = clf.predict_proba(x_val)[:, 1]
    raw_test = clf.predict_proba(x_test)[:, 1]

    # Calibración isotónica SOLO sobre el tramo de validación.
    calibrator = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    calibrator.fit(raw_val, y_val)

    # -- Regresor de volatilidad ----------------------------------------------
    reg = lgb.LGBMRegressor(**REGRESSOR_PARAMS, **common)
    reg.fit(x_train, v_train)

    # -- Exportación ONNX ------------------------------------------------------
    n_features = len(FEATURE_NAMES)
    model_onnx = to_onnx(clf.booster_, n_features, zipmap=False).SerializeToString()
    vol_onnx = to_onnx(reg.booster_, n_features, zipmap=None).SerializeToString()

    # Autocomprobación de la conversión: las probabilidades del ONNX deben
    # coincidir con las de LightGBM dentro de la tolerancia de paridad.
    onnx_raw_test = onnx_probs(model_onnx, x_test)
    max_diff = float(np.max(np.abs(onnx_raw_test - raw_test)))
    if max_diff > PARITY_TOLERANCE:
        raise SystemExit(
            f"error: el ONNX difiere de LightGBM en {max_diff:.3e} (tolerancia {PARITY_TOLERANCE})"
        )

    # Métricas fuera de muestra sobre la PRUEBA FINAL con el pipeline servido
    # (ONNX + calibración isotónica), no con LightGBM directamente.
    p_test = np.clip(calibrator.predict(onnx_raw_test), 0.0, 1.0)
    base_rate = float(y_train.mean())
    metrics = {
        "brierOos": brier_score(p_test, y_test),
        "logLossOos": float(log_loss(y_test, p_test, labels=[0, 1])),
        "brierBaseline": brier_score(np.full_like(y_test, base_rate, dtype=np.float64), y_test),
    }

    eligible = args.origin == "real" and metrics["brierOos"] < metrics["brierBaseline"]
    if args.origin != "real":
        ineligible_reason = "Datos sintéticos · no apto"
    elif not eligible:
        ineligible_reason = "No supera la referencia · no apto para apoyar señales"
    else:
        ineligible_reason = None

    # -- Escritura de artefactos ----------------------------------------------
    out_dir = args.out / args.version
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "model.onnx").write_bytes(model_onnx)
    (out_dir / "vol.onnx").write_bytes(vol_onnx)
    model_hash = sha256_file(out_dir / "model.onnx")
    vol_hash = sha256_file(out_dir / "vol.onnx")

    pipeline = {
        "pipelineVersion": args.version,
        "horizonDays": HORIZON_DAYS,
        "featureNames": FEATURE_NAMES,
        "models": {"direction": "model.onnx", "volatility": "vol.onnx"},
        "input": {"name": "input", "dtype": "float32", "shape": [None, n_features]},
        "outputs": {"direction": "probabilities", "volatility": None},
        "calibrator": {
            "kind": "isotonic",
            "comment": "probUp = clip(interp_lineal(rawProbUp, xThresholds, yThresholds), 0, 1)",
            "xThresholds": [float(v) for v in calibrator.X_thresholds_],
            "yThresholds": [float(v) for v in calibrator.y_thresholds_],
        },
        "expectedVolatility": "max(0, salida de vol.onnx)",
        "hash": {"model.onnx": model_hash, "vol.onnx": vol_hash},
        "training": {
            "seed": args.seed,
            "split": [SPLIT_TRAIN, SPLIT_VALIDATION, 1.0 - SPLIT_TRAIN - SPLIT_VALIDATION],
            "purgeDays": HORIZON_DAYS,
            "classifier": CLASSIFIER_PARAMS,
            "regressor": REGRESSOR_PARAMS,
        },
    }
    write_json(out_dir / "pipeline.json", pipeline)

    card = {
        "id": 0,
        "version": args.version,
        "hash": model_hash,
        "horizonDays": HORIZON_DAYS,
        "trainingPeriod": period_of(splits["train"]),
        "calibrationPeriod": period_of(splits["calibration"]),
        "testPeriod": period_of(splits["test"]),
        "dataOrigin": args.origin,
        "metrics": metrics,
        "calibration": calibration_bins(p_test, y_test),
        "referenceDistribution": reference_distribution(x_train),
        "eligible": eligible,
        "ineligibleReason": ineligible_reason,
        "trainedAt": trained_at,
        "registeredAt": trained_at,
    }
    errors = validate_model_card(card)
    if errors:
        raise SystemExit(f"error: la ficha no cumple el tipo ModelCard: {errors}")
    write_json(out_dir / "model-card.json", card)

    fixture = build_fixture(by_ticker, model_onnx, vol_onnx, calibrator, args.version)
    write_json(out_dir / "parity-fixture.json", fixture)

    if not args.no_activate:
        write_json(args.out / "current.json", {"version": args.version})

    print(f"model.onnx  sha256={model_hash}")
    print(f"vol.onnx    sha256={vol_hash}")
    print(
        f"métricas prueba final: brier={metrics['brierOos']:.6f} "
        f"referencia={metrics['brierBaseline']:.6f} logLoss={metrics['logLossOos']:.6f}"
    )
    print(f"apto para señales: {eligible}" + (f" ({ineligible_reason})" if ineligible_reason else ""))
    print(f"artefactos en {out_dir}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
