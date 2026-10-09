# QA — Métricas de backtest: caso verificado a mano

**Fecha:** 2026-10-09
**Módulo:** `src/main/backtest/metrics.ts` · **Prueba:** `src/main/backtest/metrics.test.ts`
**Propósito:** fijar un caso pequeño (10 puntos de capital, 6 operaciones) cuyas métricas se calculan a mano y se comparan con la salida del módulo. Sirve de referencia para detectar regresiones en el informe de backtest.

## Datos del caso

### Curva de capital (10 días, 2024-01-01 → 2024-01-10)

Construida para que los rendimientos diarios sean porcentajes exactos `[+2, -1, 0, +1, -1, +2, -1, 0, +1] %`:

| Fecha | Equity | Rendimiento diario |
| --- | ---: | ---: |
| 2024-01-01 | 10000,0000 | — |
| 2024-01-02 | 10200,0000 | +2 % |
| 2024-01-03 | 10098,0000 | -1 % |
| 2024-01-04 | 10098,0000 | 0 % |
| 2024-01-05 | 10198,9800 | +1 % |
| 2024-01-06 | 10096,9902 | -1 % |
| 2024-01-07 | 10298,9300 | +2 % |
| 2024-01-08 | 10195,9407 | -1 % |
| 2024-01-09 | 10195,9407 | 0 % |
| 2024-01-10 | 10297,9001 | +1 % |

### Operaciones (6, ya ordenadas por `exitDate`)

| # | Entrada | Salida | PnL | Signo |
| --- | --- | --- | ---: | --- |
| 1 | 2024-01-01 | 2024-01-02 | +150 | W |
| 2 | 2024-01-02 | 2024-01-03 | -80 | L |
| 3 | 2024-01-03 | 2024-01-05 | +220 | W |
| 4 | 2024-01-05 | 2024-01-06 | -120 | L |
| 5 | 2024-01-06 | 2024-01-08 | -60 | L |
| 6 | 2024-01-08 | 2024-01-10 | +90 | W |

## Cálculo paso a paso

### Rentabilidad total y anualizada

- **Total:** `10297,9001109996 / 10000 - 1 = 0,0297900111` → **2,979 %**.
- **Anualizada** (252 días de mercado/año, `periodos = 9`):
  `(1,0297900111)^(252/9) - 1 = 1,0297900111^28 - 1 ≈ 1,2749030695` → **127,49 %**.

### Drawdown máximo

Máximo corriente y caída relativa en cada punto:

| Fecha | Máximo | Caída |
| --- | ---: | ---: |
| 01-02 | 10200 | 0 % |
| 01-03/04 | 10200 | 1 - 0,99 = 1 % |
| 01-05 | 10200 | 1 - 0,99·1,01 = 0,01 % |
| 01-06 | 10200 | 1 - 0,99·1,01·0,99 = 1 - 0,989901 = **1,0099 %** ← máximo |
| 01-07 | 10298,93 | nuevo máximo (recupera) |
| 01-08/09 | 10298,93 | 1 - 0,99 = 1 % |
| 01-10 | 10298,93 | 1 - 0,99·1,01 = 0,01 % |

- **`pct` = 0,010099** (exacto: `1 - 0,9801·1,01`).
- Episodio: máximo **01-02**, mínimo **01-06**, recuperación **01-07** → **duración 5 días** de calendario.

### Sharpe anualizado (rf = 0)

- Media: `Σr = 3 %`, `n = 9` → `m = 1/3 % ≈ 0,003333`.
- Varianza muestral: `Σr² = 13` (%²); `Σ(r-m)² = 13 - (3)²/9 = 12`; `s² = 12/8 = 1,5` (%²) → `s = √1,5 % ≈ 0,012247`.
- Sharpe = `(m/s)·√252 = (1/3)/√1,5 · √252 = √(56/3) ≈ 4,320494`.
- Con `riskFreeRate = 0,0252`: rf diaria = `0,0252/252 = 0,0001`; exceso medio = `0,0033333 - 0,0001 = 0,0032333` → Sharpe ≈ **4,190879**.

### Métricas de operaciones

- Beneficio bruto = 150 + 220 + 90 = **460**; pérdida bruta = 80 + 120 + 60 = **260**.
- **Factor de beneficio** = 460/260 = **23/13 ≈ 1,769231**.
- **Tasa de acierto** = 3/6 = **0,5**; **expectativa** = (460-260)/6 = 200/6 ≈ **33,3333**.
- Secuencia W L W L L W → **racha perdedora máxima = 2**; **nº de operaciones = 6**.

## Convenciones aplicadas

- Rendimientos diarios simples `eq_t / eq_{t-1} - 1`; si el capital previo no es positivo el rendimiento se omite (no está definido).
- Desviación típica muestral (divisor `n-1`); con menos de 2 rendimientos el Sharpe es `null`.
- Tasa libre de riesgo anual repartida linealmente (`rf/252` al día); 0 por defecto.
- Varianza efectivamente cero (desviación < 1e-12, ruido de coma flotante): Sharpe `+∞`/`-∞` según el signo del exceso medio, `null` si es 0.
- El drawdown es positivo en tanto por uno desde el máximo corriente; la duración cuenta días de calendario desde el máximo hasta la recuperación (o el final si no recupera).
- `pnl === 0` no es ganadora ni perdedora y corta la racha perdedora. Las rachas se evalúan ordenando las operaciones por `exitDate` (desempate `entryDate`).
- Sin operaciones: `profitFactor`, `winRate` y `expectancy` son `null` (indefinidos, no 0). Sin pérdidas con ganancias: `profitFactor = Infinity`, que `formatProfitFactor` muestra como «∞».

## Casos límite cubiertos por la prueba

- Curva vacía, curva de un punto, un solo rendimiento diario.
- Sin operaciones / solo operaciones ganadoras / solo operaciones a cero.
- Capital plano (Sharpe `null`), rendimiento constante positivo (`+∞`) y negativo (`-∞`).
- Drawdown que no llega a recuperarse (`recoveryDate = null`, duración hasta el último punto).
- Operaciones desordenadas de entrada: la racha usa el orden de `exitDate`.
- Entrada inválida: curva desordenada (`RangeError`), equity o pnl no finitos y fechas no parseables (`TypeError`).
