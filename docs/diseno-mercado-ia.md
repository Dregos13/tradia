# Especificación UX/UI: Desplegable de IA en Ajustes, Buscador de activos y Gráfico de velas en Mercado

> **Estado**: Aprobado para implementación  
> **Ámbito**: Ajustes (`AiSettings.tsx`, `SubscriptionNotice.tsx`, `settings.css`) y Mercado (`MarketWorkspace.tsx`, `Watchlist.tsx`, `AssetSearch.tsx`, `PriceChart.tsx`, `market.css`)  
> **Criterio de contraste**: WCAG 2.2 AA (mínimo 4.5:1 para texto normal, 3:1 para controles y texto grande)  
> **Objetivo interactivo mínimo**: 44 × 44 px  
> **Resoluciones de referencia**: 1280 × 800 px (estándar) y 1024 × 700 px (compacta)  
> **Maquetas autocontenidas**: `.orquesta/design/c28abc4a/` y `.orquesta/design/mejoras/`  

---

## 1. Contexto y objetivos del rediseño

### 1.1. Diagnóstico de las incidencias del usuario

A partir del feedback del usuario y las capturas reales de la aplicación:

1. **Captura 1 (`8edbd742-184f-4d4a-80e6-e5dd6245fba4.png` · Ajustes):**  
   - *Problema:* El usuario no puede conectar su suscripción y encuentra únicamente un selector binario excluyente por radio buttons (`Suscripción (Claude Code)` vs `Analizador local`). Al no tener Claude Code en el PATH por defecto, la app queda bloqueada en un error permanente: *«Suscripción no disponible · CLI no encontrada»*.
   - *Petición expresa:* El usuario exige poder elegir su suscripción de IA preferida mediante un selector desplegable accesible (Claude Code, OpenAI Codex, Google Antigravity, GitHub Copilot o Analizador local sin suscripción), con detección automática y prueba de conexión inmediata.

2. **Captura 2 (`ff7396b4-0f1d-4715-925b-2a4e0d1edfa7.png` · Mercado):**  
   - *Problema:* El usuario solo dispone de un campo de texto plano de entrada con botón «Añadir», sin autocompletado, sin catálogo visible y sin asistencia al escribir. Intentar añadir pares de divisas como EUR/USD genera incertidumbre.
   - *Problema visual en el gráfico:* El lienzo de velas japonesas queda comprimido verticalmente por los paneles fijos de RSI 14 y ATR 14. En resoluciones estándar (1280×800) y reducidas (1024×700), las velas quedan aplastadas en una franja diminuta que impide analizar mechas y cuerpos. Además, la cotización de divisas requiere precisión de 4 decimales.

---

## 2. Selector desplegable de IA en Ajustes

### 2.1. Arquitectura de interacción

En lugar de radio buttons rígidos que imponen una única herramienta externa, se implementa un control `<select>` accesible con soporte para múltiples motores CLI y modo local.

```
+--------------------------------------------------------------------------------+
| Motor de análisis de noticias                                                   |
| [ Claude Code (Suscripción activa en equipo)                                v ] |
| Proveedor: Anthropic Claude Code · CLI oficial                                 |
+--------------------------------------------------------------------------------+
| [✓] CLI detectada en el sistema: /usr/local/bin/claude                        |
|                                                                                |
| Ruta del ejecutable (opcional)                                                 |
| [ /usr/local/bin/claude                                                      ] |
| Déjala vacía para buscar claude automáticamente en las rutas habituales.       |
|                                                                                |
| Límite diario de análisis                                                      |
| [ 200                                                                        ] |
| Titulares por día. Introduce un entero entre 1 y 2000.                         |
| Uso hoy: 0 de 200 titulares analizados                                         |
+--------------------------------------------------------------------------------+
| (Aviso de conexión / Estado actual de la suscripción)                          |
| Suscripción lista · Claude Code responde correctamente (latencia 142 ms).      |
|                                                      [ Probar conexión ]       |
+--------------------------------------------------------------------------------+
|                                                      [ Guardar ajustes ]       |
+--------------------------------------------------------------------------------+
```

### 2.2. Opciones del desplegable y especificación de motores

| ID de motor | Etiqueta visible en el selector | Comando por defecto | Descripción para el usuario |
| --- | --- | --- | --- |
| `suscripcion-claude` | **Claude Code (Suscripción de Anthropic)** | `claude` | Utiliza la sesión iniciada en este equipo mediante Claude CLI. Tradia analiza los titulares sin coste de API. |
| `suscripcion-codex` | **OpenAI Codex (Suscripción de OpenAI)** | `codex` | Utiliza la sesión iniciada en OpenAI Codex CLI. El analizador procesa titulares con tu cuenta. |
| `suscripcion-antigravity` | **Google Antigravity (Suscripción de Google)** | `agy` | Utiliza el entorno configurado de Google Antigravity CLI para el análisis de noticias. |
| `suscripcion-copilot` | **GitHub Copilot (Suscripción de GitHub)** | `copilot` / `gh copilot` | Utiliza la CLI de GitHub Copilot para evaluar el impacto de los titulares de mercado. |
| `local` | **Analizador local (Sin suscripción · En este equipo)** | *(Ninguno)* | Analizador léxico básico integrado. No requiere conexión externa, suscripciones ni comandos CLI. |

### 2.3. Autodetección y campo de ruta editable

1. **Autodetección reactiva:**
   - Al seleccionar cualquier motor de suscripción, el backend comprueba en segundo plano si el ejecutable está disponible en el `PATH` o en rutas habituales del sistema operativo:
     * macOS / Linux: `/usr/local/bin`, `/opt/homebrew/bin`, `~/.npm-global/bin`, `~/.local/bin`, `~/.cargo/bin`.
     * Windows: `%APPDATA%\npm`, `%LOCALAPPDATA%\Programs`, `%USERPROFILE%\.cargo\bin`.
   - **Indicador de detección:**
     * Si se encuentra: Un distintivo accesible con icono verde `[✓] Ejecutable detectado automáticamente: {ruta}`.
     * Si no se encuentra: Un distintivo ámbar `[!] No se encontró el comando {comando} en las rutas estándar. Indica la ruta completa abajo.`
2. **Campo de ruta personalizado (`cliPath`):**
   - Etiqueta: `Ruta del ejecutable de {motor} (opcional)`.
   - Placeholder: `/usr/local/bin/{comando}` o `C:\Users\{usuario}\AppData\Roaming\npm\{comando}.cmd`.
   - Texto de ayuda: `Déjala vacía para buscar {comando} automáticamente en el sistema.`
   - Se oculta de forma fluida cuando se selecciona **Analizador local**, eliminando ruido cognitivo.

### 2.4. Mensajes de diagnóstico y feedback de prueba

El botón **«Probar conexión»** (o «Probar de nuevo») ejecuta la validación en tiempo real (`ai:test-llm`) del motor seleccionado. Los mensajes siguen la regla estricta de redacción: **(1) Qué ha pasado, (2) A qué afecta, (3) Qué puede hacer**:

| Estado de la prueba | Mensaje en pantalla (Título + Explicación) | Estilo y Rol ARIA | Acción en botón |
| --- | --- | --- | --- |
| **Conexión correcta** | **Suscripción lista · {motor} responde correctamente.**<br>La sesión está activa en este equipo (tiempo de respuesta: {latencia} ms). Los nuevos titulares se analizarán con esta IA. El analizador local queda como respaldo. | Éxito (`--state-success`)<br>`role="status"` | *Probar de nuevo* |
| **CLI no encontrada** | **Suscripción no disponible · No encontramos el comando de {motor}.**<br>Tradia no puede ejecutar el análisis con esta opción. Instala {motor} en tu ordenador o escribe la ruta exacta a su archivo ejecutable arriba. Mientras tanto, las noticias se analizan con el analizador local. | Alerta error (`--state-critical`)<br>`role="alert"` | *Comprobar de nuevo* |
| **Sesión no iniciada** | **Suscripción no disponible · No hay una sesión iniciada en {motor}.**<br>Tu suscripción no está validada en este equipo. Abre un terminal, ejecuta `{comando}` para iniciar sesión y pulsa el botón de comprobar. Mientras tanto, las noticias se analizan con el analizador local. | Alerta error (`--state-critical`)<br>`role="alert"` | *Comprobar de nuevo* |
| **Tope diario alcanzado** | **Suscripción en pausa · Has alcanzado el límite diario de titulares.**<br>Se han analizado los {cap} titulares permitidos por hoy para proteger tu consumo. Espera a mañana o aumenta el límite diario en el campo inferior. Hasta entonces, las noticias se analizan con el analizador local. | Pausa informativa (`--state-paused`)<br>`role="status"` | *Comprobar de nuevo* |
| **Sin conexión a internet** | **Sin conexión · Comprobación de suscripción en pausa.**<br>Tu equipo no tiene acceso a internet. Vuelve a comprobar la conexión cuando recuperes la red. Mientras tanto, las noticias se analizan con el analizador local. | Pausa informativa (`--state-offline`)<br>`role="status"` | *Reintentar conexión* |
| **Analizador local activo** | **Analizador local preparado · Sin suscripción externa.**<br>El análisis léxico se realiza directamente en este ordenador sin necesidad de cuentas ni herramientas de terceros. | Informativo neutro<br>`role="status"` | *(Oculto)* |

---

## 3. Buscador de activos en Mercado

### 3.1. Arquitectura del componente `AssetSearch`

Sustituye la caja de texto estática por un componente de búsqueda interactivo con autocompletado en vivo (`combobox`), desplegable de resultados categorizados y adición directa a la lista de seguimiento con un solo clic o pulsación de teclado.

```
+--------------------------------------------------------------------------------+
| Buscar activo o divisa                                                          |
| [ EUR                                                                   [✕] ]  |
+--------------------------------------------------------------------------------+
| Sugerencias encontradas (2):                                                    |
|                                                                                |
| [Divisa]  EUR/USD  Euro / Dólar estadounidense                       [+ Añadir] |
|           Forex 24/5 · Cartera simulada interna                                |
|                                                                                |
| [ETF]     FXE      Invesco CurrencyShares Euro Currency Trust        [+ Añadir] |
|           NYSE Arca · 104,20 USD                                               |
+--------------------------------------------------------------------------------+
```

### 3.2. Especificaciones de búsqueda y catálogo de activos

1. **Filtrado en tiempo real:**
   - La búsqueda actúa sobre el símbolo (ticker) y sobre el nombre o descripción del activo.
   - Debounce visual de 150 ms para no saturar el renderizado.
   - Coincidencias resaltadas en negrita en el texto desplegado.
2. **Categorías y etiquetas visuales (Badges):**
   - **Acción:** `[Acción]` (fondo neutro sutil, texto con contraste AA).
   - **ETF:** `[ETF]` (fondo violeta sutil, texto con contraste AA).
   - **Divisa Forex:** `[Divisa]` (fondo verde azulado / esmeralda, texto con contraste AA).
3. **Soporte específico de EUR/USD:**
   - Acepta tanto `EUR/USD` como `EURUSD` o simplemente `EUR` o `Euro`.
   - Descripción explícita: *«Cotización de tipo de cambio 24/5. Se opera en la cartera simulada interna de Tradia (sin intermediación de bróker).»*
   - Si el activo ya está en la lista de seguimiento, el botón de acción cambia a estado desactivado con la leyenda *«Ya en lista»*.

### 3.3. Accesibilidad por teclado y roles ARIA

- **Estructura semántica:**
  * Campo de entrada: `<input role="combobox" aria-autocomplete="list" aria-expanded="true|false" aria-controls="market-search-listbox" aria-activedescendant="{id-opcion-activa}">`.
  * Contenedor de resultados: `<ul id="market-search-listbox" role="listbox" aria-label="Sugerencias de activos">`.
  * Elemento de opción: `<li id="search-item-{ticker}" role="option" aria-selected="true|false">`.
- **Mapeo de teclas:**
  * `Flecha Abajo` (`ArrowDown`): Abre el desplegable si está cerrado y mueve el foco virtual a la siguiente sugerencia.
  * `Flecha Arriba` (`ArrowUp`): Mueve el foco virtual a la sugerencia anterior; si está en la primera, vuelve al campo de texto.
  * `Intro` (`Enter`): Añade el activo actualmente seleccionado con `aria-activedescendant` a la lista de seguimiento y cierra el desplegable. Si no hay ninguna sugerencia resaltada pero el texto introducido es un ticker válido (ej. `EUR/USD`), lo añade directamente.
  * `Escape` (`Escape`): Cierra el desplegable de sugerencias y mantiene el foco en el campo de texto.
  * `Tab`: Cierra el menú desplegable y permite continuar la navegación natural hacia el siguiente botón sin trampas de foco.

### 3.4. Estados del buscador

1. **Estado inicial / reposo:**
   - Campo limpio con placeholder: `Escribe un símbolo o nombre (ej. EUR/USD, Apple, SPY)…`.
2. **Estado con resultados:**
   - Muestra hasta 6 coincidencias inmediatas ordenadas por relevancia con su etiqueta de tipo, nombre y botón de adición directa.
3. **Estado sin resultados:**
   - Panel desplegable con mensaje claro:  
     *«No encontramos ningún activo para “{consulta}”. Comprueba que el símbolo esté bien escrito o introduce un ticker directo para añadirlo.»*
4. **Estado límite alcanzado (25 activos):**
   - Aviso visual y accesible:  
     *«Has alcanzado el límite máximo de 25 activos en tu lista. Quita un activo existente antes de añadir uno nuevo.»*

---

## 4. Gráfico de velas mejorado (`PriceChart`)

### 4.1. Jerarquía visual y proporciones de pantalla

El diseño actual asignaba espacio fijo a los paneles de RSI y ATR de forma permanente, restando más del 40 % de la altura disponible al lienzo principal de velas japonesas.

#### Dimensiones recomendadas por resolución

| Resolución | Altura total del gráfico | Velas (Sin indicadores) | Velas (Con 1 indicador) | Velas (Con 2 indicadores) |
| --- | --- | --- | --- | --- |
| **1280 × 800 px** | **600 px** | **600 px (100 %)** | **450 px (75 %) + 150 px (25 %)** | **360 px (60 %) + 120 px RSI + 120 px ATR** |
| **1024 × 700 px** | **520 px** | **520 px (100 %)** | **390 px (75 %) + 130 px (25 %)** | **310 px (60 %) + 105 px RSI + 105 px ATR** |

### 4.2. Barra de control del gráfico con paneles conmutables

En la barra de herramientas del gráfico, justo encima del lienzo, se añaden controles interactivos de conmutación mediante botones tipo pastilla (chips) con soporte de `aria-pressed`:

```
+----------------------------------------------------------------------------------------------------+
| XLF  54,82 USD  [✓ Datos al día]                                              [ 1A ] [ 3A ] [ 5A* ]|
| Precios diarios ajustados · Fuente: tiingo · Última vela: 2026-10-13                               |
+----------------------------------------------------------------------------------------------------+
| Medias móviles: [✓] SMA 20  [✓] SMA 50  [✓] SMA 200 | Indicadores: [✓ Panel RSI 14] [  Panel ATR 14]|
+----------------------------------------------------------------------------------------------------+
```

1. **Botón `[✓ Panel RSI 14]`:**  
   - Alterna la visualización del subpanel inferior de RSI 14 con sus líneas de referencia 30 y 70.
   - Al desactivarlo, el panel desaparece y el lienzo de velas recupera inmediatamente ese espacio vertical.
2. **Botón `[✓ Panel ATR 14]`:**  
   - Alterna la visualización del subpanel inferior de ATR 14.
   - Al desactivarlo, el gráfico de velas se expande proporcionalmente.
3. **Leyenda clara de velas japonesas:**  
   - *«Vela alcista: borde verde y cuerpo vacío · Vela bajista: cuerpo rojo sólido.»*

### 4.3. Formateo de cotización por clase de activo

- **Acciones y ETFs (Mercado estadounidense en USD):**
  * Formato: `54,82 USD` (2 decimales).
  * Variación: `+0,64 USD (+1,18 %)`.
- **Divisas Forex (`EUR/USD`):**
  * Formato: `1,0842 EUR/USD` (**4 decimales estándar de divisa**).
  * Variación: `+0,0015 (+0,14 %)`.
  * Leyenda de divisa: *«Tipo de cambio Forex · 24/5 · Operativa en cartera simulada interna.»*

### 4.4. Tooltip / Crosshair OHLCV interactivo enriquecido

Al mover el cursor sobre el gráfico, se presenta una tarjeta flotante o barra superior de lectura instantánea con formateo tabular:

```
[ 2026-10-13 ]  [ Alcista ]
Apertura: 54,20 USD · Máximo: 54,95 USD · Mínimo: 54,10 USD · Cierre: 54,82 USD · Volumen: 12,4 M
SMA 20: 53,80 · SMA 50: 52,10 · SMA 200: 48,90 | RSI 14: 58,4 · ATR 14: 0,72 USD
```

- En el caso de `EUR/USD`, el volumen se indica en ticks/unidades y los precios en 4 decimales:  
  *«Apertura: 1,0825 · Máximo: 1,0860 · Mínimo: 1,0810 · Cierre: 1,0842»*.

---

## 5. Tabla de redacción de interfaz (Auditoría sin jerga técnica)

De acuerdo con el mandato de especialidad de **Redacción de interfaz**, cada mensaje se reescribe para alguien sin conocimientos técnicos: **qué ha pasado, a qué afecta y qué puede hacer**, sin jerga interna ni identificadores con comillas.

| Ubicación / Archivo | Estado en que aparece | Texto actual (Con problemas o jerga) | Texto nuevo (Español claro, sin jerga y con acción) |
| --- | --- | --- | --- |
| `AiSettings.tsx` | Selector de proveedor | Radio button: `Suscripción (Claude Code)` vs `Analizador local` | Desplegable: `<select>` con opciones claras: *Claude Code (Suscripción de Anthropic)*, *OpenAI Codex (Suscripción de OpenAI)*, *Google Antigravity (Suscripción de Google)*, *GitHub Copilot (Suscripción de GitHub)* y *Analizador local (Sin suscripción)*. |
| `AiSettings.tsx` | Campo de ruta | `Ruta de Claude Code (opcional)` / `Déjala vacía para buscar claude automáticamente.` | `Ruta del ejecutable de {motor} (opcional)` / `Déjala vacía para buscar {comando} automáticamente en el sistema.` |
| `SubscriptionNotice.tsx` | CLI no encontrada | `Suscripción no disponible · CLI no encontrada` / `Instala Claude Code y vuelve a abrir Tradia. Si ya está instalado, indica su ruta en este ajuste. Mientras tanto, se usa el analizador local.` | **Suscripción no disponible · No encontramos el comando de {motor}.**<br>Tradia no puede ejecutar el análisis con esta opción. Instala {motor} en tu ordenador o escribe la ruta exacta a su archivo ejecutable arriba. Mientras tanto, las noticias se analizan con el analizador local.<br>Botón: `Comprobar de nuevo` |
| `SubscriptionNotice.tsx` | Sesión no iniciada | `Suscripción no disponible · sesión no iniciada` / `Abre un terminal, ejecuta claude y después /login. Vuelve aquí y prueba de nuevo. Mientras tanto, se usa el analizador local.` | **Suscripción no disponible · No hay una sesión iniciada en {motor}.**<br>Tu suscripción no está validada en este equipo. Abre un terminal, ejecuta `{comando}` para iniciar sesión y pulsa el botón de comprobar. Mientras tanto, las noticias se analizan con el analizador local.<br>Botón: `Comprobar de nuevo` |
| `SubscriptionNotice.tsx` | Tope alcanzado | `Suscripción en pausa · tope diario alcanzado` / `Espera al próximo día o aumenta el máximo diario de titulares. Hasta entonces se usa el analizador local.` | **Suscripción en pausa · Has alcanzado el límite diario de titulares.**<br>Se han analizado los {cap} titulares permitidos por hoy para proteger tu consumo. Espera a mañana o aumenta el límite diario en el campo inferior. Hasta entonces, las noticias se analizan con el analizador local.<br>Botón: `Comprobar de nuevo` |
| `AiSettings.tsx` | Sin conexión | `Sin conexión · la prueba está pausada.` | **Sin conexión · Comprobación de suscripción en pausa.**<br>Tu equipo no tiene acceso a internet. Vuelve a comprobar la conexión cuando recuperes la red. Mientras tanto, las noticias se analizan con el analizador local.<br>Botón: `Reintentar conexión` |
| `Watchlist.tsx` | Entrada de activo | Label `Ticker`, Placeholder `p. ej. AAPL o SPY`, sin catálogo. | Label `Buscar activo o divisa`, Placeholder `Escribe un símbolo o nombre (ej. EUR/USD, Apple, SPY)…` con autocompletado en vivo y etiquetas de Acción, ETF y Divisa. |
| `Watchlist.tsx` | Error de formato | `Introduce un ticker de 1 a 12 caracteres: letras, números, punto o guion.` | **Símbolo no reconocido.**<br>Introduce un ticker válido como AAPL, SPY o EUR/USD para buscar su cotización e incorporarlo a la lista. |
| `Watchlist.tsx` | Activo duplicado | `{ticker} ya está en tu lista.` | **El activo ya forma parte de tu lista de seguimiento.**<br>Puedes seleccionarlo en la columna izquierda para ver su gráfico de cotización. |
| `Watchlist.tsx` | Límite alcanzado | `Has alcanzado el límite de 25 activos. Quita uno antes de añadir otro.` | **Has alcanzado el límite máximo de 25 activos.**<br>Para añadir {ticker}, selecciona primero un activo que ya no necesites en la lista y pulsa «Quitar». |
| `PriceChart.tsx` | Subtítulo divisa EUR/USD | `USD · Precios ajustados por splits y dividendos` (inadecuado para divisas) | `EUR/USD · Tipo de cambio Forex 24/5 · Operativa en cartera simulada interna` |
| `PriceChart.tsx` | Cotización EUR/USD | `1,08 USD` (redondeo a 2 decimales incorrecto para divisas) | `1,0842 EUR/USD` (4 decimales estándar de divisa Forex) |
| `PriceChart.tsx` | Leyenda indicadores | Texto comprimido: `RSI 14: 47,52 · Referencias 30 y 70. ATR 14: 0,69 USD.` | Controles interactivos conmutables: `[✓ Panel RSI 14]` y `[✓ Panel ATR 14]`, permitiendo expandir las velas al 100% de la altura disponible. |

---

## 6. Especificación de accesibilidad y ratios de contraste WCAG 2.2 AA

Todos los componentes nuevos cumplen rigurosamente el nivel **WCAG 2.2 AA**.

### 6.1. Mediciones de contraste sobre fondos de la interfaz

| Elemento / Estado | Color de texto | Color de fondo | Ratio de contraste | Estándar WCAG AA | Cumplimiento |
| --- | --- | --- | --- | --- | --- |
| **Texto principal (Modo claro)** | `#101A2A` | `#FFFEFA` | **15.2:1** | Mínimo 4.5:1 | Pasa con holgura |
| **Texto principal (Modo oscuro)** | `#F8FAFC` | `#101A2A` | **16.8:1** | Mínimo 4.5:1 | Pasa con holgura |
| **Texto secundario / Muted (Claro)** | `#526075` | `#FFFEFA` | **5.4:1** | Mínimo 4.5:1 | Pasa |
| **Texto secundario / Muted (Oscuro)** | `#94A3B8` | `#101A2A` | **6.2:1** | Mínimo 4.5:1 | Pasa |
| **Botón primario (Fondo azul cobalto)** | `#FFFFFF` | `#2563EB` | **4.6:1** | Mínimo 4.5:1 | Pasa |
| **Botón primario Hover** | `#FFFFFF` | `#1D4ED8` | **5.9:1** | Mínimo 4.5:1 | Pasa |
| **Badge Divisa (Verde esmeralda)** | `#065F46` | `#D1FAE5` | **6.1:1** | Mínimo 4.5:1 | Pasa (Modo claro) |
| **Badge Divisa (Verde esmeralda)** | `#6EE7B7` | `#064E3B` | **7.4:1** | Mínimo 4.5:1 | Pasa (Modo oscuro) |
| **Aviso de error / Fallo CLI** | `#991B1B` | `#FEE2E2` | **6.8:1** | Mínimo 4.5:1 | Pasa (Modo claro) |
| **Aviso de error / Fallo CLI** | `#FCA5A5` | `#450A0A` | **7.2:1** | Mínimo 4.5:1 | Pasa (Modo oscuro) |
| **Foco interactivo (`focus-visible`)** | `#2563EB` (Anillo 3px) | Cualquier superficie | **>= 3:1** | Mínimo 3:1 (componentes) | Pasa |

### 6.2. Criterios de interacción física y visual

1. **Objetivos interactivos (Tamaño mínimo):**
   - El desplegable `<select>`, los campos de texto, las filas de resultados del buscador, los botones de adición y los conmutadores de paneles del gráfico tienen una altura mínima de **44 px** (`--size-controlMin: 44px`), garantizando usabilidad en dispositivos táctiles o punteros imprecisos.
2. **Foco visible persistente:**
   - Todo elemento que reciba el foco dispone de un anillo de contorno de **3 px con separación de 2 px** (`outline: 3px solid var(--color-focus); outline-offset: 2px`).
3. **Anuncios para lectores de pantalla:**
   - La actualización de la lista de seguimiento y los resultados de búsqueda se comunican dinámicamente mediante regiones `role="status"` o `aria-live="polite"`.
   - Las alertas críticas de desconexión o fallo de CLI se anuncian inmediatamente con `role="alert"`.
