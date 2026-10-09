# Motor de riesgo con veto — reglas y valores

Ninguna señal ni orden sale sin pasar por la **pasarela única** (`risk:submit-signal`,
`src/main/risk/engine.ts`). El motor es independiente y de **solo lectura para la IA
y las estrategias**: no pueden importar sus escritores (`risk/repository`,
`risk/service`, `risk/killSwitch`; lo impone `no-restricted-imports` en
`eslint.config.mjs`) ni tocar límites, vetos ni la parada. Sus señales entran por la
pasarela y reciben una decisión.

## Orden de evaluación

```
parada de emergencia → reglas por operación → límites de cartera → cautela → decisión
```

La parada se comprueba dos veces: antes de evaluar y otra tras alimentar a sus
observadores con la instantánea real de la cartera — una pérdida anómala o un salto
de precio pueden dispararla en medio de la evaluación, y la señal en curso también
queda vetada. Cada motivo se persiste en `risk_vetoes` con el código, el mensaje
legible, los valores y la instantánea de la señal, y se emite `risk:vetoed`. Las
aprobadas no se registran.

## Reglas por operación (`tradeRules.ts`)

| Regla | Código | Condición de veto |
| --- | --- | --- |
| Stop obligatorio | `STOP_MISSING` | La señal no trae stop de protección. |
| Stop del lado correcto | `STOP_WRONG_SIDE` | En largo el stop va por debajo de la entrada; en corto, por encima. Al nivel de la entrada tampoco vale. |
| Beneficio/riesgo mínimo | `RR_TOO_LOW` | Ratio con signo orientado a la dirección por debajo del mínimo configurado (suelo duro 1:2). |
| Tamaño cero | `SIZE_ZERO` | `floor(capital × riesgo% / |entrada − stop|)` = 0. |
| Señal inválida | `SIGNAL_INVALID` | Precios no finitos/positivos o confianza fuera de 0–1. |

El tamaño sale de la distancia al stop: `tamaño = capital × riskPerTradePct / 100 / |entrada − stop|`,
redondeado hacia abajo a unidades enteras.

## Límites configurables, valores prudentes y márgenes duros

`risk:set-limits` valida en el proceso principal y rechaza con un error legible cada
valor fuera de su margen duro (`RISK_BOUNDS`); los `CHECK` de `risk_limits` los
vuelven a exigir en la base. Los valores por defecto son los de `RISK_DEFAULTS`.

| Límite | Defecto | Margen duro | Veto |
| --- | ---: | --- | --- |
| Riesgo por operación (%) | 0,5 | 0,5–2 | — |
| Ratio beneficio/riesgo mínimo | 2 | 2–10 | `RR_TOO_LOW` |
| Pérdida diaria (%) | 2 | 0,5–5 | `DAILY_LOSS` (≥) |
| Pérdida semanal (%) | 4 | 1–10 | `WEEKLY_LOSS` (≥) |
| Pérdida mensual (%) | 6 | 2–15 | `MONTHLY_LOSS` (≥) |
| Drawdown máximo (%) | 10 | 2–25 | `MAX_DRAWDOWN` (≥) |
| Posiciones abiertas | 5 | 1–10 | `MAX_POSITIONS` (≥) |
| Exposición por activo (%) | 20 | 5–40 | `ASSET_EXPOSURE` (>) |
| Exposición por sector (%) | 30 | 10–60 | `SECTOR_EXPOSURE` (>) |
| Exposición en divisas ≠ USD (%) | 25 | 5–50 | `CURRENCY_EXPOSURE` (>) |
| Correlación 60 días | 0,7 | 0,1–0,9 | `CORRELATION` (>) |
| Apalancamiento | 1× | fijo 1 | `LEVERAGE` (>) |
| Liquidez (% vol. medio 20 d) | 1 | 0,1–5 | `LIQUIDITY` (>; sin dato, veta) |

Convenciones (`portfolioLimits.ts`): pérdidas y drawdown vetan **al alcanzar** el
límite; exposiciones, correlación, apalancamiento y liquidez **al superarlo**. Las
exposiciones son brutas (un corto expone igual que un largo). La correlación es
Pearson a 60 días «alineada» por dirección; sin ≥ 10 muestras no veta. La liquidez
cierra en falso: volumen medio desconocido ⇒ veto.

## Parada de emergencia (`killSwitch.ts`)

| Causa | Disparador |
| --- | --- |
| `manual` | Botón «Parada» de la cabecera o de la bandeja. |
| `perdida-anomala` | Pérdida diaria ≥ 1,5 × límite, o drawdown ≥ límite. |
| `dato-anomalo` | `data-status:changed` en 'no-fiable', o salto de precio ≥ 20 %. |
| `sin-conexion` | 'offline' sostenido ≥ 60 s (sondeo cada 5 s). |
| `modelo-erratico` | > 20 señales/h, 5 inválidas seguidas o confianza fuera de 0–1. |

La pasarela alimenta los observadores con la instantánea real (pérdida diaria,
drawdown y última variación diaria por ticker). Activada, la parada pausa agentes,
repinta la bandeja, envía la notificación crítica a `#riesgo` y veta toda señal con
`KILL_SWITCH_ACTIVE` («Parada activa»). Solo se reanuda con `{confirm: true}`.

## Modo cautela (`caution.ts`)

| Causa | Efecto |
| --- | --- |
| `festivo` (sin sesión NYSE) | bloquea |
| `apertura` (primeros 15 min) | bloquea |
| `alto-impacto` (±30 min) | bloquea |
| `resultados` (activo en cartera, ese día) | bloquea ese activo |
| `vencimiento`, `sesion-corta` | reduce × 0,5 |
| `vix` > 30 | reduce × 0,5 |
| `vix` > 40 | bloquea |

`bloquear` ⇒ `vetada` con `CAUTION_MODE`; `reducir` ⇒ `reducida` con el factor
aplicado (también se registra en `risk_vetoes`). El contexto sale del calendario de
noticias (`calendar:list`), los tickers en cartera y el último `VIXCLS` de
`macro_observations`.

## Datos y cartera simulada

- `risk_limits`: límites efectivos (singleton); siembra `RISK_DEFAULTS` en la
  primera lectura.
- `risk_vetoes`: una fila por motivo de cada señal vetada o reducida.
- `risk_portfolio_positions` + `risk_equity_history`: cartera simulada y curva de
  capital; sin siembra, el capital de papel es `RISK_PAPER_EQUITY_DEFAULT` =
  **100 000** (misma cifra que el adaptador simulado del renderer).
- La instantánea toma de `bars` el precio de marca, el volumen medio de 20 días y
  los rendimientos diarios (ventana de correlación 60 d).

## IPC

`risk:get-limits` · `risk:set-limits` (rechaza fuera de margen con error legible) ·
`risk:list-vetoes` (`{rule?, decision?, ticker?, limit?, offset?}`, tope 500) ·
`risk:submit-signal` · `risk:get-caution` · `risk:get/activate/resume-kill-switch` ·
eventos `risk:changed` (`RiskOverview`) y `risk:vetoed` (`RiskVeto`).

Ganchos E2E (solo `TRADIA_E2E=1` sin empaquetar, como `simulateOffline`):
`risk:simulate-cause`, `risk:simulate-calendar-event` y `risk:seed-portfolio`
(siembra que **sustituye** la cartera simulada en una transacción).
