# Diario · verificación del renderer

Página `#diario` integrada tras Riesgo. Sigue `docs/diseno-fase-4.md` y los tokens base y dashboard del repositorio. No lee `.orquesta` en ejecución.

- Filtros combinados Desde/Hasta, Tipo, Activo, Estrategia y Resultado. Aplicar valida el orden de fechas; Limpiar reinicia filtros y página.
- Paginación de 20 entradas mediante `journal.list`; exportación mediante `journal.exportCsv({query})` sin offset ni limit, para incluir el conjunto filtrado.
- Detalle mediante `journal.get(id)`, con motivo, datos usados, resultado, errores y reglas. Incluye versiones y fecha local e ISO.
- Teclado: apertura por Enter, foco inicial en título, ciclo Tab/Shift+Tab, Escape y retorno al disparador.
- Eventos `journal.onUpdated` recargan la consulta vigente, descartan respuestas antiguas y liberan la suscripción al desmontar.
- Exportación: progreso, confirmación de ruta, cancelación silenciosa y error. No se implementa Abrir carpeta: el contrato actual no expone una acción para abrir la carpeta de un CSV.

## Pruebas

`npx vitest run src/renderer/src/components/journal/JournalPage.test.tsx src/renderer/src/App.test.tsx`: 18 pruebas correctas (6 nuevas del diario).

ESLint de los archivos de esta tarea y `git diff --check`: correctos.

Batería global ejecutada: 102 archivos correctos, 1 fallido; 1277 pruebas correctas y 2 fallidas en `src/main/backup/service.test.ts` (restauración limpia y copia corrupta). El módulo de copias está en desarrollo paralelo.

Última pasada global: typecheck falla únicamente en `src/main/backup/service.ts:217` y `:218` (`number | undefined`); lint falla en el mismo archivo por `DAY_MS` no usado. No se modificaron esos archivos.

## Capturas

Generación reproducible: `node scripts/qa-journal.mjs`. Usa el adaptador simulado y ejemplos explícitos de QA, sin proveedores reales.

- `capturas/fase-4-diario-1440.png`
- `capturas/fase-4-diario-700.png`
- `capturas/fase-4-diario-detalle-1440.png`
- `capturas/fase-4-diario-detalle-700.png`

Inspección visual: controles y etiquetas visibles, filtros en dos columnas a 700 px, tabla completa con desplazamiento horizontal, detalle lateral de 420 px en escritorio y panel de 94vw en compacto. Corrección realizada: ocultar visualmente el caption accesible de la tabla.

La comprobación E2E del CSV real y sus columnas corresponde a la batería de fase 4, con backend y Electron. Estas pruebas verifican el contrato y los estados del renderer.
