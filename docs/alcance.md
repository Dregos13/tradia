# Alcance y decisiones — Tradia

Documento de decisiones derivado de la sección 1 («Objetivo y alcance») del
documento de referencia `.orquesta/context/Plan de la app con IA trader.html`.
Cada punto de esa sección tiene aquí una decisión explícita; la tabla final
permite cotejarlos uno a uno.

> Este documento es informativo. No es asesoramiento financiero ni jurídico y
> no sustituye la revisión de un profesional.

## 1. Mercado inicial

**Decisión: una sola clase de activo líquida — acciones y ETF de EE. UU.
(NYSE y Nasdaq) — con un universo inicial acotado a 25 tickers.**

Motivos: es el mercado con mayor liquidez y más datos disponibles, los datos
diarios son baratos o gratuitos y el horario de la sesión regular
(15:30–22:00, hora de Madrid) encaja con el ciclo de decisiones diario. El
pre y post mercado quedan fuera por su baja liquidez.

Universo inicial propuesto (lista revisable, no definitiva): 10 ETF de
índice y sector (`SPY`, `QQQ`, `DIA`, `IWM`, `VTI`, `XLF`, `XLK`, `XLE`,
`XLV`, `TLT`) y 15 acciones de gran capitalización y alta liquidez
(`AAPL`, `MSFT`, `NVDA`, `AMZN`, `GOOGL`, `META`, `JPM`, `XOM`, `JNJ`,
`PG`, `V`, `HD`, `KO`, `AVGO`, `AMD`). El universo se guarda en
configuración y solo se amplía cuando el sistema esté validado en paper
trading.

Quedan fuera de esta fase: forex, materias primas, bonos, criptomonedas,
opciones, futuros, CFD y acciones europeas. Se reevalúan en fases
posteriores.

## 2. Horizonte

**Decisión: swing trading (posiciones de días a semanas) con datos diarios
(OHLCV diarios) como temporalidad de decisión.**

Motivos: los datos diarios tienen nivel gratuito suficiente, no exigen
ejecución en tiempo real ni baja latencia (una app de escritorio doméstica
basta), el ruido estadístico es menor que en intradía y encaja con el ciclo
de «evaluar señales en el cierre de cada vela» de la sección 7 del plan. Las
temporalidades intradía y el horizonte posicional quedan para fases
posteriores.

## 3. Modo de uso por defecto

**Decisión: modo (a) + (b) — solo señales informativas y paper trading. La
ejecución automática con capital real (c) queda fuera del alcance.**

Desde la fase 5 la app sí se conecta a un broker, **pero solo a una cuenta
de paper trading** (Alpaca paper; ver `docs/broker.md`): las señales
aprobadas por el motor de riesgo se ejecutan con dinero simulado en la
cuenta paper del propio broker y la app concilia su registro con el del
broker. El dinero real sigue fuera del alcance: el adaptador tiene fijada
la URL `paper-api.alpaca.markets`, las claves de una cuenta live se
rechazan antes de guardarse y la app exige que se generen sin permiso de
retirada. Además convive la cartera simulada interna con su diario
automático, que sigue funcionando sin cuenta conectada. Pasar a ejecución
real requiere cumplir el criterio de la sección 4.4 y el checklist de la
sección 18 del plan, y será una decisión explícita en una fase posterior.

## 4. Objetivos medibles

Números escritos para poder evaluar el sistema de forma objetiva:

### 4.1 Drawdown máximo tolerable

**10 % del capital de la cartera (paper o real).** Si el drawdown supera el
10 % se activa el kill switch: se cierran decisiones nuevas y se notifica
al usuario. Es el límite duro del sistema, no una aspiración.

### 4.2 Rentabilidad esperada realista

**Objetivo orientativo: 8–15 % anual con drawdown ≤ 10 %, y batir al
benchmark (SPY) en la comparación continua.** Es una referencia de
evaluación, nunca una promesa: el aviso de riesgo recuerda que los
rendimientos pasados no garantizan los futuros. Si en paper trading el
resultado se desvía del backtest más de un ±30 % en las métricas clave, la
estrategia vuelve a «en investigación».

### 4.3 Número de operaciones

**Entre 2 y 10 operaciones al mes en conjunto, con un máximo de 5
posiciones simultáneas.** Riesgo por operación: 0,5–1 % del capital (por
debajo del rango 0,5–2 % del plan, porque se empieza con cautela). Ratio
beneficio/riesgo mínimo 1:2 y stop-loss obligatorio en cada operación.
Muestra mínima para evaluar una estrategia: **≥ 30 operaciones** en paper
trading.

### 4.4 Criterio para pasar de paper a real

Todos cumplidos, con aprobación explícita del usuario:

1. ≥ 3 meses de paper trading continuo y ≥ 30 operaciones registradas.
2. Resultado real dentro de un ±30 % del backtest en rentabilidad,
   drawdown y tasa de acierto.
3. Motor de riesgo independiente probado y kill switch verificado.
4. Checklist de la sección 18 del plan completado (alertas, registros,
   claves sin permiso de retirada, plan de contingencia, revisión legal y
   fiscal, capital inicial pequeño con límites escritos).

Hasta entonces, la app no ejecuta: solo señala y simula.

## 5. Principio rector

**Primero proteger el capital, después buscar rentabilidad.**

Consecuencias directas: el motor de riesgo es una capa independiente con
poder de veto que la IA no puede modificar ni saltarse; ante estrategias
contradictorias o confianza baja la decisión es no operar; y sin conexión a
internet las decisiones quedan en pausa automáticamente.

## 6. Presupuesto mensual de APIs

**Decisión: 0 €/mes en esta fase.** Con swing y datos diarios, el nivel
gratuito de los proveedores candidatos cubre el universo de 25 tickers.
Techo autorizado si un proveedor gratuito se queda corto: **30 €/mes**,
previa aprobación del usuario.

Los precios, límites y condiciones cambian: todo lo de la tabla está
marcado como **verificar** antes de integrarse.

### Proveedores de precios (datos diarios EE. UU.)

| Proveedor | Nivel | Límites orientativos | Nota |
| --- | --- | --- | --- |
| Stooq | Gratuito | CSV diario, sin clave; límites no publicados | verificar |
| Yahoo Finance (no oficial) | Gratuito | Sin garantía ni SLA | solo apoyo/desarrollo; verificar términos |
| Alpha Vantage | Gratuito / pago | ~25 peticiones/día gratis; desde ~50 $/mes | verificar |
| Twelve Data | Gratuito / pago | ~800 peticiones/día y 8/min gratis; desde ~29 $/mes | verificar |
| Tiingo | Gratuito / pago | Límites por símbolo y peticiones/hora; desde ~10 $/mes | verificar |
| Polygon.io | Gratuito / pago | ~5 req/min con retraso gratis; desde ~29 $/mes | verificar |
| Finnhub | Gratuito / pago | ~60 req/min gratis; de pago desde ~50 $/mes | verificar |
| Alpaca | Gratuito con cuenta | Datos de mercado con cuenta (sin operar) | verificar términos de datos |

### Proveedores de noticias y macro

| Proveedor | Nivel | Límites orientativos | Nota |
| --- | --- | --- | --- |
| Fuentes oficiales (SEC EDGAR, Fed, BLS) | Gratuito | APIs y RSS públicos | máxima fiabilidad; verificar |
| GDELT | Gratuito | Uso público | verificar condiciones |
| Finnhub (noticias) | Gratuito / pago | Dentro del límite de llamadas | verificar |
| Alpha Vantage (noticias con sentimiento) | Gratuito / pago | Dentro del límite diario | verificar |
| NewsAPI | Gratuito solo desarrollo / pago | ~100 req/día en dev; producción desde ~449 $/mes | caro; verificar |
| Benzinga | Pago | Según plan | verificar |
| FRED (macro) | Gratuito | Requiere clave de API | verificar |
| RSS de prensa (Expansión, Cinco Días, CNBC, etc.) | Gratuito | Solo titulares | verificar términos de cada feed |

Regla de calidad (del plan, sección 5.4): una noticia solo de redes
sociales nunca dispara una operación por sí sola; debe confirmarse con una
fuente oficial o de agencia.

## 7. Avisos legales

### 7.1 CNMV y MiFID II

Tradia es una herramienta de **uso personal**. No ofrece asesoramiento
financiero ni recomendaciones personalizadas a terceros, no gestiona
carteras ajenas y no ejecuta órdenes en esta fase. Dar recomendaciones
personalizadas o gestionar capital de terceros podría requerir
autorización de la **CNMV** y cumplir **MiFID II**: si la app se abre al
público o a terceros, habrá que consultar a un abogado especializado antes.
Al añadir ejecución real se usarán solo brokers regulados (CNMV o
autoridades europeas con pasaporte) comprobando su registro.

### 7.2 RGPD

Todos los datos son **locales**: SQLite en el equipo del usuario, sin
cuentas ni servidor propio. **Sin telemetría ni analítica por defecto.**
Las claves de API se guardan cifradas con `safeStorage` del sistema
operativo, nunca en texto plano. Si en el futuro se añade sincronización o
telemetría, será opt-in con consentimiento informado y base jurídica
clara.

### 7.3 Licencias de datos

Los datos de mercado y las noticias se usan para **uso personal, sin
redistribución**: la app no reenvía, revende ni publica datos de
proveedores. Cada proveedor integrado debe respetarse en sus términos
(p. ej., algunos prohíben mostrar sus datos a terceros o exigen
atribución). Fuentes no oficiales (Yahoo Finance) se usan solo como apoyo
en desarrollo, no como fuente de producción.

### 7.4 Aviso de riesgo (texto para la pantalla del primer arranque)

Texto vigente, versión `1.0`. La app lo muestra antes del primer uso y lo
mantiene accesible en Ajustes > Legal; si la versión cambia, se vuelve a
pedir la aceptación:

> Tradia es una herramienta informativa de uso personal. No es
> asesoramiento financiero ni gestión de carteras (CNMV, MiFID II).
> Los rendimientos pasados no garantizan rendimientos futuros.
> El modo por defecto genera señales informativas y paper trading
> simulado; no opera con dinero real. La mayoría de los traders
> minoristas pierden dinero y los sistemas automáticos también pueden
> perderlo. No arriesgues capital que no puedas permitirte perder.

Nota fiscal: las ganancias y pérdidas patrimoniales tributan en el IRPF en
España y puede haber obligaciones informativas por activos en el
extranjero. Confirmar con un asesor fiscal antes de operar en real.

## 8. Fuera de alcance en esta fase

- Ejecución automática con capital real y conexión a un broker.
- Trading intradía, pre y post mercado.
- Otros mercados (forex, cripto, materias primas, bonos, Europa).
- Telemetría, cuentas de usuario y sincronización en la nube.

## 9. Cotejo con la sección 1 del plan

| Punto de la sección 1 | Decisión |
| --- | --- |
| Mercado inicial | Acciones y ETF de EE. UU. (NYSE/Nasdaq); universo acotado de 25 tickers (10 ETF + 15 acciones); un solo mercado líquido (§1) |
| Horizonte | Swing, días a semanas, con datos diarios como temporalidad de decisión (§2) |
| Modo de uso | (a) señales informativas + (b) paper trading por defecto; (c) ejecución real fuera de esta fase (§3) |
| Objetivos medibles | Drawdown máx. 10 %; objetivo 8–15 % anual batiendo SPY; 2–10 operaciones/mes y máx. 5 posiciones; 0,5–1 % por operación; ≥30 operaciones y ≥3 meses de paper con desviación ≤ ±30 % del backtest para pasar a real (§4) |
| Principio rector | Primero proteger el capital, después buscar rentabilidad; riesgo con veto, no operar ante duda, pausa sin conexión (§5) |
| Presupuesto de APIs | 0 €/mes en esta fase con techo de 30 €/mes; tabla de proveedores de precios, noticias y macro, todo «verificar» (§6) |
| Avisos legales | Uso personal: ni asesoramiento ni gestión (CNMV/MiFID II); datos locales y sin telemetría por defecto (RGPD); uso personal sin redistribución (licencias); aviso de riesgo v1.0 fijado (§7) |
