# Revisión del contador del nombre y las columnas de la biblioteca

Fecha: 13 de octubre de 2026. Alcance: entrega provisional `7d9830c6-fix-2-v1.md`, formulario de estrategias y tabla de la biblioteca.

## Resultado de la revisión

La implementación cumple los dos fallos asignados. No necesita cambios en producción:

- `StrategyForm.tsx:137`: cuenta con el mismo límite compartido que el contrato IPC (`STRATEGY_NAME_MAX_LENGTH`). Conserva los 134 caracteres pegados, muestra `134/120`, explica los 14 sobrantes y marca el campo como inválido. El texto y el contador están asociados mediante `aria-describedby`; el aviso utiliza `aria-live="polite"`. A 120 caracteres avisa del máximo. El guardado bloqueado devuelve el foco al nombre y funciona de nuevo tras corregirlo, tanto al crear como al editar.
- `StrategyLibrary.tsx:70` y `strategies.css:81`: las cabeceras, los datos numéricos y las fechas conservan una línea y un ancho mínimo con tokens del proyecto. El nombre puede ocupar dos líneas; mantiene el texto completo en el nombre accesible del enlace y en su `title`. El enlace admite foco y abre la ficha completa. A 700 px se conserva la presentación en tarjetas.

El contador usa unidades de longitud de JavaScript, igual que el contrato IPC: no introduce una validación distinta de la del backend. No cambia reglas ejecutables, riesgo, dinero real, noticias, tecnologías ni endpoints. La app sigue siendo Electron.

## Mejora de la evidencia automatizada

La prueba unitaria que buscaba fragmentos de CSS solo comprobaba la implementación escrita y no detectaba un fallo real del diseño. Se sustituye por `e2e/strategy-name-and-columns.spec.ts`, que utiliza un perfil temporal limpio y completa el tour mediante el gancho existente.

La nueva prueba cubre:

1. Nombre de 134 caracteres sin truncado, descripción accesible, bloqueo y foco mediante Enter.
2. Recuperación al corregir a 120 caracteres y persistencia del nombre completo en la ficha.
3. Backtest para poblar las cifras de la fila; las otras filas conservan «Sin datos».
4. Medición de las líneas de texto renderizadas en todas las cabeceras y celdas de datos a 1440 × 1000, sin desbordamiento de la tabla ni del documento.
5. Biblioteca a 700 × 1000 sin desbordamiento y con enlace accesible.
6. Edición con 121 caracteres bloqueada; corrección y guardado de la versión 2.

Se mantienen las pruebas de contador, pegado y semántica de `StrategyNameAndLibrary.test.tsx`. Las capturas de la prueba se regeneran en `test-results/strategy-name-columns-{1440,700}.png` y se inspeccionaron visualmente. Las capturas de la entrega provisional permanecen en `docs/qa/capturas/fe-nombre-y-biblioteca-*.png`.

## Comprobaciones

Revisión completada el 13 de octubre de 2026 sobre el árbol compartido:

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | EXIT 0 |
| `npm run lint` | EXIT 0 |
| `npm run format:check` | EXIT 0 |
| `npm test -- --maxWorkers=2` | 2.731/2.731 pruebas, 193 archivos, EXIT 0 |
| `npm run test:e2e` | 55/55, sin reintentos, 4,9 min, EXIT 0 |
| `git ls-files .venv-ml` | Vacío |
| Búsqueda de `it/test/describe.fails/skip/fixme/only` y `skipIf/runIf` en `src` y `e2e` | Vacía |

Logs locales: `/tmp/tradia-audit-name-format.log`,
`/tmp/tradia-audit-name-unit-final.log` y `/tmp/tradia-audit-name-e2e.log`.
Se inspeccionaron las capturas actuales de `test-results/strategy-name-columns-{1440,700}.png`:
cifras del backtest, cabeceras y «Sin datos» sin partir a 1440 px; tarjetas sin desbordamiento a 700 px.

La primera batería unitaria coincidió con la incorporación de una prueba de límites del corto
y falló en `LiveLimitsSettings.test.tsx:117` (confirmación habilitada con un campo vacío).
La tarea paralela de límites corrigió el estado pendiente; la batería completa repetida pasó.
Esta revisión no modifica esos componentes ni sus pruebas.

Se conserva la corrección ya integrada del localizador de fila en
`e2e/strategy-name-and-columns.spec.ts:78`: el filtro `has` busca el enlace dentro de la fila,
sin volver a exigir la tabla como ancestro relativo. La ejecución completa confirma la corrección.
No se han añadido dependencias ni pasos para el usuario. No se ha probado manualmente un lector de pantalla.
Los criterios globales de noticias, riesgo y equivalencia de estrategias pertenecen a las otras tareas;
esta revisión verifica los dos fallos asignados y las baterías compartidas.
