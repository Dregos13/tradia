# Laboratorio — de una idea a una prueba en vivo

El Laboratorio cierra el recorrido que da sentido a Tradia:

```
idea en lenguaje natural → reglas exactas (IA) → backtest → prueba en vivo con dinero ficticio → (más adelante) dinero real
```

## 1. Generar una estrategia con IA

- El usuario describe la idea como se la contaría a alguien.
- El proceso principal la envía a la **CLI de IA que ya tiene instalada**
  (la elegida en Ajustes → IA; si no está disponible, la primera que se
  encuentre entre Claude Code, Codex, Antigravity y Copilot). Usa el mismo
  modo seguro que el análisis de noticias: una sola pasada, sin
  herramientas, `cwd` neutro y la idea cercada como dato no fiable. No hay
  coste de API.
- El prompt (`src/main/lab/prompt.ts`) describe la gramática exacta del
  lenguaje de reglas (`src/shared/strategyRules.ts`) y el universo operable.
- La respuesta se normaliza y se valida con **el mismo analizador que
  usa el motor**. Si no compila, se reintenta pasando a la IA los errores
  exactos (hasta 3 intentos). Un borrador con reglas que el motor no pueda
  ejecutar nunca llega a la interfaz como válido.
- El usuario puede iterar («hazla más conservadora») sobre el borrador.

## 2. Probar con el histórico

«Probar con datos históricos» guarda la ficha (versión 1, estado
«investigación», con la idea original en la nota) y lanza el backtest
normal del motor. El veredicto muestra rentabilidad anual, diferencia
frente al SPY, peor caída y operaciones, y dice en claro si pierde frente
a comprar y mantener o si hay menos de 30 operaciones.

## 3. Prueba en vivo (forward test)

- Congela la **versión** vigente y fija la **fecha de inicio**: hoy si el
  mercado de Nueva York no ha cerrado, mañana si ya cerró (nunca se
  aprovecha un cierre ya visto).
- No guarda resultados: cada vez se **repite el motor de backtest** desde
  la fecha de inicio hasta la última vela, con `keepOpenAtEnd` para ver la
  cartera tal como está hoy (posiciones abiertas, resultado latente y
  órdenes para la próxima apertura). Como el motor no tiene look-ahead y
  las reglas están congeladas, el resultado es exactamente el que habría
  dado operar en paper cada cierre desde ese día.
- Se compara con el SPY comprado el mismo día y con lo que prometía el
  último backtest de la versión.
- Detener una prueba fija su resultado en esa fecha.
- Es independiente de la cartera simulada del motor de señales y de
  Alpaca: no envía órdenes a ningún sitio.

Tabla: `forward_tests` (migración 020). Canales IPC: `lab:engine`,
`lab:generate`, `forward:list|get|start|stop|remove`.

## Vista previa sin Electron

```bash
node scripts/preview-renderer.mjs
```

Sirve el renderer con el adaptador simulado en `http://127.0.0.1:5195/`
(IA simulada y velas deterministas; en la vista previa la prueba en vivo
arranca hace 60 días para que haya sesiones que ver).

## Límites conocidos

- Velas diarias: la prueba avanza una vez al día, al cierre. El intradía
  es el siguiente paso del plan.
- El universo de la IA es el inicial (25 acciones/ETF de EE. UU. y EUR/USD).
- El lenguaje de reglas no tiene MACD, bandas, volumen medio ni datos
  fundamentales; la IA lo sabe y lo anota en «Dónde puede fallar».
