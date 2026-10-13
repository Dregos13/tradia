# Regresión con todos los perfiles · tras «Sin aviso falso de «vacío» al insertar un ejemplo»

_Claude · Predeterminado (Testing) · 13-10-2026 · rama
`orquesta/completa-estas-partes-sin-hacer-y-compru-7d9830` sobre `5dc32010`.
No se ha cambiado código de `src` ni de `e2e`._

## Veredicto

- **C1 cerrado.** Al insertar un ejemplo en un campo vacío ya no aparece
  «está vacío» en ningún momento: el resultado pasa directamente a «Válida»
  (en 4–80 ms, sin estado intermedio) y `aria-invalid` sigue en `false`.
- **Hallazgo nuevo (bajo):** al escribir en una regla, los seis campos
  muestran «Comprobando…» durante 200 ms, no solo el que se edita. Cada
  resultado es una región `aria-live`, así que un lector de pantalla oye
  hasta seis avisos por pausa al escribir.

## Comandos

| Comando | Resultado |
| --- | --- |
| `npm run typecheck && npm run lint && npm run format:check && npx vitest run` | EXIT 0 · Prettier «All matched files use Prettier code style!» · 192 archivos · **2 714/2 714** |
| `npx vitest run …/FirstStepsCard.test.tsx -t "reaparece si se elimina una clave" --repeats=49` con otro `npx vitest run` completo a la vez | EXIT 0 las dos (50/50 repeticiones; batería completa 2 714/2 714) |
| `npx electron-vite build` y `npx playwright test` | EXIT 0 · **54/54** en 4,2 min |
| `git ls-files .venv-ml \| wc -l` | 0 |
| `grep -rnE '\b(it\|test\|describe)\.(only\|skip\|fails\|skipIf\|runIf)\(\|\.fixme\(' src e2e \| wc -l` | 0 |

Las capturas versionadas que regenera la batería de E2E se han devuelto a su
estado. Los recorridos usan la app compilada (`out/`), un perfil limpio y
`TRADIA_E2E=1`, con guiones de Playwright que no están en el repositorio:
`/tmp/qa-r3/perfil-a.mjs` y `/tmp/qa-r3/perfil-a-extra.mjs`, con los
registros en `/tmp/qa-r3/run-a.log` y `/tmp/qa-r3/perfil-a.json`. Un
`MutationObserver` junto con `requestAnimationFrame` registra cada cambio
de texto, de `aria-invalid` y de valor en los resultados de las reglas.

## Sesión A · Profesional independiente que organiza varios proyectos

| # | Paso | Esperado | Observado | Resultado |
| --- | --- | --- | --- | --- |
| A1 | Estrategias › Nueva estrategia, con Objetivo vacío, pulsar «Sin objetivo» | Pasa directamente a «Válida» | `0 ms: Escribe una regla o inserta un ejemplo.` → `47 ms: Válida` (`ninguno`, `aria-invalid=false`). Nunca aparece «vacío». A 100 ms ya está en «Válida» (`capturas/perfiles-regresion3-a1-sin-objetivo-100ms.png`) | PASS |
| A2 | Con los parámetros `{"rapida":20,"lenta":50}`, vaciar cada campo y pulsar cada uno de los 11 ejemplos | Ninguno muestra un error transitorio | Los 11 pasan del estado vacío a «Válida» sin estados intermedios. En «Insertar salida del corto por cruce», el aviso de la pareja de corto que había antes de pulsar (es correcto) desaparece al insertar | PASS |
| A3 | Solo con teclado: vaciar Objetivo, 3 Tab hasta «Sin objetivo» y Enter | Igual que A1, y el foco vuelve al campo | `13 ms: Válida` y el foco en Objetivo | PASS |
| A4 | Objetivo `6%` → «Sin objetivo» | Válida sin parpadeo | `Válida (6%)` → `Válida (ninguno)` | PASS |
| A5 | Escribir a mano: borrar `6%` y luego teclear `xyz` | Sin error del valor anterior mientras se comprueba; a los 200 ms, el resultado real | Al borrar: «Comprobando…» y después «Escribe una regla o inserta un ejemplo.» (sin «vacío»). Al teclear: «Comprobando…» por cada tecla y, a los 200 ms de la última, ««xyz» no es un campo…» con `aria-invalid=true` (`capturas/perfiles-regresion3-a5-error-tras-escribir.png`) | PASS |
| A6 | Crear «Ruiz · Cruce sin objetivo» con cruce de medias, salida RSI, stop 2 % y «Sin objetivo» | Se guarda y la ficha es ejecutable | Resumen «Reglas válidas · se pueden guardar y ejecutar.» y en la ficha «Reglas listas para ejecutar…» | PASS |
| A7 | Con Entrada, Salida y Stop ya válidas, escribir `6` en Objetivo | Solo Objetivo pasa a «Comprobando…» | **Los seis resultados pasan a «Comprobando…»**, todos con `aria-live=polite`, y a los 200 ms vuelven a «Válida» o «Sin corto…» (`capturas/perfiles-regresion3-a7-comprobando-todos.png`). Causa: `StrategyForm.tsx` pasa `pending={validationPending}` a `RuleEditor`, que lo reparte a todos los campos (`RuleEditor.tsx:177`) | **FAIL (bajo)** |

## Sesión B · Responsable de equipo que revisa entregas

| # | Paso | Esperado | Observado | Resultado |
| --- | --- | --- | --- | --- |
| B1 | Puertas: typecheck, lint, format:check y `npm test` | En verde | EXIT 0 · 2 714/2 714 | PASS |
| B2 | FirstStepsCard 50 veces seguidas con otro `npm test` a la vez | 50/50 | EXIT 0 en ambos procesos | PASS |
| B3 | `npm run test:e2e` completo | En verde | 54/54 | PASS |
| B4 | `.venv-ml` y saltos prohibidos | Vacío | 0 y 0 | PASS |
| B5 | Evidencia de C1 en `docs/qa/estado-pendientes.md:248-256` | Las referencias existen y dicen lo que se afirma | `RuleEditor.test.tsx:367` (ayuda de O2), `:379` (inserción con reloj falso) y `:400` (escritura con 200 ms) coinciden. La captura `cierre-c1-validacion-insercion.png` existe | PASS |
