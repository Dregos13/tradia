# IA predictiva (fase 6): régimen, predicción, noticias y salud

La fase 6 añade cuatro piezas de análisis sobre el proceso principal. Las
cuatro **informan y ajustan, nunca deciden solas**: ninguna crea una señal
ni una orden, y todo lo que aportan pasa igualmente por la pasarela única
de riesgo (`risk:submit-signal`, ver `docs/senales.md`).

| Pieza | Módulo | Canales IPC |
| --- | --- | --- |
| Régimen de mercado | `src/main/ai/regime/` | `ai:regime-overview`, `ai:simulate-regime`* |
| Predicción ONNX | `src/main/ai/prediction/` | `ai:predictions`, `ai:model-card` |
| Noticias con LLM | `src/main/ai/news/` | `ai:news-analysis`, `ai:get-llm-settings`, `ai:set-llm-settings`, `ai:test-llm` |
| Salud de modelos | `src/main/ai/drift/` | `ai:health`, `ai:retrain-proposals`, `ai:resolve-retrain`, `ai:simulate-drift`* |

\* Solo con `TRADIA_E2E` y la app sin empaquetar (`isE2eEnabled`); el
build de producción no los registra.

Todas se registran en `initServices` (`src/main/services/index.ts`) tras
sus dependencias (`market`, `poller`, `strategies`, `backtest`,
`journal`, `routine`…) y emiten `ai:changed` con su `kind`
(`regimen`, `prediccion`, `noticias`, `salud`) para que la interfaz
repinte.

## Régimen de mercado (`ai/regime`)

Clasifica cada sesión en dos ejes con etiqueta fija (`src/shared/ai.ts`),
siempre de forma **causal** (la sesión i solo usa velas ≤ i):

- **Dirección**: `tendencia` si ADX(14) > 25 con pendiente de la SMA50
  distinta de cero; si no, `lateral`.
- **Volatilidad**: `volatilidad-alta` si la volatilidad realizada de 20
  sesiones supera su mediana de las 252 observaciones anteriores; si no,
  `volatilidad-baja`.

Se calcula por activo de la lista de seguimiento y para el **mercado**,
cuya referencia es `SPY` (`REGIME_MARKET_TICKER`). Las series son las
velas guardadas ajustadas (una fuente por serie, mismo criterio que el
motor de señales) y hacen falta `REGIME_MIN_BARS` (51) velas antes de
persistir. Se recalcula con cada lote de velas (`market.onBarsStored`),
con cada cambio de la lista de seguimiento y una vez al arrancar.

**Habilitación de estrategias** (`enablement.ts`): cada ficha declara
`worksIn`/`failsIn` («funciona en» / «falla en»). `resolveStrategyRegime`
la resuelve contra el régimen del mercado —misma referencia en la página
«IA», el motor de señales y el backtest con filtro—: `degradada` tiene
prioridad; `desactivada` si una etiqueta vigente está en `failsIn` o
`worksIn` no está vacío y no contiene ninguna; `habilitada` en el resto.
Una estrategia desactivada **no vota** y el motivo queda en el Diario.

El backtest puede ejecutarse con el mismo filtro (`regimeFilter`) y la
ficha muestra la comparación pareada con/sin filtro (`backtest:*-regime-
comparison`); las ventas y los stops nunca se bloquean por régimen.

Gancho E2E: `ai:simulate-regime` fija dirección y volatilidad de un
activo o del mercado con datos falsos en memoria (no escribe series
reales).

## Predicción ONNX (`ai/prediction`)

El modelo se entrena **fuera de la app** (pipeline Python en `ml/`, ver
`ml/README.md` y `ml/FEATURES.md`) y se sirve en Node con
`onnxruntime-node`. La app nunca entrena: consume los artefactos de
`resources/models/<version>/` (`pipeline.json`, `model.onnx`, `vol.onnx`
con verificación SHA-256, y `model-card.json`), elegidos por
`resources/models/current.json` y copiados al paquete como
`extraResources` (el binario nativo viaja fuera del asar).

Con cada lote de velas el servicio calcula las 16 variables (espejo de
`src/shared/indicators.ts`), predice la **probabilidad calibrada de
subida a 5 sesiones** (`PREDICTION_HORIZON_DAYS`) y la volatilidad
esperada, y la guarda en `predictions` con versión y hash del modelo;
cuando llega la vela del horizonte la predicción se resuelve y anota su
Brier realizado. La ficha (`model_cards`) fija periodos de entrenamiento
y prueba, Brier fuera de muestra frente al de referencia y el diagrama
de calibración. Un modelo solo es **apto** para apoyar señales si su
origen es `real` y su Brier OOS mejora la referencia (`isModelEligible`);
`aiPrediction.eligibleModel()`/`modelCard()` releen la ficha para que la
marca de degradación surta efecto sin reiniciar. El estado del servicio
se publica como `modelo:<version>` en `data_status`, igual que cualquier
fuente de datos.

`parity.test.ts` verifica que el modelo servido en Node reproduce las
probabilidades del pipeline de entrenamiento (fixture exportada).

## Noticias con LLM (`ai/news`)

Cola FIFO alimentada por `poller.onItemsStored`: **solo entran titulares
confirmados** (descartados al encolar y releídos en disco antes de
analizar). Una noticia sin verificar nunca dispara una señal: solo
ajusta la confianza vía `news_analysis` y pasa por el motor de riesgo
como todo lo demás.

Analizador por titular, en este orden:

1. **Simulado determinista**: siempre en modo E2E (rotula `llm` para
   reproducir el método del diseño sin tocar la red).
2. **Anthropic** (`NEWS_LLM_MODEL`): solo con el interruptor activado,
   clave guardada y presupuesto mensual > 0; vigila además el tope
   diario y el gasto estimado (`ai:get-llm-settings` expone contadores y
   `hasKey`, jamás la clave). Cualquier fallo —cuota incluida— cae al
   analizador local con un aviso por clase de error.
3. **Léxico local**: sin coste ni clave, siempre disponible.

El resultado es una fila por activo en `news_analysis` (resumen +
sentimiento `positivo`/`negativo`/`neutro`/`mixto`, método y modelo).
`npm run eval:news-llm` mide precisión y coste del LLM real sobre el
conjunto etiquetado.

## Salud de modelos y reentrenamiento (`ai/drift`)

La revisión corre **tras la conciliación de la rutina diaria**
(`routine.onPostMarket`), con una pasada inicial al arrancar y otra
perezosa en `ai:health`; sin conexión queda en pausa. Se deduplica por
día de Nueva York (una `datos` y una `resultados` por día) y por mes y
estrategia (`rendimiento`). Umbrales del contrato (`src/shared/ai.ts`):

- **Drift de datos**: PSI de cada variable frente a los bins de
  referencia de la ficha; alerta si ≥ 2 variables superan 0,25 durante
  20 sesiones seguidas.
- **Drift de resultados**: Brier móvil de las últimas 60 predicciones
  resueltas que empeore la ficha en más de 0,02, misma persistencia.
- **Rendimiento de estrategia**: ≥ 30 operaciones con desviación > ±30
  pp frente a la expectativa del backtest en 2 revisiones mensuales
  seguidas. Una racha mala aislada queda en `observacion` y **nunca**
  degrada.

La degradación escribe la ficha (`strategies` → `degradada`, el modelo →
`apto = 0` con motivo), deja entrada en el Diario, envía notificación
crítica hacia «Salud de modelos» y propone un **reentrenamiento
trimestral** (`retrain_proposals`, máximo una por trimestre). Aprobarla
solo devuelve las instrucciones del pipeline `ml/` —la app nunca
reentrena sola—; posponerla exige una fecha futura. Un modelo degradado
sigue informando pero deja de apoyar señales.

Gancho E2E: `ai:simulate-drift` inyecta una racha sostenida de
`datos`/`resultados`/`rendimiento` y aplica la misma transición, para
probar la degradación sin esperar 20 sesiones.

## Cómo entra todo en las señales

Resumen (detalle en `docs/senales.md` §«Confianza combinada con la IA»):
el régimen del mercado habilita o silencia fichas antes de votar; el
modelo apto multiplica la confianza por `2·p_dirección` (probabilidad
< 0,5 = contradicción → «no operar»; modelo no apto no participa); el
sentimiento medio alineado de las noticias confirmadas ajusta ±0,15; y
con aportes de IA la confianza combinada exige ≥ 0,55. Todo queda en el
bloque `ai` de la señal (régimen, probabilidad, versión/hash y
`newsItemIds`).

## Ganchos E2E del dominio

| Gancho | Qué siembra/fija |
| --- | --- |
| `ai:simulate-regime` | Régimen de un activo o del mercado en memoria |
| `ai:simulate-drift` | Racha sostenida de drift con su degradación |
| `live:seed-progress` | Evidencia de los requisitos automáticos de la lista |
| `live:use-simulated-broker` | Adaptador live contra el servidor falso |
| `broker:seed-weeks` | Semanas de operaciones paper cerradas reales |
| Analizador de noticias simulado | Automático con `TRADIA_E2E` en `registerNewsAi` |

Todos se registran solo cuando `isE2eEnabled(app.isPackaged,
TRADIA_E2E)` es true —app sin empaquetar y `TRADIA_E2E=1`— y se exponen
en `window.tradia.testing`. El modo real y su lista se describen en
`docs/dinero-real.md`.
