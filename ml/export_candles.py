#!/usr/bin/env python3
"""Exporta las velas limpias de la base de datos de la app a CSV.

Lee ``tradia.db`` (SQLite, ver ``src/main/db/migrations/003_market_data.sql``)
y escribe una fila por ``(ticker, fecha)`` con los precios **ajustados** por
splits y dividendos — ``COALESCE(adj_*, crudo)``, la misma selección que
``toSourceBar`` en ``src/main/signals/index.ts``—, una sola fuente por serie:
la de la vela más reciente del ticker, como hace la ingesta
(``src/main/market/ingestion.ts``, «la del proveedor activo o la de la vela
más reciente guardada»).

Uso:

    python3 ml/export_candles.py --db <ruta-a-tradia.db> --out velas.csv
    python3 ml/export_candles.py --out velas.csv            # autodetecta la DB
    python3 ml/export_candles.py --db tradia.db --out aapl.csv --ticker AAPL

La base de datos vive en ``userData/tradia.db``: en macOS
``~/Library/Application Support/tradia/tradia.db``, en Linux
``~/.config/tradia/tradia.db`` y en Windows ``%APPDATA%/tradia/tradia.db``.

No modifica la base: abre el archivo en modo solo lectura (URI ``mode=ro``).
Solo usa la biblioteca estándar.
"""

from __future__ import annotations

import argparse
import csv
import os
import sqlite3
import sys
from pathlib import Path

COLUMNS = ["ticker", "date", "open", "high", "low", "close", "volume"]


def default_db_candidates() -> list[Path]:
    home = Path.home()
    candidates = [
        home / "Library" / "Application Support" / "tradia" / "tradia.db",
        home / ".config" / "tradia" / "tradia.db",
    ]
    appdata = os.environ.get("APPDATA")
    if appdata:
        candidates.append(Path(appdata) / "tradia" / "tradia.db")
    return candidates


def open_readonly(db_path: Path) -> sqlite3.Connection:
    uri = f"file:{db_path}?mode=ro"
    return sqlite3.connect(uri, uri=True)


def pick_source(con: sqlite3.Connection, ticker: str, requested: str | None) -> str | None:
    """Fuente única de la serie: la pedida, o la de la vela más reciente."""
    if requested is not None:
        return requested
    row = con.execute(
        "SELECT fuente FROM bars WHERE ticker = ? ORDER BY fecha DESC, lote_id DESC LIMIT 1",
        (ticker,),
    ).fetchone()
    return row[0] if row else None


def export(con: sqlite3.Connection, out, tickers: list[str], source: str | None) -> int:
    writer = csv.writer(out, lineterminator="\n")
    writer.writerow(COLUMNS)
    written = 0
    for ticker in sorted(t.upper() for t in tickers):
        fuente = pick_source(con, ticker, source)
        if fuente is None:
            print(f"aviso: {ticker} no tiene velas en la base", file=sys.stderr)
            continue
        rows = con.execute(
            """
            SELECT fecha,
                   COALESCE(adj_open, open),
                   COALESCE(adj_high, high),
                   COALESCE(adj_low, low),
                   COALESCE(adj_close, close),
                   COALESCE(adj_volume, volume)
            FROM bars
            WHERE ticker = ? AND fuente = ?
            ORDER BY fecha
            """,
            (ticker, fuente),
        )
        n = 0
        for fecha, o, h, l, c, v in rows:
            writer.writerow([ticker, fecha, o, h, l, c, v])
            n += 1
        written += n
        print(f"{ticker}: {n} velas (fuente '{fuente}')", file=sys.stderr)
    return written


def list_tickers(con: sqlite3.Connection) -> list[str]:
    rows = con.execute("SELECT DISTINCT ticker FROM bars ORDER BY ticker").fetchall()
    return [r[0] for r in rows]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--db", type=Path, help="ruta a tradia.db (por defecto se autodetecta en userData)")
    parser.add_argument("--out", type=Path, required=True, help="CSV de salida")
    parser.add_argument("--ticker", action="append", help="ticker a exportar (repetible; por defecto todos)")
    parser.add_argument("--source", help="fuente concreta (por defecto la de la vela más reciente de cada ticker)")
    args = parser.parse_args()

    db_path = args.db
    if db_path is None:
        for candidate in default_db_candidates():
            if candidate.exists():
                db_path = candidate
                break
    if db_path is None or not db_path.exists():
        print(
            "error: no se encontró tradia.db; pásala con --db (userData/tradia.db de la app)",
            file=sys.stderr,
        )
        return 2

    con = open_readonly(db_path)
    try:
        tickers = args.ticker or list_tickers(con)
        if not tickers:
            print("error: la base no tiene velas", file=sys.stderr)
            return 2
        with args.out.open("w", newline="", encoding="utf-8") as out:
            written = export(con, out, tickers, args.source)
        print(f"{written} filas escritas en {args.out}", file=sys.stderr)
    finally:
        con.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
