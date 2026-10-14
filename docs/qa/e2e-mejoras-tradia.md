# E2E · Desplegable de IA, buscador de Mercado y gráfico de velas con EUR/USD

**Fecha**: 2026-10-14
**Responsable**: Testing · Pruebas de extremo a extremo (Devin · Sonnet)
**Spec**: [`e2e/mejoras-mercado-ajustes.spec.ts`](../../e2e/mejoras-mercado-ajustes.spec.ts)
**Comando de verificación**: `npm run test:e2e -- e2e/mejoras-mercado-ajustes.spec.ts && npm run format:check`

## Resumen

Se ha recorrido con Playwright, sobre la app Electron real (sin mocks de
UI), los tres flujos de la misión: el desplegable de motor de IA en
Ajustes (con autodetección real de una CLI falsa y sin ella), el
buscador accesible de activos en Mercado con EUR/USD, y el gráfico de
velas con sus paneles conmutables y rangos. Las seis pruebas pasan en
verde de forma repetida (3 ejecuciones consecutivas sin fallos
intermitentes). No se ha usado `test.skip`, `test.fixme` ni
`console.log` en el spec.

```
npx playwright --version   → Version 1.63.0
npm run build               → OK (typecheck + electron-vite build)
npx playwright test e2e/mejoras-mercado-ajustes.spec.ts
  6 passed (11.4s–11.5s, 3 ejecuciones)
npm run format:check        → OK
npm run lint                → OK
```

## Decisión técnica relevante: PATH/HOME aislados

El equipo de desarrollo donde se ejecutó esta batería **tiene instaladas
de verdad** las CLI de Claude Code, Codex y Copilot (en
`~/.nvm/versions/node/<versión>/bin`, la misma carpeta que aloja el
propio `node`). Una primera versión del spec que solo variaba `PATH`
seguía detectando `claude` porque la autodetección también explora
`$HOME` (`~/.local/bin`, `~/.npm-global/bin`, cada versión de
`~/.nvm/versions/node/*/bin`, Homebrew…), documentado en
`src/main/ai/news/cliEngines.ts`. La versión final:

- Aísla `node` en un directorio propio (symlink) para que el PATH
  mínimo no arrastre el resto de CLI globales instaladas junto a él.
- Lanza la app con un `HOME`/`USERPROFILE` recién creados y vacíos para
  los escenarios «sin CLI instalada», y con una CLI falsa (un proceso
  Node de verdad, lanzado por `spawn`, no un mock de IPC) instalada en
  su propio `PATH` para el escenario «con CLI instalada».

Esto hace la batería determinista en cualquier equipo, tenga o no
instaladas las CLI reales.

## Sesión 1 — Profesional independiente que organiza varios proyectos

**Perfil**: alguien que configura Tradia por primera vez y prueba su
IA preferida y sus activos de un vistazo.

### Caso 1.1 — El desplegable de Ajustes ofrece las cinco opciones y actualiza textos y campos

- Pasos: abrir Ajustes → Análisis de noticias; leer las opciones del
  `<select id="news-provider-select">`; comprobar el motor autodetectado
  sin CLI (`Analizador local`); cambiar a Codex, luego a Antigravity,
  luego de vuelta a local.
- Esperado: las cinco opciones (`Claude Code`, `OpenAI Codex`, `Google
  Antigravity`, `GitHub Copilot`, `Analizador local`) con sus textos
  explicativos y el campo de ruta condicional (`Ruta de {motor}
  (opcional)`) que aparece y desaparece según el motor.
- Observado: correcto. Con un perfil nuevo sin ninguna CLI real
  localizable, el motor autodetectado es `Analizador local`, tal y como
  especifica `docs/diseno-mercado-ia.md` (sección 2.3) y confirma el
  mensaje «Autodetectar el primer CLI instalado» de las decisiones del
  usuario.
- Evidencia: `docs/qa/capturas/ajustes-ia-desplegable-local.png`,
  `docs/qa/capturas/ajustes-ia-desplegable-codex.png`.
- Resultado: **passed**.

### Caso 1.2 — «Probar de nuevo» sin la CLI instalada explica qué pasó y qué hacer

- Pasos: seleccionar `Claude Code` sin tener el comando `claude`
  localizable; pulsar «Probar de nuevo».
- Esperado: mensaje de error accesible (`role="alert"`) con «CLI no
  encontrada» y el aviso de suscripción (`role="status"`) explicando la
  situación.
- Observado: el badge de autodetección marca correctamente «No se
  encontró el comando claude en las rutas estándar»; el botón «Probar
  de nuevo» dispara `ai:test-llm` y el formulario muestra «CLI no
  encontrada.» en un `role="alert"`. El aviso de abajo (`Estado de la
  suscripción`) sí aparece, pero con el texto genérico heredado
  («Suscripción no disponible · CLI no encontrada / Instala Claude
  Code y vuelve a abrir Tradia…») en vez del texto parametrizado por
  motor que especifica `docs/diseno-mercado-ia.md` (sección 2.4 y la
  tabla de redacción de la sección 5): **ver hallazgo TRAD-E2E-1**.
- Evidencia: `docs/qa/capturas/ajustes-ia-cli-no-encontrada.png`.
- Resultado: **passed** (la función corrige el problema original del
  usuario; el texto es una incidencia de redacción, no un bloqueo).

### Caso 1.3 — Mercado: el buscador encuentra EUR/USD y Apple, y los añade con un clic o el teclado

- Pasos: abrir Mercado con la lista vacía; escribir «EUR» en el
  buscador, pulsar «+ Añadir» sobre la sugerencia `EUR/USD`; esperar a
  que terminen las velas simuladas; comprobar el gráfico; escribir
  «Apple», navegar con `ArrowDown` hasta `AAPL` (comprobado por
  `aria-activedescendant`) y confirmar con `Enter`.
- Esperado: EUR/USD se añade con un clic, aparece con el distintivo
  «Divisa», su gráfico muestra «EUR/USD» y «Divisa Forex 24/5»; AAPL se
  añade por teclado sin tocar el ratón; ambos activos conviven en la
  lista sin bloquearse entre sí.
- Observado: correcto en todos los puntos.
- Nota de accesibilidad real detectada: si el puntero del ratón queda
  posicionado sobre la primera sugerencia del desplegable (algo
  plausible tras un clic anterior), su `onMouseEnter` resalta esa
  opción antes de pulsar ninguna tecla; la primera `ArrowDown` del
  usuario avanza entonces a la **segunda** sugerencia en vez de a la
  primera. El spec lo neutraliza apartando el puntero (`page.mouse.move(0,
  0)`) antes de teclear, pero es una fricción real de teclado + ratón
  combinados: **ver hallazgo TRAD-E2E-2**.
- Evidencia: `docs/qa/capturas/mercado-buscador-eurusd-anadido.png`.
- Resultado: **passed**.

### Caso 1.4 — Buscar un símbolo inexistente no rompe el buscador

- Pasos: escribir una frase con espacios que no es un ticker válido ni
  coincide con ningún activo del catálogo.
- Esperado: mensaje «No encontramos ningún activo para…» con sugerencia
  de revisar el símbolo o añadir un ticker directo.
- Observado: correcto; al vaciar el campo el listbox de sugerencias
  desaparece sin dejar el desplegable abierto ni residuos en pantalla.
- Resultado: **passed**.

## Sesión 2 — Responsable de equipo que revisa entregas

**Perfil**: alguien que entra a auditar que la suscripción de IA de
verdad se puede conectar y que el gráfico de Mercado aguanta las
resoluciones habituales del equipo sin romperse.

### Caso 2.1 — Una CLI instalada se autodetecta y «Probar de nuevo» confirma la sesión

- Pasos: instalar una CLI de Claude Code real (un proceso Node con
  shebang, no un mock) en un `PATH` controlado; abrir Ajustes.
- Esperado: el desplegable ya trae seleccionado `Claude Code` sin que
  el usuario tenga que elegir nada, el badge marca el ejecutable
  detectado con su ruta, y «Probar de nuevo» confirma una sesión activa
  con latencia.
- Observado: correcto en los tres puntos. Esto demuestra, con una CLI
  real del sistema operativo (no una llamada IPC simulada), que el
  problema original del usuario queda resuelto: puede elegir y conectar
  la suscripción que tenga instalada desde el desplegable, y la app la
  detecta sola.
- Evidencia: `docs/qa/capturas/ajustes-ia-cli-detectada.png`,
  `docs/qa/capturas/ajustes-ia-conexion-correcta.png`.
- Resultado: **passed**.

### Caso 2.2 — El gráfico de velas de EUR/USD alterna RSI/ATR, cambia de rango y no desborda a 1280×800 ni 1024×700

- Pasos: añadir EUR/USD, esperar las velas; comprobar la cotización a 4
  decimales; alternar los paneles «Panel RSI 14» y «Panel ATR 14» uno a
  uno y verificar que el nombre accesible del lienzo (`aria-label`) dice
  de qué paneles dispone en cada momento; cambiar el rango temporal
  (`1A`/`3A`/`5A`); leer la barra OHLCV; medir `scrollWidth` vs
  `clientWidth` de la tarjeta del gráfico y de todo el área de trabajo a
  1280×800 y, tras reducir la ventana, a 1024×700.
- Esperado: cotización `1,0842 EUR/USD` (4 decimales), paneles
  conmutables sin desbordamiento, rango activo marcado con
  `aria-pressed`, tooltip con Apertura/Máximo/Mínimo/Cierre.
- Observado: correcto en todos los puntos; `scrollWidth - clientWidth`
  ≤ 1 px en ambas resoluciones, tanto en la tarjeta del gráfico como en
  el área de trabajo completa de Mercado.
- Evidencia: `docs/qa/capturas/mercado-grafico-eurusd-1280x800.png`,
  `docs/qa/capturas/mercado-grafico-sin-paneles-1280.png`,
  `docs/qa/capturas/mercado-grafico-eurusd-1024x700.png`.
- Resultado: **passed**.

## Hallazgos

| ID | Severidad | Rol | Resumen |
| --- | --- | --- | --- |
| TRAD-E2E-1 | low | frontend | `SubscriptionNotice` usa el texto genérico heredado («Instala Claude Code…») para cualquier motor, en vez del texto parametrizado por `{motor}` de `docs/diseno-mercado-ia.md` (secciones 2.4 y 5: `NEWS_SUBSCRIPTION_COPY` en `src/shared/newsSubscription.ts` no recibe el motor activo). Con Codex, Antigravity o Copilot seleccionados, el aviso de abajo sigue mencionando «Claude Code» e indica ejecutar `claude` en el terminal, lo cual confunde a quien usa otro motor. |
| TRAD-E2E-2 | low | frontend | En el buscador de Mercado (`AssetSearch.tsx`), si el puntero del ratón queda sobre la primera sugerencia del desplegable (algo habitual tras añadir un activo con clic y teclear la siguiente búsqueda sin mover el ratón), el `onMouseEnter` resalta esa opción antes de cualquier tecla. La primera `ArrowDown` del usuario entonces se mueve a la segunda sugerencia en vez de aterrizar en la primera, lo que puede llevar a añadir por error un activo distinto al esperado con teclado + ratón combinados. |

Ambos hallazgos son de severidad baja: no bloquean los flujos de la
misión (el usuario ya puede elegir y conectar su IA, y ya puede
buscar y añadir EUR/USD), pero conviene que la ronda de correcciones
los recoja para que la redacción y la navegación por teclado sean
coherentes en todos los motores y con el ratón quieto en cualquier
posición.

## Verificación final de este entregable

```
npm run test:e2e -- e2e/mejoras-mercado-ajustes.spec.ts   → 6 passed (11.4s)
npm run format:check                                       → OK
npm run lint                                                → OK (0 problemas)
```

El spec no usa `test.skip`, `test.fixme` ni `console.log`, no escribe
en `e2e/` ningún fichero auxiliar de exploración (los directorios
temporales de prueba viven bajo `os.tmpdir()` y se borran en `finally`
tras cada test, siguiendo el mismo patrón que `e2e/electron.spec.ts` y
`e2e/phase-6-7.helpers.ts`), y cierra siempre la app (`closePhaseApp`
en `test.afterEach`) incluso si un test falla.
