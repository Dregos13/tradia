# Regresión con los dos perfiles sobre los fallos cerrados

_Claude · Predeterminado (Testing, sustituye a Copilot) · 13-10-2026 · rama
`orquesta/completa-estas-partes-sin-hacer-y-compru-7d9830` sobre `d12b7734`.
No se ha cambiado código de `src` ni de `e2e`._

## Veredicto

**No hay hallazgos.** Los dos fallos que abrieron estos perfiles están
cerrados en la app abierta y en las pruebas, y no ha vuelto nada de lo
anterior.

| Perfil | Fallo que abrió | Estado | Resultado del recorrido |
| --- | --- | --- | --- |
| A · Profesional independiente que organiza varios proyectos | O2 · la ayuda no avisaba de que con «Sin objetivo» Riesgo veta la compra | **Cerrado** | PASS (8/8 pasos) |
| B · Responsable de equipo que revisa entregas | `FirstStepsCard` «permite ocultar… y reaparece si se elimina una clave» intermitente bajo carga | **Cerrado** | PASS (10/10 pasos) |

## Comandos

| Comando | Resultado |
| --- | --- |
| `npm run build` | EXIT 0 (typecheck incluido) |
| `npm test`, ejecución 1 | EXIT 0 · 192 archivos · **2 711/2 711** |
| `npm test`, ejecución 2 (seguida) | EXIT 0 · 192 archivos · **2 711/2 711** |
| `npm test`, ejecución 3 (seguida) | EXIT 0 · 192 archivos · **2 711/2 711** |
| `npx playwright test e2e/custom-strategy.spec.ts e2e/strategy-stress.spec.ts e2e/news-sentiment.spec.ts e2e/onboarding-tour.spec.ts e2e/strategies-backtest.spec.ts` | EXIT 0 · **13/13** en 2,3 min |
| `git ls-files .venv-ml \| wc -l` | 0 |
| `grep -rnE '\b(it\|test\|describe)\.(only\|skip\|fails\|skipIf\|runIf)\(\|\.fixme\(' src e2e \| wc -l` | 0 |

Ninguna de las tres ejecuciones de `npm test` falla en `FirstStepsCard`:
`grep -c FirstStepsCard` sobre cada registro da 0, porque vitest solo nombra
los archivos que fallan. La 1.ª ejecución coincidió con los recorridos en
Electron del perfil A, así que el equipo estaba cargado. La prueba de 50/50
con `--repeats=49` la apunta la tarea «Puertas en verde y cierre con
evidencia».

Los recorridos se hicieron en la app compilada (`out/`), con un perfil
limpio por sesión y `TRADIA_E2E=1`, mediante guiones de Playwright que
están fuera del repositorio (`/tmp/qa-pc/perfil-a.mjs` y
`/tmp/qa-pc/perfil-b.mjs`, con registros en `/tmp/qa-pc/run-{a,b}.log` y
`/tmp/qa-pc/perfil-{a,b}.json`). Los specs de E2E que lancé regeneran
capturas versionadas de `docs/qa/capturas`; las he devuelto a su estado
para no ensuciar el diff.

## Sesión A · Profesional independiente que organiza varios proyectos

Contexto: lleva varios clientes y está montando para «Ruiz» un cruce de
medias en SPY. Prueba primero sin objetivo de beneficio, como haría con
prisa.

| # | Paso | Esperado | Observado | Evidencia | Resultado |
| --- | --- | --- | --- | --- | --- |
| A1 | Estrategias › Nueva estrategia, y en Objetivo pulsa «Sin objetivo» | El campo queda en `ninguno` y la ayuda dice que Riesgo vetará la compra | Campo `ninguno`, con el foco en él y «Válida». La ayuda visible y la descripción accesible dicen: «Con «ninguno» (Sin objetivo) el motor de riesgo vetará la compra por la relación beneficio/riesgo.» | `capturas/perfiles-cierre-a1-sin-objetivo-ayuda.png`; código `RuleEditor.tsx:21-22`; prueba `RuleEditor.test.tsx:366` | PASS |
| A2 | Solo con teclado: desde Objetivo, Tab hasta «Sin objetivo» y Enter | Se puede llegar y elegirlo sin ratón | 3 Tab hasta «Sin objetivo»; con Enter el campo vuelve a `ninguno` | `run-a.log` | PASS |
| A3 | Crea «Ruiz · Cruce SPY»: entrada `cruza_arriba(sma(rapida), sma(lenta))`, salida `cruza_abajo(…)`, stop `2%`, objetivo `6%`, `{"rapida":20,"lenta":50}` | Ficha con reglas ejecutables y lanzador activo | «Reglas listas para ejecutar · …Puedes lanzar un backtest o las pruebas de estrés.» y «Lanzar backtest» activo | `capturas/perfiles-cierre-a3-ficha-ejecutable.png` | PASS |
| A4 | Lanza el backtest desde la ficha (Monte Carlo 100) | Informe con operaciones y métricas | Informe #1: 25 operaciones y Sharpe 0,41, igual que en la QA anterior | `capturas/perfiles-cierre-a4-informe.png` | PASS |
| A5 | Vuelve a la ficha y ejecuta las pruebas de estrés | Crisis 2008, 2020 y 2022, y el informe en el historial | «Pruebas de estrés guardadas.», las tres crisis e «Informe #1» en el historial | `capturas/perfiles-cierre-a5-estres.png` | PASS |
| A6 | Nueva estrategia con reglas en texto libre (`cuando el mercado suba`) | No se puede lanzar nada y se explica el motivo | «Crear estrategia» desactivado, con «Hay 2 errores.» y «…no es un campo, un indicador ni un parámetro de la ficha · caracteres 1–6.» La ficha de una regla ya guardada que no es ejecutable la cubre el E2E `custom-strategy.spec.ts:175` ✓ (motivo visible, lanzador y estrés desactivados) | `capturas/perfiles-cierre-a6-reglas-no-ejecutables.png`; `e2e.log` | PASS |
| A7 | Ajustes › Análisis de noticias | Solo «Suscripción (Claude Code)» y «Analizador local» | Dos radios exactos. Ningún campo de contraseña y ningún texto «API», «Anthropic» ni «clave» en la sección | `capturas/perfiles-cierre-a7-ajustes-noticias.png` | PASS |
| A8 | Con la suscripción elegida, cae la sesión (`sin-sesion` por `ai:news-status-changed`) | Noticias y Ajustes dicen el motivo y el paso | Noticias: «Suscripción no disponible · sesión no iniciada · Abre un terminal, ejecuta claude y después /login… las noticias se analizan con el analizador local · Probar de nuevo». Ajustes muestra lo mismo | `capturas/perfiles-cierre-a8-noticias-sesion-caida.png`, `capturas/perfiles-cierre-a8-ajustes-sesion-caida.png`; E2E `news-sentiment.spec.ts:213` y `:317` ✓ | PASS |

## Sesión B · Responsable de equipo que revisa entregas

Contexto: revisa que el fallo intermitente que dejó abierto está arreglado
de verdad. Para ello repite el recorrido completo de la tarjeta en la app y
lanza la batería tres veces seguidas.

| # | Paso | Esperado | Observado | Evidencia | Resultado |
| --- | --- | --- | --- | --- | --- |
| B1 | Abre Inicio con un perfil limpio | «Primeros pasos» con lo que falta | «Primeros pasos · 1 de 3 hechos». Las fuentes oficiales vienen activas de serie, así que «Añade tus fuentes» ya sale «Hecho» | `run-b.log` | PASS |
| B2 | Ajustes: guarda las claves de Tiingo y FRED (valor de prueba, no real) y pulsa «Probar conexión» en cada una | «Guardada y cifrada» y «Conectado» | En ambas: «Guardada y cifrada · Conectado. Último dato disponible: 12 oct 2026» (proveedores simulados) | `run-b.log` | PASS |
| B3 | Fuentes: añade «GDELT · equipo» (API financiera, GDELT) | Fuente activa | Aparece activa junto a las seis oficiales | `run-b.log` | PASS |
| B4 | Inicio: «Todo listo» y «Ocultar» | La tarjeta se va y se recuerda | «Todo listo: Tradia ya recibe datos y noticias. · Ocultar». Al pulsarlo desaparece y `localStorage["tradia.firstSteps.hidden"] = "true"` | `capturas/perfiles-cierre-b4-todo-listo.png`, `capturas/perfiles-cierre-b4-oculta.png` | PASS |
| B5 | Va a Ajustes y vuelve a Inicio | Sigue oculta | 0 tarjetas | `run-b.log` | PASS |
| B6 | Ajustes › Claves de API: proveedor `fred` › «Borrar clave», y vuelve a Inicio | La tarjeta reaparece con «1 de 3 hechos» y se olvida «oculta» | «Primeros pasos · 1 de 3 hechos»: claves «Pendiente», conexión «Pendiente» y fuentes «Hecho». La marca `tradia.firstSteps.hidden` se ha borrado | `capturas/perfiles-cierre-b6-reaparece.png` | PASS |
| B7 | Pulsa «Añadir claves» en la tarjeta | Lleva al campo de la clave que falta | `#ajustes` con el foco en `fred-key` | `run-b.log` | PASS |
| B8 | Vuelve a guardar la clave de FRED, prueba la conexión y va a Inicio | «Todo listo» otra vez (la marca ya no la esconde) | «Todo listo… · Ocultar» | `run-b.log` | PASS |
| B9 | Ajustes › Análisis de noticias | Sin rastro de la API de pago | 2 radios y ningún texto «API», «Anthropic» ni «clave» | `run-b.log` | PASS |
| B10 | `npm test` tres veces seguidas | La prueba de `FirstStepsCard` pasa las tres | 3 × 2 711/2 711 y EXIT 0. El arreglo está en `FirstStepsCard.tsx:76-86` (borra «oculto» antes de publicar la configuración) y la prueba en `FirstStepsCard.test.tsx:126-151` (espera el DOM y el localStorage, sin sleeps) | `/tmp/qa-pc-test-{1,2,3}.log` | PASS |

## Hallazgos

Ninguno.

### Observación sin hallazgo

Nada más pulsar «Sin objetivo», durante menos de 1 s, la descripción
accesible del campo Objetivo conserva el error anterior («el campo de
objetivo está vacío…») mientras el valor ya es `ninguno`. Tras 1 s dice
«Válida» y `aria-invalid="false"`. Es el retardo de la validación en vivo,
y en pantalla se ve «Válida» (captura A1). No lo cuento como fallo; lo
apunto por si alguien revisa el lector de pantalla.

## Lo que no he podido comprobar en este entorno

- La sesión real de Claude Code y la notificación real de macOS tras un
  `/logout`. En modo `TRADIA_E2E` el estado se inyecta por IPC. Lo tiene que
  comprobar el usuario (`docs/tareas-del-usuario.md`).
- Claves reales de Tiingo y FRED: el recorrido B usa un valor de prueba
  contra los proveedores simulados.
- `npm run test:e2e` completo. En la misma carpeta trabaja a la vez la
  tarea «Puertas en verde y cierre con evidencia», que lo lanza y se pisaría
  con mis capturas. Ejecuté los 5 specs de estos recorridos (13/13).
- Otros sistemas operativos y lector de pantalla manual.
