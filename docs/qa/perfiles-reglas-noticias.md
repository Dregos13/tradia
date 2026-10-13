# QA con los perfiles de usuario · reglas propias y noticias sin API

_Claude · Predeterminado (Testing, sustituye a Codex) · 12-10-2026 · rama
`orquesta/completa-estas-partes-sin-hacer-y-compru-7d9830` sobre `951cc20c`.
No se ha cambiado código de `src` ni de `e2e`._

## Veredicto

| Perfil | Recorrido | Resultado |
| --- | --- | --- |
| A · Profesional independiente con varios proyectos | Dos propias en proyectos distintos, error en una regla, corrección, backtests comparados y sesión de Claude perdida a mitad del uso | **PASS** con 2 hallazgos bajos (P-1, P-2) |
| B · Responsable de equipo que revisa entregas | `docs/qa/estado-pendientes.md` frente al código, Ajustes sin API de pago y `docs/tareas-del-usuario.md` | **FAIL** (documental): los 14 puntos se sostienen en el fondo, pero el informe de estado tiene partes obsoletas y referencias desfasadas (P-3), y faltan tareas del usuario (P-4) |

**¿Algún punto de `docs/qa/estado-pendientes.md` no se sostiene?**
Ningún punto de la tabla es falso en el fondo: el código existe y las 185
regresiones de la tabla pasan. Pero, **tal como está escrito, el documento
no se sostiene en estas partes** (detalle en P-3):

- El «Veredicto» dice que el backtest y las señales de las propias, el
  aviso de la suscripción y la retirada de la API «siguen sin hacer», y que
  `docs/tareas-del-usuario.md:32` y `:71-76` documentan `--provider api`.
  Todo eso ya está hecho: el documento ya no menciona la API y
  `scripts/eval-news-llm.mjs:16-17` la da por retirada.
- La fila «Clave de `eval:news-llm`» mantiene el «matiz» de `--provider api`,
  que ya no existe.
- Los hallazgos E1 (`ml/README.md` con `.venv-ml`) y E2 (`ml/data/velas.csv`
  sin ignorar) siguen abiertos en §5, pero están **corregidos**:
  `ml/README.md:21-25` usa `~/.venvs/tradia-ml` y `.gitignore:12-13` ignora
  `ml/data/*`.
- Varias referencias archivo:línea de H1, H2, H3, H4, H5 y P4 apuntan a otro
  código tras los cambios del corto real y de noticias (tabla en P-3).

## Comandos

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | EXIT 0 |
| `npm run lint` | EXIT 0 |
| `npm run format:check` | EXIT 0 («All matched files use Prettier code style!») |
| `npm test` | EXIT 0 · **191 archivos, 2 698/2 698** |
| `npm run build` | EXIT 0 |
| Regresiones de la tabla de `estado-pendientes.md` (comando de su §1) | EXIT 0 · 9 archivos, **185/185** |
| `npx vitest run` de noticias, Ajustes, estrategias, `custom.test.ts` y `sin-api.audit.test.ts` | EXIT 0 · 14 archivos, 170/170 |
| `git ls-files .venv-ml \| wc -l` | **0** |
| `grep -rnE '\b(describe\|it\|test)\.(skip\|skipIf\|runIf\|only\|fails\|todo)\b\|\.fixme\(\|\bx(it\|describe)\(' src e2e` | Solo 2 líneas, y son **comentarios**: `reglas.audit.test.ts:27` y `sin-api.audit.test.ts:22` («declara `it.fails`…»). Ningún salto real |

`npm run test:e2e` completo no lo he lanzado: en la misma carpeta corre a la
vez la tarea de E2E (`docs/qa/e2e-reglas-noticias.md`), y dos baterías
Electron a la vez se pisan las capturas. En su lugar seguí los recorridos en
la app compilada con un perfil limpio y `TRADIA_E2E=1`, con un guion de
Playwright fuera del repositorio (`/tmp/qa-perfiles/perfil-a.mjs`). Es lo
mismo que `npm run dev` con perfil limpio, pero repetible.

## Sesión A · Profesional independiente que organiza varios proyectos

Contexto: lleva dos clientes. Para «Ruiz» quiere un cruce de medias en SPY.
Para «Pérez & Asociados», una reversión RSI en QQQ. Trabaja rápido, se
equivoca al escribir y a mitad de la tarde su sesión de Claude caduca.

| # | Paso | Esperado | Observado | Evidencia | Resultado |
| --- | --- | --- | --- | --- | --- |
| A0 | Estrategias › Nueva estrategia y pulsa «Crear» sin rellenar nada | No se crea ninguna ficha y se explica qué falta | «Crear estrategia» desactivado, con «Completa las cuatro reglas…» y «Completa también su salida.» | `docs/qa/capturas/perfiles-a0-formulario-vacio.png` | PASS |
| A1 | Crea «Alfa · Cruce SPY (cliente Ruiz)»: entrada `cruza_arriba(sma(rapida), sma(lenta))`, salida `cruza_abajo(…)`, stop `2%`, objetivo `6%`, `{"rapida":20,"lenta":50}` | Ficha creada con «Reglas listas para ejecutar» | Igual | `perfiles-a1-ficha-alfa.png` | PASS |
| A2 | Lanza el backtest desde la ficha (Monte Carlo 100) | Informe con operaciones y métricas | Informe #1: 25 operaciones, Sharpe 0,41 | `perfiles-a2-informe-alfa.png` | PASS |
| A3 | Vuelve a la ficha y ejecuta las pruebas de estrés | Crisis 2008, 2020 y 2022, más el informe en el historial | «Pruebas de estrés guardadas.», las tres crisis y «Informe #1» en el historial | `perfiles-a3-estres-alfa.png` | PASS |
| A4 | Crea «Beta · Reversión RSI en QQQ…» con la errata `rsi(periodo) < 30 y cierre > sma(lenta` | Error en vivo en el campo, con posición, y sin poder guardar | `aria-invalid="true"`, «falta «)» para cerrar «sma» · caracteres 30–32.» y «Crear» desactivado | `perfiles-a4-error-regla-beta.png` | PASS |
| A5 | Cierra el paréntesis y crea | Válida y creada | `aria-invalid="false"` y ficha creada. **El nombre (134 caracteres) se guarda cortado a 120 sin ningún aviso** (P-1) | `perfiles-a5-ficha-beta.png`; registro `NOMBRE escrito 134 en campo 120` | PASS (con P-1) |
| A6 | Backtest de Beta | Informe | Informe #2: 6 operaciones | `/tmp/qa-perfiles/run-a.log` | PASS |
| A7 | Compara los dos en la biblioteca | Métricas del último backtest de cada una, una al lado de la otra | Alfa: 7,5 %, DD 3,61 %, Sharpe 0,41, 25 op. Beta: 0,33 %, 2,16 %, 0,07, 6 op. Cuadran con los informes. Sin desbordamiento a 700 px. **A 1440 px, el nombre largo comprime la tabla y las cabeceras y celdas se parten a mitad de palabra** («Rentab/ilidad», «Shar/pe», «Sin dato/s») (P-2) | `perfiles-a7-biblioteca-comparacion.png`, `perfiles-a7-biblioteca-700.png` | PASS (con P-2) |
| A8 | Edita Alfa: escribe `sma(lentaa)` en la salida, lo corrige y guarda una nueva versión | Error que nombra el identificador, y luego la v2 | «`lentaa` no es un campo, un indicador ni un parámetro de la ficha · caracteres 30–35.» Después se guarda la v2 | `/tmp/qa-perfiles/perfil-a.json` | PASS |
| A9 | Ajustes › Análisis de noticias | Solo «Suscripción (Claude Code)» y «Analizador local», sin campo de clave de API | Dos radios y ningún campo de clave ni texto «API» o «Anthropic» | `perfiles-a9-ajustes-noticias.png` | PASS |
| A10 | Con la suscripción elegida y estando en la ficha de Beta, la sesión cae (`sin-sesion` por `ai:news-status-changed`) | La ficha no se interrumpe. Noticias y Ajustes muestran el motivo y el paso | La ficha sigue intacta y sin aviso intrusivo. Noticias: «Suscripción no disponible · sesión no iniciada · Abre un terminal, ejecuta claude y después /login… las noticias se analizan con el analizador local» con «Probar de nuevo». Ajustes muestra lo mismo | `perfiles-a10-noticias-sesion-caida.png`, `perfiles-a10-ajustes-sesion-caida.png` | PASS |
| A11 | Sin sesión, lanza otro backtest de Alfa v2 | Las estrategias no dependen de Claude | Informe #5 sobre la v2; el historial tiene la v1 y la v2 | `perfil-a.json` | PASS |
| A12 | Vuelve la sesión (`ok`) | El aviso desaparece solo | Desaparece | `perfil-a.json` | PASS |
| A13 | Notificación del sistema única al caer y otra al volver | 1 + 1 notificaciones, nunca una por titular | Cubierto en el proceso principal: `service.test.ts` «sin sesión … notifica UNA vez en 10 fallos», «la recuperación a ok notifica una vez más» y «en modo «sin sesión» … con una sola notificación» (CLI falsa real), todos ✓ | `npx vitest run src/main/ai/news/service.test.ts --reporter=verbose` | PASS |

Notas del recorrido:

- En A10 el cambio de estado se inyecta por el mismo canal IPC que usa
  `e2e/news-sentiment.spec.ts`. En modo `TRADIA_E2E` el proceso principal
  usa el analizador simulado (`src/main/ai/news/index.ts:126`), así que la
  caída real de la CLI no se puede provocar dentro de la app de pruebas. La
  ruta real (CLI falsa → `sin-sesion` → notificación) la cubre A13. Que
  llegue la notificación de macOS con un `/logout` de verdad solo lo puede
  comprobar el usuario.
- Equivalencia con la clásica: `custom.test.ts` «equivalencia con el cruce
  de medias clásico» (3 casos) y `backtest/service.test.ts` «el cruce de
  medias propio produce las mismas operaciones que la clásica sma-cross»: ✓.
- Observación sin hallazgo: la app no agrupa las estrategias por proyecto ni
  por cliente. Este usuario lo resuelve con el nombre («Alfa · … (cliente
  Ruiz)»), así que un nombre largo cortado en silencio (P-1) le afecta
  directamente.

## Sesión B · Responsable de equipo que revisa entregas

| # | Paso | Esperado | Observado | Evidencia | Resultado |
| --- | --- | --- | --- | --- | --- |
| B1 | Comprueba que `estado-pendientes.md` cubre cada punto del objetivo | Una fila con estado y evidencia para H1–H5, P1–P4, P7, `.venv-ml`, la clave de `eval:news-llm`, el aviso del backtest aplazado y el modo por orden | Las 14 filas están, todas «Hecho» | `docs/qa/estado-pendientes.md` §1 | PASS |
| B2 | Abre cada archivo:línea citado | La línea muestra el arreglo | P1, P2, P3, P7, el modo por orden y el aviso del backtest cuadran. **H1, H2, H3, H4, H5 y P4 apuntan a otro código** (tabla en P-3) | `sed -n` sobre cada referencia; P-3 | **FAIL** |
| B3 | Lanza las regresiones citadas | En verde | 9 archivos, 185/185. Todas las pruebas citadas existen (con otra línea) | Comando de §1 de `estado-pendientes.md` | PASS |
| B4 | Lee el Veredicto y los hallazgos E1/E2 | Estado actual de la rama | El texto dice que hay partes sin hacer y que la API sigue documentada, pero ya está todo hecho. E1 y E2 siguen abiertos aunque están corregidos | `estado-pendientes.md:8-20`, §5; `ml/README.md:21-25`; `.gitignore:12-13`; `git check-ignore -v ml/data/velas.csv` → `.gitignore:12:ml/data/*` | **FAIL** |
| B5 | Ajustes no ofrece la API de pago | Solo suscripción y local; la clave antigua se borra | Interfaz: A9. Código: `AiSettings.tsx:41` descarta el `llm` heredado; `news/service.ts` borra la clave del llavero al migrar. `sin-api.audit.test.ts` ✓ | `perfiles-a9-ajustes-noticias.png` | PASS |
| B6 | `tareas-del-usuario.md` sin pasos con la API de pago | Ninguno | Ningún paso. Solo `:74-76` explica que ya no hay API y que la clave se borra sola | `grep -niE 'api de pago\|anthropic\|--provider api' docs/tareas-del-usuario.md` | PASS |
| B7 | `tareas-del-usuario.md` es claro y completo frente a las comprobaciones que solo puede hacer el usuario | Cada comprobación manual con sus pasos | Claro y bien ordenado por riesgo. **Faltan**: el corto con dinero real en Alpaca, el `/logout` para probar el aviso, `claude.cmd` en Windows y actualizar `main` y lanzar la CI. Además, el botón se llama «Probar de nuevo», no «Probar» (P-4) | `docs/tareas-del-usuario.md` completo | **FAIL** |

## Hallazgos

### P-3 · Media · Documentación QA (backend): `docs/qa/estado-pendientes.md` está desfasado; su veredicto y varias evidencias ya no se sostienen

- **Pasos:**
  1. Abre `docs/qa/estado-pendientes.md`.
  2. Lee el Veredicto (líneas 8-20), la fila «Clave de `eval:news-llm`» y §5.
  3. Abre cada archivo:línea de la tabla.
- **Esperado:** el estado actual de la rama, con referencias que apunten al
  arreglo, porque es la evidencia que exige el criterio 4.
- **Observado:**
  - El veredicto dice que el backtest y las señales de las propias, el aviso
    de la suscripción y la retirada de la API «siguen sin hacer», y que
    `tareas-del-usuario.md:32` y `:71-76` documentan `--provider api`. Todo
    eso ya está hecho.
  - E1 y E2 siguen abiertos aunque están corregidos.
  - Las referencias desfasadas:

| Punto | Cita el informe | En la rama apunta a | Dónde está ahora |
| --- | --- | --- | --- |
| H1 | `live/service.ts:536` | Límites del corto | `live/service.ts:551` (`allowSeededEvidence`); pruebas `live.audit.test.ts:379` y `:630` (no `:370`/`:612`) |
| H2 | `orderGuard.ts:80`, `:120-124`, `:186-199` | Interfaz `LiveOrderSnapshot` y comentarios del corto | `orderGuard.ts:155` (`LIVE_ORDER_PRICE_MARGIN`) y `:215`; pruebas `live.audit.test.ts:554`, `:704` y `:721` |
| H3 | `ai.audit.test.ts:941` | — | `ai.audit.test.ts:926` |
| H4 | `news/service.ts:262-275` | Notificación de la suscripción | `news/service.ts:402-414` (filtro `linked`/`mentioned`); prueba `ai.audit.test.ts:301` |
| H5 | `ai.audit.test.ts:334` | — | `ai.audit.test.ts:319` (`repository.ts:138` sigue bien) |
| P4 | `ai.audit.test.ts:867` | — | `ai.audit.test.ts:852` |

- **Evidencia:** las salidas de `sed -n` de la sesión B. Por ejemplo,
  `sed -n 262,275p src/main/ai/news/service.ts` muestra `const notify = …`, no
  el filtro de tickers.

### P-4 · Media · Documentación (backend): `docs/tareas-del-usuario.md` no recoge todas las tareas del usuario

- **Pasos:** compara el documento con las comprobaciones que solo puede
  hacer el usuario y con lo que exige el corto con dinero real.
- **Esperado:** cada acción manual con sus pasos y el resultado esperado.
- **Observado:** faltan cuatro tareas y hay un rótulo que no coincide:
  1. **Corto con dinero real.** No dice que haga falta una cuenta de margen
     en Alpaca con préstamo habilitado (`shorting_enabled`), al menos
     2 000 USD y títulos prestables. Tampoco que los tres límites del corto
     vienen a 0 (desactivado) y hay que guardarlos y confirmarlos en Ajustes
     (≤100 USD por orden, ≤200 USD de exposición, 1 posición). Hoy solo lo
     explican `docs/reglas-estrategias.md` y `docs/dinero-real.md`.
  2. **Probar el aviso con `/logout`.** §1 describe el comportamiento
     (`:70-76`), pero no da el paso para comprobarlo.
  3. **Windows.** §4 no pide comprobar que `claude.cmd` responde sin
     `spawn EINVAL`.
  4. **Rama y CI.** No aparece «actualiza tu `main` con origin/main y lanza
     la CI de la PR desde la pestaña Git».
  5. **Rótulo del botón.** §1, paso 3, dice «pulsa «Probar»», pero el botón
     se llama «Probar de nuevo» incluso la primera vez
     (`AiSettings.tsx:257`).
- **Evidencia:** `grep -niE 'corto|margen|shorting|cmd|EINVAL|logout|origin/main' docs/tareas-del-usuario.md`
  no devuelve nada de esto.

### P-1 · Baja · Frontend: el nombre de la estrategia se corta a 120 caracteres sin aviso ni contador

- **Pasos:**
  1. Estrategias › Nueva estrategia.
  2. Escribe o pega un nombre de 134 caracteres.
  3. Crea la estrategia.
- **Esperado:** un contador «n/120» como en las reglas («38/500»), o un
  aviso al llegar al límite.
- **Observado:** el `textarea` tiene `maxLength={120}`
  (`StrategyForm.tsx:99`, `:200`) y el texto que sobra se pierde en
  silencio. La ficha se guarda con el nombre truncado a mitad de palabra
  («…recortarse bien en»).
- **Evidencia:** `perfiles-a5-ficha-beta.png`,
  `perfiles-a7-biblioteca-comparacion.png`; registro
  `NOMBRE escrito 134 en campo 120`.

### P-2 · Baja · Diseño o frontend: con un nombre largo, la tabla de la biblioteca parte las cabeceras y las cifras a mitad de palabra

- **Pasos:**
  1. Crea una estrategia con un nombre largo (A5).
  2. Abre la biblioteca a 1440 × 1000.
- **Esperado:** las columnas numéricas mantienen un ancho mínimo y cortan
  la palabra entera; la columna del nombre es la que se ajusta.
- **Observado:** «Rentab/ilidad», «Draw/down», «Shar/pe», «Opera/ciones»,
  «Actualizaci/ón» y «Sin dato/s» se parten en dos líneas.
- **Evidencia:** `perfiles-a7-biblioteca-comparacion.png`.

### Observación (sin hallazgo): sin notificación si la CLI ya falta al arrancar

Con «Suscripción (Claude Code)» guardada y sin `claude` localizable al
arrancar, el estado pasa a `cli-no-encontrada` y se ve en Noticias y en
Ajustes, pero **no se envía ninguna notificación**. Es una decisión
explícita del código («una CLI que nunca estuvo bien no cae»,
`news/service.ts:243-247`) y la cubre la prueba «…sin notificar en el
arranque». El criterio 3 dice «llega una sola notificación» si la CLI no se
encuentra. Lo dejo como pregunta al orquestador; no lo cuento como fallo.

## Correcciones de Frontend

_Ronda de correcciones de Frontend tras E2E y QA · 12-10-2026._ No quedaba ningún hallazgo de Frontend de gravedad alta o media abierto: P-1 y P-2 (bajas) ya los cerró «Contador del nombre y columnas estables en la biblioteca»; P-3 y P-4 eran de documentación. Esta ronda cierra los hallazgos de gravedad baja que seguían abiertos y la regla de foco con `waitFor`. Batería final: `typecheck`, `lint` y `format:check` en verde; `npm test` 192 archivos y 2.710/2.710; `npm run test:e2e` 54/54.

| Hallazgo | Origen | Gravedad | Estado | Corrección | Prueba de regresión |
| --- | --- | --- | --- | --- | --- |
| **F1** · la ficha no confirma el cambio de estado y el foco cae en `body` | `docs/qa/e2e-reglas-noticias.md` | Baja | **Corregido** | `StrategiesPage.tsx:123`: la relectura tras «Cambiar estado» es de fondo, así que «Cargando ficha…» ya no desmonta la ficha y se conserva «Estado actualizado» (`role="status"`). `StrategyDetail.tsx:252`: el foco vuelve al selector «Nuevo estado», porque el botón queda desactivado | `StrategiesPage.test.tsx:149` (con la relectura retenida: falla sin el arreglo); E2E `e2e/custom-strategy.spec.ts:127` (aviso visible y foco en el selector) |
| **P-1** · el nombre se corta a 120 caracteres sin aviso | Este informe | Baja | Corregido antes de esta ronda | Contador «n/120» y aviso en `StrategyForm.tsx` | `StrategyNameAndLibrary.test.tsx:28`, `:41` |
| **P-2** · la biblioteca parte cabeceras y cifras | Este informe | Baja | Corregido antes de esta ronda | Columnas con `nowrap` y ancho mínimo; nombre con elipsis y `title` | `StrategyNameAndLibrary.test.tsx:83`, `:102` |
| Prueba intermitente de `FirstStepsCard` bajo carga | Regresión con todos los perfiles | Baja | **Corregido** | La marca de «ocultar» se borra en un `useEffect` posterior al render: la comprobación espera con `waitFor` | `FirstStepsCard.test.tsx:143` |
| `daily-routine.spec.ts` falla según la hora local | Esta ronda (`npm run test:e2e` a las 23:37 CEST) | Baja | **Corregido** | Con el reloj adelantado 25 h por vuelta, el Diario puede tener más de una conciliación, y el localizador estricto chocaba con dos filas. Ahora comprueba que hay al menos una (`.first()`); la prueba sigue exigiendo los tres tipos de resumen y 3 notificaciones | `e2e/daily-routine.spec.ts:232` (fallaba 3 de 3 aislada; pasa 2 de 2 y en la batería completa) |
| Aserciones de foco síncronas | Lección de misiones anteriores | — | **Corregido** | Las 84 aserciones `toHaveFocus()` de `src/renderer` que no estaban dentro de `waitFor` lo están ahora (las que usaban `await findBy…` pasan a `getBy…` dentro del `waitFor`). `grep -rn "toHaveFocus()" src/renderer --include='*.test.tsx' \| grep -v waitFor` solo devuelve las que ocupan varias líneas, todas ya dentro de un `waitFor` | Toda la batería de `src/renderer` |

## Lo que no he podido comprobar en este entorno

- La notificación real de macOS tras un `/logout` en Claude Code: la sesión
  de pruebas no tiene CLI con sesión real y `TRADIA_E2E` usa el analizador
  simulado. Está cubierta por las pruebas unitarias con CLI falsa (A13).
- `npm run test:e2e` completo: lo ejecuta en paralelo la tarea de E2E (ver
  arriba).
- Lector de pantalla manual.
