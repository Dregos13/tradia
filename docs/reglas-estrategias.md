# Lenguaje de reglas de las estrategias propias

Las estrategias que crea el usuario llevan sus reglas en los campos de la
ficha (`entry`, `exit`, `stop`, `target` y, opcionales, `entryShort` y
`exitShort`). Desde esta misión esos campos no son texto libre: se
escriben en un **lenguaje pequeño en español que se analiza, nunca se
ejecuta como código** — no hay `eval`, `Function` ni import dinámico en
ninguna parte del analizador ni de la estrategia compilada—.

- El analizador es `parseStrategyRules` de `src/shared/strategyRules.ts`:
  puro, sin dependencias de Node; lo usan el proceso principal, el
  preload y la validación en vivo del editor.
- Devuelve `{ ok: true, program }` o `{ ok: false, errors }`, donde cada
  error trae `field` (`entry` | `exit` | `entryShort` | `exitShort` |
  `stop` | `target`), `message` en español y `start`/`end` (índices de
  carácter en base 0 dentro del campo).
- `program` es un AST de datos puros (serializable). El motor lo ejecuta
  con `createCustomStrategy(program, parameters)` de
  `src/main/backtest/strategies/custom.ts`, que devuelve una `Strategy`
  del motor de backtest, igual de válida que las cuatro clásicas.
- `strategySide(rules)` del mismo módulo dice si la ficha opera en
  `'largo'`, `'corto'` o `'ambos'` según los campos escritos.

## Modelo de ejecución

Como las clásicas: la regla se evalúa al **cierre** de la vela y la orden
se llena en la **apertura siguiente**. La `BarWindow` garantiza que la
regla nunca ve velas futuras. Un operando sin dato (indicador en
calentamiento, volumen ausente) hace falsa la comparación o el cruce;
nunca se inventa un valor.

### Largo y corto

Las cuatro reglas del largo son obligatorias. `entryShort`/`exitShort`
son **opcionales y van en pareja**:

- Las dos vacías o ausentes → la estrategia opera **solo en largo** (las
  fichas guardadas antes de esta ampliación siguen siendo válidas tal
  cual, sin migración).
- Las dos escritas → la estrategia opera **en ambos** lados: una entrada
  en corto es una venta que se llena en la apertura siguiente **por
  debajo** del precio (los costes van siempre en contra), y la salida es
  una recompra. El P&L va invertido: gana cuando el precio baja.
- Escrita solo una de las dos → error de análisis en el campo que falta.

Reglas de la posición en corto (idénticas al largo, espejadas):

- **Nunca hay largo y corto a la vez en el mismo activo** ni cambio de
  lado: con una posición abierta solo se evalúa su salida, y si las
  entradas de largo y de corto se cumplen en la misma vela **no se
  entra**. Sin piramidación.
- El mismo campo `stop`/`target` de la ficha se aplica al corto al revés:
  el stop queda **por encima** de la entrada (lo toca el `maximo` de la
  vela) y el objetivo **por debajo** (lo toca el `minimo`). Si la misma
  vela toca los dos, gana el stop, igual que en largo. El stop dinámico
  `K * atr(n)` del corto solo puede bajar, nunca subir.
- El tamaño se calcula por la misma distancia de riesgo (`stop − entrada`)
  y el nominal del corto cuenta para la exposición de la cartera.
- En el paper trading la venta en corto llega como señal de lado
  `'corto'` y su cierre como `'largo'`, igual que las clásicas. **Con
  dinero real las entradas en corto siguen bloqueadas** por
  `src/main/live/orderGuard.ts` hasta la tarea del corto real.

## Entrada y salida (`entry`, `exit`, `entryShort`, `exitShort`)

Son **condiciones** (verdadero/falso), con la misma gramática en los
cuatro campos:

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
| `N%` | Stop: fijo a un N % **bajo** el cierre de la señal (0 < N < 100) — en corto, un N % **sobre** el cierre de la señal. Objetivo: un N % **sobre** el cierre de la señal (N > 0) — en corto, un N % **bajo**. |
| `K * atr(n)` | Stop: **dinámico** — en largo se recalcula cada cierre como `cierre − K × ATR(n)` y solo puede subir; en corto como `cierre + K × ATR(n)` y solo puede bajar (el stop del cruce de medias clásico, espejado). Objetivo: fijo a `cierre + K × ATR(n)` de la señal en largo, a `cierre − K × ATR(n)` en corto. |

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

La misma idea en corto (cruce de medias a la baja):

```text
entrada:         cruza_arriba(sma(rapida), sma(lenta))
salida:          cruza_abajo(sma(rapida), sma(lenta))
entrada en corto: cruza_abajo(sma(rapida), sma(lenta))
salida en corto:  cruza_arriba(sma(rapida), sma(lenta))
stop:         stopAtr * atr(atrPeriod)
objetivo:     targetR * stopAtr * atr(atrPeriod)
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
rango, paréntesis o llamada sin cerrar, campo vacío, pareja de corto a
medias (`entryShort` escrita sin `exitShort` o al revés), texto libre de
versiones anteriores, condición donde va un número (o al revés) y
niveles mal formados.
