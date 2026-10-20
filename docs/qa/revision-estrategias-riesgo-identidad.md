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

- **Coste del recorrido de versiones en pruebas:** la pasada consolidada dejó un único timeout en `StrategiesPage.test.tsx`. El alta ya pegaba los textos; la edición aún tecleaba el nombre y la nota carácter por carácter. Ambas entradas usan ahora pegado por `userEvent`, con los mismos valores, eventos de formulario y todas las comprobaciones de nota obligatoria, versiones, histórico y registro. Se mantienen los trece casos, las expectativas y el plazo original; la aislada final pasa en 2,84 s.

## Pruebas añadidas

`e2e/identidad-dominio.spec.ts` verifica las cuatro pantallas en claro y oscuro, Sora aplicada, ausencia de desbordamiento de página a 700 px y bloqueo de activación real. Cubre además el color de exportación con una entrada de diario producida por una señal vetada y el hover de la acción de creación tanto con `disabled` como con `aria-disabled`. Usa la aplicación Electron y los contratos existentes; no inventa endpoints ni conecta dinero real.

Las capturas de comprobación se generan en `test-results/identidad-*.png`; la spec global de identidad mantiene las capturas antes/después requeridas en `docs/qa/capturas/identidad/`.

## Revisión adicional del estado deshabilitado

La revisión actual detectó el mismo problema de especificidad en Dinero real: `.live-primary` prevalecía sobre `.button:disabled`. `live/checklist.css` aplica ahora superficie marcada, texto secundario y borde discontinuo a las acciones principales deshabilitadas de la lista, los diálogos y los ajustes. No cambia la disponibilidad de ninguna acción ni sus guardas.

`e2e/identidad-dominio.spec.ts` comprueba en ambos temas el fondo y el texto contra los tokens reales, el borde discontinuo y la opacidad completa del botón de activación bloqueado, también al pasar el ratón. Se han inspeccionado capturas actuales de Órdenes y Dinero real y las capturas versionadas de Estrategias y Riesgo. Las evidencias de los recorridos de activación y prueba de humo se han actualizado con la ejecución dirigida.

## Verificación final

Pasada del 20 de octubre de 2026, posterior a la entrega provisional:

- Los cuatro objetos de dominio coinciden exactamente con `docs/diseno/dominio.tokens.json`.
- Búsqueda de geometría y colores anteriores en `src`, `build`, `resources` y `scripts`: sin coincidencias.
- `npm run typecheck`, `npm run lint`, `npm run format:check` y `npm run build`: correctos.
- `npx playwright test e2e/identidad-dominio.spec.ts e2e/live-gate.spec.ts`: **4/4 correctas**. Comprueba ambos temas y ventanas estrechas, bloqueo de activación por interfaz e IPC, confirmación escrita, activación y prueba de humo con fixtures.
- `npm test` completo: **3895/3898**, 215 archivos correctos y dos con fallos, en 41,52 s. Ningún fallo en Estrategias, Riesgo, Órdenes, Dinero real ni contraste de dominio. Log: `/tmp/tradia-domain-final-unit.log`.
- Los tres fallos ajenos al alcance están en `cliEngines.test.ts:293` (Codex y Copilot: se registra una llamada en vez de dos tras el timeout) y `AiSettings.test.tsx:87` (la ruta de Codex aparece vacía). Hay cambios concurrentes del equipo en Ajustes y la configuración de Vitest, que esta revisión no modifica. No se declara el cierre global en verde ni se recortan pruebas.
- No se reinstalaron dependencias porque no se cambiaron. No se repitió la suite E2E global: su consolidación corresponde a `audit-fix-2`, según la coordinación del inbox. Se requiere que esa tarea cierre los fallos externos y publique la validación global definitiva.
