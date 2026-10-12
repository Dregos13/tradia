# Lenguaje de reglas de las estrategias propias

Las estrategias que crea el usuario llevan sus reglas en los cuatro campos
de la ficha (`entry`, `exit`, `stop`, `target`). Desde esta misión esos
campos no son texto libre: se escriben en un **lenguaje pequeño en español
que se analiza, nunca se ejecuta como código** — no hay `eval`, `Function`
ni import dinámico en ninguna parte del analizador ni de la estrategia
compilada—.

- El analizador es `parseStrategyRules` de `src/shared/strategyRules.ts`:
  puro, sin dependencias de Node; lo usan el proceso principal, el
  preload y la validación en vivo del editor.
- Devuelve `{ ok: true, program }` o `{ ok: false, errors }`, donde cada
  error trae `field` (`entry` | `exit` | `stop` | `target`), `message` en
  español y `start`/`end` (índices de carácter en base 0 dentro del
  campo).
- `program` es un AST de datos puros (serializable). El motor lo ejecuta
  con `createCustomStrategy(program, parameters)` de
  `src/main/backtest/strategies/custom.ts`, que devuelve una `Strategy`
  del motor de backtest, igual de válida que las cuatro clásicas.

## Modelo de ejecución

Como las clásicas: **solo largo**, la regla se evalúa al **cierre** de la
vela y la orden se llena en la **apertura siguiente**. La `BarWindow`
garantiza que la regla nunca ve velas futuras. Un operando sin dato
(indicador en calentamiento, volumen ausente) hace falsa la comparación o
el cruce; nunca se inventa un valor.

## Entrada y salida (`entry`, `exit`)

Son **condiciones** (verdadero/falso):

- Comparaciones entre expresiones numéricas: `>`, `<`, `>=`, `<=`, `=`
  (`=` es igualdad exacta de coma flotante; suele convenir `>=` o `<=`).
- Lógica: `y` (y), `o` (o), `no` (negación). Prioridad: `no` > `y` > `o`.
- Paréntesis y aritmética `+`, `-`, `*`, `/` con signo unario.
- Números con punto o coma decimal: `12.5` y `12,5` valen lo mismo.
- Campos de la vela actual: `cierre`, `apertura`, `maximo`, `minimo`,
  `volumen`.
- Indicadores:
  - `sma(n)`, `ema(n)`, `rsi(n)`, `atr(n)`: sobre las últimas `n` velas
    **incluida la actual** (la misma semántica que los indicadores del
    núcleo y que las estrategias clásicas).
  - `maximo(n)`, `minimo(n)`: máximo y mínimo de las `n` velas
    **anteriores, sin la actual** — el canal de la propia vela no cuenta,
    igual que en la ruptura Donchian clásica. Así `cierre > maximo(20)`
    es una ruptura de verdad.
- Cruces estrictos (necesitan el valor de la vela anterior y el actual):
  - `cruza_arriba(a, b)`: `a <= b` en la vela anterior y `a > b` ahora.
  - `cruza_abajo(a, b)`: `a >= b` en la vela anterior y `a < b` ahora.
- Nombres de los parámetros de la ficha: `rapida`, `stopAtr`… Si el
  parámetro cambia en la ficha, la regla se vuelve a validar y a usar con
  el nuevo valor.

Las palabras del lenguaje no distinguen mayúsculas ni acentos
(`SMA(20)`, `máximo(20)`, `Y` valen). Un parámetro cuyo nombre choque con
una palabra del lenguaje (`cierre`, `sma`, `y`…) no se puede referenciar.

## Stop y objetivo (`stop`, `target`)

Aceptan exactamente tres formas:

| Forma | Significado |
| --- | --- |
| `ninguno` | Sin stop / sin objetivo. Una entrada sin stop se dimensiona por hueco y queda sin protección. |
| `N%` | Stop: fijo a un N % **bajo** el cierre de la señal (0 < N < 100). Objetivo: fijo a un N % **sobre** el cierre de la señal (N > 0). |
| `K * atr(n)` | Stop: **dinámico** — cada cierre se recalcula como `cierre − K × ATR(n)` y solo puede subir, nunca bajar (el stop del cruce de medias clásico). Objetivo: fijo a `cierre + K × ATR(n)` de la señal. |

`N` y `K` pueden ser números, nombres de parámetro o productos de ambos
(`5%`, `riesgo%`, `2,5 * atr(14)`, `stopAtr * atr(atrPeriod)`,
`targetR * stopAtr * atr(atrPeriod)`). El multiplicador debe ser > 0.

Si un nivel declarado no se puede calcular — ATR aún sin valor o
resultado no positivo —, **la entrada se descarta**: igual que las
clásicas, una compra sin protección calculable no se ejecuta.

## Límites

- 500 caracteres por campo.
- 32 niveles de anidación (paréntesis, `no` y signos encadenados).
- Los argumentos de periodo son enteros de 1 a 500 o nombres de
  parámetro (el valor del parámetro también debe ser un entero de 1 a
  500; se vuelve a comprobar al iniciar cada ejecución, porque la
  sensibilidad puede sobreescribir los parámetros de la ficha).

## Ejemplos

Cruce de medias equivalente a la clásica «sma-cross» (la prueba de
equivalencia comprueba que produce las mismas operaciones):

```text
entrada:  cruza_arriba(sma(rapida), sma(lenta))
salida:   cruza_abajo(sma(rapida), sma(lenta))
stop:     stopAtr * atr(atrPeriod)
objetivo: targetR * stopAtr * atr(atrPeriod)
```

Otros ejemplos válidos:

```text
entrada:  rsi(14) < 30 y cierre > sma(200)
salida:   rsi(14) > 70 o cruza_abajo(sma(rapida), sma(lenta))
stop:     5%
objetivo: ninguno
```

```text
entrada:  cierre > maximo(55) y volumen > sma(20) * 1,5
salida:   cierre < minimo(20)
stop:     2 * atr(20)
objetivo: ninguno
```

## Errores

Cada error indica el campo, el motivo y la posición `[start, end)` en
caracteres (base 0; la interfaz los muestra empezando en 1). El análisis
devuelve un error por campo, el primero encontrado. Casos cubiertos:
token o nombre desconocido, parámetro inexistente, periodo fuera de
rango, paréntesis o llamada sin cerrar, campo vacío, texto libre de
versiones anteriores, condición donde va un número (o al revés) y
niveles mal formados.
