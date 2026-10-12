"""Variables del modelo predictivo — espejo de ``src/shared/indicators.ts``.

Las funciones de indicadores replican una a una las definiciones del código
de la app (SMA, EMA sembrada con SMA, RSI y ATR con suavizado de Wilder) para
que el servicio de predicción en Node obtenga los mismos valores bit a bit
dentro de la tolerancia de paridad (1e-6).

Reglas del contrato (ver FEATURES.md):

- La entrada es una serie de velas ordenada de antigua a reciente.
- Las variables de la sesión ``t`` solo usan velas con índice ``<= t``
  (sin look-ahead).
- RSI, ATR y EMA se siembran al inicio de la serie y arrastran estado: hay
  que calcularlos sobre la historia completa disponible del activo, no sobre
  una ventana recortada.
- Todas las series devueltas tienen la misma longitud que la entrada, con
  ``None`` donde aún no hay datos suficientes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from typing import Optional, Sequence

HORIZON_DAYS = 5

# Orden exacto de las columnas del tensor de entrada del modelo ONNX. El
# servicio de Node construye el vector en este mismo orden.
FEATURE_NAMES = [
    "ret_1",
    "ret_5",
    "ret_10",
    "ret_21",
    "sma_ratio_10",
    "sma_ratio_20",
    "sma_ratio_50",
    "ema_ratio_12_26",
    "rsi_14",
    "atr_14_pct",
    "vol_5",
    "vol_20",
    "range_pct",
    "close_pos",
    "gap_pct",
    "vol_rel_20",
]


@dataclass(frozen=True)
class Candle:
    date: str  # 'YYYY-MM-DD'
    open: float
    high: float
    low: float
    close: float
    volume: float


Series = list[Optional[float]]


def sma(values: Sequence[float], period: int) -> Series:
    """Media móvil simple; primer valor en el índice ``period - 1``."""
    out: Series = [None] * len(values)
    acc = 0.0
    for i, v in enumerate(values):
        acc += v
        if i >= period:
            acc -= values[i - period]
        if i >= period - 1:
            out[i] = acc / period
    return out


def ema(values: Sequence[float], period: int) -> Series:
    """EMA sembrada en ``period - 1`` con la SMA de las primeras ``period``
    observaciones y ``k = 2 / (period + 1)`` (misma convención que la app)."""
    out: Series = [None] * len(values)
    if len(values) < period:
        return out
    k = 2.0 / (period + 1)
    value = sum(values[:period]) / period
    out[period - 1] = value
    for i in range(period, len(values)):
        value = values[i] * k + value * (1 - k)
        out[i] = value
    return out


def _rsi_from_averages(avg_gain: float, avg_loss: float) -> float:
    if avg_loss == 0:
        return 50.0 if avg_gain == 0 else 100.0
    return 100.0 - 100.0 / (1.0 + avg_gain / avg_loss)


def rsi(closes: Sequence[float], period: int = 14) -> Series:
    """RSI de Wilder; primer valor en el índice ``period``."""
    out: Series = [None] * len(closes)
    if len(closes) <= period:
        return out
    avg_gain = 0.0
    avg_loss = 0.0
    for i in range(1, period + 1):
        change = closes[i] - closes[i - 1]
        avg_gain += max(change, 0.0)
        avg_loss += max(-change, 0.0)
    avg_gain /= period
    avg_loss /= period
    out[period] = _rsi_from_averages(avg_gain, avg_loss)
    for i in range(period + 1, len(closes)):
        change = closes[i] - closes[i - 1]
        avg_gain = (avg_gain * (period - 1) + max(change, 0.0)) / period
        avg_loss = (avg_loss * (period - 1) + max(-change, 0.0)) / period
        out[i] = _rsi_from_averages(avg_gain, avg_loss)
    return out


def true_range(candles: Sequence[Candle]) -> Series:
    """Rango verdadero; en la primera vela ``high - low``."""
    out: Series = [None] * len(candles)
    prev_close: Optional[float] = None
    for i, c in enumerate(candles):
        if prev_close is None:
            out[i] = c.high - c.low
        else:
            out[i] = max(
                c.high - c.low,
                abs(c.high - prev_close),
                abs(c.low - prev_close),
            )
        prev_close = c.close
    return out


def atr(candles: Sequence[Candle], period: int = 14) -> Series:
    """ATR de Wilder; primer valor en ``period - 1`` (media simple)."""
    tr = true_range(candles)
    out: Series = [None] * len(candles)
    if len(candles) < period:
        return out
    value = sum(tr[i] for i in range(period)) / period  # type: ignore[arg-type]
    out[period - 1] = value
    for i in range(period, len(candles)):
        value = (value * (period - 1) + tr[i]) / period  # type: ignore[operator]
        out[i] = value
    return out


def _pstdev(values: Sequence[float]) -> float:
    """Desviación típica poblacional (ddof=0)."""
    n = len(values)
    mean = sum(values) / n
    return math.sqrt(sum((v - mean) ** 2 for v in values) / n)


def feature_row(candles: Sequence[Candle], t: int) -> Optional[dict[str, float]]:
    """Variables de la sesión ``t`` usando solo velas ``0..t``.

    Devuelve ``None`` si alguna variable aún no está definida (historia
    insuficiente). ``indicators`` se precomputa con :func:`precompute` para
    no recalcular las series en cada llamada.
    """
    ind = precompute(candles)
    return feature_row_at(ind, candles, t)


def precompute(candles: Sequence[Candle]) -> dict[str, Series]:
    """Series de indicadores sobre la historia completa."""
    closes = [c.close for c in candles]
    volumes = [c.volume for c in candles]
    return {
        "closes": closes,
        "volumes": volumes,
        "sma10": sma(closes, 10),
        "sma20": sma(closes, 20),
        "sma50": sma(closes, 50),
        "ema12": ema(closes, 12),
        "ema26": ema(closes, 26),
        "rsi14": rsi(closes, 14),
        "atr14": atr(candles, 14),
        "sma_vol20": sma(volumes, 20),
    }


def _ret(closes: Sequence[float], t: int, lag: int) -> Optional[float]:
    if t - lag < 0 or closes[t - lag] == 0:
        return None
    return closes[t] / closes[t - lag] - 1.0


def feature_row_at(ind: dict[str, Series], candles: Sequence[Candle], t: int) -> Optional[dict[str, float]]:
    """Fila de variables en el índice ``t`` a partir de series precomputadas."""
    closes: list[float] = ind["closes"]  # type: ignore[assignment]
    volumes: list[float] = ind["volumes"]  # type: ignore[assignment]
    c = candles[t]

    ret_1 = _ret(closes, t, 1)
    ret_5 = _ret(closes, t, 5)
    ret_10 = _ret(closes, t, 10)
    ret_21 = _ret(closes, t, 21)
    sma10, sma20, sma50 = ind["sma10"][t], ind["sma20"][t], ind["sma50"][t]
    ema12, ema26 = ind["ema12"][t], ind["ema26"][t]
    rsi14, atr14, sma_vol20 = ind["rsi14"][t], ind["atr14"][t], ind["sma_vol20"][t]
    if None in (ret_1, ret_5, ret_10, ret_21, sma10, sma20, sma50, ema12, ema26, rsi14, atr14, sma_vol20):
        return None
    if t < 20:  # vol_20 necesita 20 retornos
        return None

    rets = [closes[i] / closes[i - 1] - 1.0 for i in range(1, t + 1)]
    mean_vol = sma_vol20 if sma_vol20 and sma_vol20 > 0 else None
    span = c.high - c.low

    return {
        "ret_1": ret_1,  # type: ignore[dict-item]
        "ret_5": ret_5,  # type: ignore[dict-item]
        "ret_10": ret_10,  # type: ignore[dict-item]
        "ret_21": ret_21,  # type: ignore[dict-item]
        "sma_ratio_10": c.close / sma10 - 1.0,  # type: ignore[operator]
        "sma_ratio_20": c.close / sma20 - 1.0,  # type: ignore[operator]
        "sma_ratio_50": c.close / sma50 - 1.0,  # type: ignore[operator]
        "ema_ratio_12_26": ema12 / ema26 - 1.0,  # type: ignore[operator]
        "rsi_14": rsi14,  # type: ignore[dict-item]
        "atr_14_pct": atr14 / c.close,  # type: ignore[operator]
        "vol_5": _pstdev(rets[-5:]),
        "vol_20": _pstdev(rets[-20:]),
        "range_pct": span / c.close,
        "close_pos": (c.close - c.low) / span if span > 0 else 0.5,
        "gap_pct": c.open / closes[t - 1] - 1.0 if t >= 1 else 0.0,
        "vol_rel_20": c.volume / mean_vol if mean_vol else 1.0,
    }


def forward_labels(candles: Sequence[Candle], t: int, horizon: int = HORIZON_DAYS) -> Optional[tuple[int, float]]:
    """Etiquetas de la sesión ``t``: (subió a ``horizon`` sesiones, volatilidad realizada).

    ``y_up`` es 1 solo si el cierre a ``t + horizon`` es estrictamente mayor;
    ``y_vol`` es la desviación típica poblacional de los ``horizon`` retornos
    diarios siguientes. ``None`` si no hay ``horizon`` velas posteriores.
    """
    closes = [c.close for c in candles]
    if t + horizon >= len(closes):
        return None
    fwd = [closes[t + i] / closes[t + i - 1] - 1.0 for i in range(1, horizon + 1)]
    return (1 if closes[t + horizon] > closes[t] else 0, _pstdev(fwd))
