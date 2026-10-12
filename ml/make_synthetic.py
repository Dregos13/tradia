#!/usr/bin/env python3
"""Genera un CSV de velas sintéticas determinista para desarrollar el pipeline.

Los datos NO son de mercado: sirven para verificar el pipeline de punta a
punta (entrenamiento, calibración, exportación ONNX, fixture de paridad)
mientras la app aún no acumula historia real. La ficha del modelo entrenado
con ellos queda marcada ``sintetico`` y nunca puede apoyar señales.

El proceso imita velas diarias de acciones/ETF (días laborables) con
regímenes de volatilidad y una pizca de estructura predecible (reversión a
corto plazo) para que el modelo pueda mostrar algo de habilidad fuera de
muestra. Todo depende solo de ``--seed``: misma semilla, mismo CSV.

Uso:

    python3 ml/make_synthetic.py --out ml/data/synthetic.csv
    python3 ml/make_synthetic.py --out datos.csv --tickers 8 --sessions 1200 --seed 7
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import math
import sys
from pathlib import Path

import numpy as np

COLUMNS = ["ticker", "date", "open", "high", "low", "close", "volume"]


def session_dates(start: dt.date, count: int) -> list[str]:
    """``count`` días laborables desde ``start`` (sin calendario de festivos)."""
    days: list[str] = []
    day = start
    while len(days) < count:
        if day.weekday() < 5:
            days.append(day.isoformat())
        day += dt.timedelta(days=1)
    return days


def generate_ticker(rng: np.random.RandomState, dates: list[str], price0: float) -> list[list]:
    """Serie OHLCV con reversión débil y cambios de régimen de volatilidad."""
    n = len(dates)
    closes = np.empty(n)
    opens = np.empty(n)
    highs = np.empty(n)
    lows = np.empty(n)
    volumes = np.empty(n)

    closes[0] = price0
    opens[0] = price0
    highs[0] = price0 * 1.003
    lows[0] = price0 * 0.997
    volumes[0] = 5_000_000

    vol_regime = 0.011  # volatilidad diaria de base; cambia por tramos
    vol_mult = 1.0
    for t in range(1, n):
        # Régimen de volatilidad persistente (conmuta con poca frecuencia).
        if rng.rand() < 0.02:
            vol_mult = float(rng.choice([0.6, 1.0, 1.0, 1.8], p=[0.2, 0.5, 0.15, 0.15]))
        sigma = vol_regime * vol_mult

        prev = closes[t - 1]
        ret_1 = closes[t - 1] / closes[t - 2] - 1.0 if t >= 2 else 0.0
        ret_5 = closes[t - 1] / closes[t - 6] - 1.0 if t >= 6 else 0.0

        # Estructura débilmente predecible: reversión del tramo reciente y un
        # poco de inercia del último movimiento, más ruido del régimen. La
        # señal se mantiene pequeña para que las métricas fuera de muestra
        # sean verosímiles (el modelo apenas supera la referencia).
        signal = -0.035 * math.tanh(10.0 * ret_5) + 0.015 * math.tanh(25.0 * ret_1)
        r = 0.0004 + signal + sigma * rng.randn()

        close = prev * math.exp(r)
        gap = 0.35 * sigma * rng.randn()
        open_ = prev * math.exp(gap)
        intraday = abs(0.8 * sigma * rng.randn()) + 0.001
        high = max(open_, close) * (1.0 + intraday * rng.rand())
        low = min(open_, close) * (1.0 - intraday * rng.rand())
        volume = 5_000_000 * (0.6 + 40.0 * abs(r) + 0.4 * rng.rand())

        opens[t], closes[t] = open_, close
        highs[t], lows[t] = high, low
        volumes[t] = volume

    rows = []
    for i, date in enumerate(dates):
        rows.append(
            [
                date,
                round(float(opens[i]), 6),
                round(float(highs[i]), 6),
                round(float(lows[i]), 6),
                round(float(closes[i]), 6),
                round(float(volumes[i]), 0),
            ]
        )
    return rows


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, required=True, help="CSV de salida")
    parser.add_argument("--tickers", type=int, default=6, help="número de activos (def. 6: SYN-A…)")
    parser.add_argument("--sessions", type=int, default=900, help="sesiones por activo (def. 900)")
    parser.add_argument("--start", default="2022-01-03", help="primera fecha laborable (def. 2022-01-03)")
    parser.add_argument("--seed", type=int, default=7, help="semilla (def. 7)")
    args = parser.parse_args()

    dates = session_dates(dt.date.fromisoformat(args.start), args.sessions)
    names = [f"SYN-{chr(ord('A') + i)}" for i in range(args.tickers)]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", newline="", encoding="utf-8") as out:
        writer = csv.writer(out, lineterminator="\n")
        writer.writerow(COLUMNS)
        for i, name in enumerate(names):
            rng = np.random.RandomState(args.seed * 1_000_003 + i)
            price0 = 40.0 + 25.0 * rng.rand()
            for row in generate_ticker(rng, dates, price0):
                writer.writerow([name, *row])
            print(f"{name}: {args.sessions} velas", file=sys.stderr)
    print(f"{len(names) * len(dates)} filas en {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
