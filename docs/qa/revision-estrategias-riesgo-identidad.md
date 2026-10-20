# Revisión de Estrategias, Riesgo, Órdenes y Dinero real

Revisión de la entrega provisional de Sonnet frente a la dirección «Telemetría de box» y al contrato de dominio de la identidad Arco.

## Resultado de la revisión

Los cuatro archivos `strategy.tokens.json`, `risk.tokens.json`, `broker.tokens.json` y `live.tokens.json` coinciden íntegramente con el contrato recibido. La aplicación consume copias locales: no importa recursos de `.orquesta/`.

Se compararon las pantallas de Estrategias y Riesgo con la maqueta 03 en ambos temas y se inspeccionaron las capturas actuales de las cuatro pantallas a 1440 px. Se conserva la composición por carriles, las cabeceras de acero, los separadores finos, las cifras monoespaciadas y los estados semánticos con texto. La app conserva las descripciones, ayudas de límites y estados reales del motor, más extensos que los ejemplos de la maqueta. Se mantiene la jerarquía de títulos de la app (h1 de la barra superior y subtítulo h2), definida por las pruebas existentes de legibilidad.

Los formularios mantienen validación, mensajes de error y bloqueo de acciones. Los listados conservan carga, vacío, errores y recuperación. La activación real permanece bloqueada hasta cumplir los requisitos; no se han cambiado contratos IPC, operaciones, límites, guardas del motor ni textos operativos.

## Hallazgos corregidos

- **Estado deshabilitado de la acción principal de Estrategias:** la regla del botón principal prevalecía sobre la regla genérica deshabilitada. Su hover podía conservar el acento de una acción activa. Ahora `:disabled` y `aria-disabled="true"` usan superficie marcada, texto secundario y borde discontinuo; el hover activo excluye ambos estados. El botón con `aria-disabled` sigue siendo enfocable para explicar la validación.
- **Texto de exportación del Diario:** usaba `--color-surface` sobre el acento. Se sustituye por `--color-inverse`, el token que expresa texto sobre una acción principal en los dos temas, sin acoplar el texto al color del panel.
- **Cobertura de contraste de dominio incompleta:** la prueba de base no recorría los estados de estas cuatro familias. `domain-identity.test.ts` descubre recursivamente los estados de los cuatro JSON y verifica texto sobre relleno y superficies de uso; también comprueba curvas, fases, mapas de calor, selección y franja de dinero real. Son 146 comprobaciones en claro y oscuro. La rejilla es decorativa; el velo modal no es texto ni gráfico informativo.

## Pruebas añadidas

`e2e/identidad-dominio.spec.ts` verifica las cuatro pantallas en claro y oscuro, Sora aplicada, ausencia de desbordamiento de página a 700 px y bloqueo de activación real. Cubre además el color de exportación con una entrada de diario producida por una señal vetada y el hover de la acción de creación tanto con `disabled` como con `aria-disabled`. Usa la aplicación Electron y los contratos existentes; no inventa endpoints ni conecta dinero real.

Las capturas de comprobación se generan en `test-results/identidad-*.png`; la spec global de identidad mantiene las capturas antes/después requeridas en `docs/qa/capturas/identidad/`.

## Verificación final

- `npm install`: correcto.
- `npm run typecheck`, `npm run lint`, `npm run format:check`: correctos tras estabilizar las ediciones concurrentes.
- Prueba de contraste de dominio: 146/146 correctas.
- `identidad-dominio.spec.ts`: 2/2 correctas, temas claro y oscuro.
- `live-gate.spec.ts`: 2/2 correctas en repetición aislada, incluido activar y completar la prueba de humo.
- `ChecklistPage.test.tsx`, `StrategyAi.test.tsx` y `JournalPage.test.tsx`: 56/56 correctas en repetición aislada; `StrategiesPage.test.tsx`: 13/13 correctas.
- Búsqueda de geometría y colores de marca anterior en `src`, `build`, `resources` y `scripts`: sin coincidencias.
- Primera ejecución completa de `npm test`: 3289/3290 correctas; timeout de 120 s en `src/main/backtest/service.test.ts`, siembra de backtests. La segunda, simultánea a otras suites del equipo, acumuló 46 fallos de 3898 pruebas, principalmente plazos agotados. Las repeticiones aisladas anteriores comprueban los casos de interfaz de esta tarea que fallaron bajo esa carga.
- La pasada completa de E2E detectó un fallo en la medición de la barra de estado y uno en `live-gate`; este último pasó aislado. Se detuvieron las ejecuciones globales antiguas a petición de `audit-fix-2`, para permitir una única validación consolidada sobre el código estable, sin cambiar configuración, expectativas ni plazos. El cierre global se completará con sus resultados.
