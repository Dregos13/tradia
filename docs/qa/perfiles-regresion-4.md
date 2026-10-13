# Regresión con todos los perfiles · tras «Solo el campo editado muestra «Comprobando…»»

_Claude · Predeterminado (Testing) · 13-10-2026 · rama
`orquesta/completa-estas-partes-sin-hacer-y-compru-7d9830` sobre `a04152ca`.
No se ha cambiado código de `src` ni de `e2e`._

## Veredicto

- **A7 cerrado.** Al escribir en Objetivo, solo Objetivo pasa a
  «Comprobando…». Entrada, Salida y Stop siguen en «Válida» y los campos de
  corto en «Sin corto en este campo.», sin ningún cambio de texto en sus
  regiones `aria-live`. El resumen del bloque pasa a `aria-live=off`
  mientras se comprueba.
- C1 y O2 siguen cerrados. No hay hallazgos nuevos.

## Comandos

| Comando | Resultado |
| --- | --- |
| `npm run typecheck && npm run lint && npm run format:check && npx vitest run` | EXIT 0 · 192 archivos · **2 717/2 717** |
| `npx vitest run …/FirstStepsCard.test.tsx -t "reaparece si se elimina una clave" --repeats=49` con otro `npx vitest run` completo a la vez | EXIT 0 las dos (50/50 repeticiones; batería completa 2 717/2 717) |
| `npx electron-vite build` y `npx playwright test` | EXIT 0 · **54/54** en 4,2 min |
| `git ls-files .venv-ml \| wc -l` | 0 |
| `grep -rnE '\b(it\|test\|describe)\.(only\|skip\|fails\|skipIf\|runIf)\(\|\.fixme\(' src e2e \| wc -l` | 0 |

Las capturas versionadas que regenera la batería de E2E se han devuelto a su
estado. Los recorridos usan la app compilada (`out/`), un perfil limpio y
`TRADIA_E2E=1`, con un guion de Playwright que no está en el repositorio
(`/tmp/qa-r4/perfil-a.mjs`). Los registros están en `/tmp/qa-r4/run-a.log`
y `/tmp/qa-r4/perfil-a.json`, y los de la sesión B en
`/tmp/qa-r4/{fsc-50,load,e2e}.log` y `/tmp/qa-r4-gates.log`. Un
`MutationObserver` en cada resultado de regla registra los cambios de texto
durante cada paso.

## Sesión A · Profesional independiente que organiza varios proyectos

| # | Paso | Esperado | Observado | Resultado |
| --- | --- | --- | --- | --- |
| A7 | Nueva estrategia con `{"rapida":20,"lenta":50}`, cruce de medias, salida RSI o cruce y stop del 2 %; escribir `6` en Objetivo y leer los seis resultados antes de 200 ms | Solo Objetivo en «Comprobando…» | Solo `target=Comprobando…`. Los otros cinco no cambian (0 mutaciones). Resumen: `aria-live=off`, «Comprobando reglas…» (`capturas/perfiles-regresion4-a7-solo-objetivo.png`) | PASS |
| A7b | Vaciar Objetivo y teclear `6%` con 60 ms entre teclas | Solo cambia Objetivo | Objetivo: «Comprobando…» → «Válida». Los otros cinco: 0 mutaciones | PASS |
| A7c | Añadir un espacio al final de Entrada | Solo Entrada en «Comprobando…» | Pendientes: `["entry"]` y después «Válida». Los demás: 0 mutaciones | PASS |
| A7d | Cambiar Parámetros a `{"rapida":10,…}` | Los seis se comprueban, porque los parámetros afectan a todas las reglas (comportamiento documentado por fix-4) | Los seis en «Comprobando…» y a los 200 ms vuelven a su resultado real | PASS |
| A7e | Objetivo `xyz` (error) y después editar Entrada | El error de Objetivo se mantiene mientras se comprueba Entrada | Objetivo mantiene ««xyz» no es un campo…» y `aria-invalid=true`. Resumen: «Hay 1 error. Corrige Objetivo antes de guardar.» (`capturas/perfiles-regresion4-a7e-error-conservado.png`) | PASS |
| A1/O2 | Vaciar Objetivo y pulsar «Sin objetivo» | «Válida» sin pasar por «vacío», y la ayuda del veto de riesgo | «Válida» a 100 ms, sin ningún texto de «vacío». La ayuda dice «…vetará la compra por la relación beneficio/riesgo» | PASS |
| A6 | Completar mercados y fechas, y crear «Ruiz · Regresión 4» | Se guarda y la ficha es ejecutable | Aparece el título y «Reglas listas para ejecutar…» | PASS |

## Sesión B · Responsable de equipo que revisa entregas

| # | Paso | Esperado | Observado | Resultado |
| --- | --- | --- | --- | --- |
| B1 | Puertas: typecheck, lint, format:check y `npm test` | En verde | EXIT 0 · 2 717/2 717 | PASS |
| B2 | FirstStepsCard 50 veces seguidas con otro `npm test` a la vez | 50/50 | EXIT 0 en ambos procesos | PASS |
| B3 | `npm run test:e2e` completo | En verde | 54/54 | PASS |
| B4 | `.venv-ml` y saltos prohibidos | Vacío | 0 y 0 | PASS |
| B5 | Evidencia de A7 en `docs/qa/estado-pendientes.md:258` | Las referencias existen y dicen lo que se afirma | `StrategyForm.tsx:102` (pendiente por campo), `:110` (errores filtrados por campo pendiente), `:313` (`aria-live` del resumen), `RuleEditor.tsx:178` (`pending?.[field]`). `RuleEditor.test.tsx:433`, `:474` y `:493` son las tres pruebas descritas | PASS |
