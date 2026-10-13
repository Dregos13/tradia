# Revisión del grep de saltos y del aviso «Sin objetivo»

Codex · Frontend · 13-10-2026. Revisión del cambio provisional `02834ae5` y de su entrega, contrastados con el código actual.

## Resultado

Los cambios de los comentarios de `src/main/backtest/__audit__/reglas.audit.test.ts:27` y `src/main/ai/__audit__/sin-api.audit.test.ts:22` son correctos: mantienen la convención de ejecutar todas las garantías como pruebas normales. No se ha eliminado ni desactivado ninguna prueba. Tanto el grep acordado como la búsqueda ampliada de marcadores de pruebas salen vacíos.

El aviso de Objetivo estaba presente y asociado al campo mediante `aria-describedby`, pero solo mencionaba la compra. La ficha permite reglas largas y cortas, y `src/main/risk/tradeRules.ts:158-160` veta cualquier entrada sin objetivo con `RR_TOO_LOW`, independientemente de su dirección. Se ha precisado la ayuda en `src/renderer/src/components/strategies/RuleEditor.tsx:22`: «Con «ninguno» (Sin objetivo) el motor de riesgo vetará las entradas en largo y en corto por la relación beneficio/riesgo.»

La prueba de `src/renderer/src/components/strategies/RuleEditor.test.tsx:367` comprueba dos casos: una estrategia solo larga y otra con entradas y salidas en corto. Verifica que el aviso es accesible antes de elegir la opción y después de insertar `ninguno` por teclado, que el foco vuelve al campo (con `waitFor`) y que la regla sigue siendo sintácticamente válida. La validación de sintaxis y el veto de riesgo son comprobaciones distintas; no se cambia el motor ni se impide estudiar la estrategia en backtest.

Se mantienen los tokens, estilos, contratos IPC, tecnologías y proveedores existentes. Esta revisión no introduce APIs de pago ni tareas nuevas para el usuario.

## Comprobaciones

- `grep -rnE 'it\.fails|\.skip\(|fixme|\.only\(' src e2e`: 0 líneas, exit 1 (sin coincidencias).
- `rg -n '\b(it|test|describe)\s*\.\s*(fails|skip|skipIf|fixme|only|todo)\b' src e2e`: 0 líneas, exit 1.
- `git ls-files .venv-ml`: 0 líneas, exit 0.
- `npx vitest run src/renderer/src/components/strategies/RuleEditor.test.tsx src/main/risk/tradeRules.test.ts`: 45/45 pruebas, 2/2 archivos.
- `npm run typecheck`, `npm run lint` y `npm run format:check`: exit 0.
- `npm test -- --maxWorkers=2`: 2.719/2.719 pruebas, 192/192 archivos, exit 0. Se limita el paralelismo porque había varias baterías de otras revisiones ejecutándose en el mismo equipo; una ejecución previa con la carga concurrente agotó los tiempos de tres pruebas ajenas al editor.
- `npm run test:e2e`: build correcto; 54 pruebas pasan y una falla (exit 1). La nueva `e2e/strategy-name-and-columns.spec.ts:80`, añadida por la revisión paralela `audit-fix-2`, no encuentra la fila con su localizador anidado. Los recorridos de estrategia propia, estrés, backtest, corto y bloqueo de reglas inválidas pasan. El criterio global de E2E verde queda pendiente de la corrección de esa prueba por su tarea responsable; no se modifica aquí.

Los logs de esta revisión se encuentran en `/tmp/tradia-audit-o2-*.log` y no forman parte del repositorio.
