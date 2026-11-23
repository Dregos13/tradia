# Revisión de legibilidad, jerarquía y composición

Revisión de la entrega provisional de Sonnet (`edcd494e-fix-1-v2`), sobre el checkout compartido. Se conserva la dirección «Telemetría de box», el monograma Arco, la paleta y las fuentes locales Sora e IBM Plex Mono. No se cambian textos, contratos, navegación ni lógica operativa.

## Resultado de la revisión

- **Metadatos:** se conserva el mínimo global de 13 px para `small`. La prueba real recorre todos los `small` visibles de Estrategias, Riesgo y Ajustes en ambos temas.
- **Jerarquía:** se conserva la escala 24/18/16 px. Se amplía la regresión de Inicio: además de comparar h1 y h2, exige que el primer carril deje al menos 120 px dentro del área de contenido, incluso con «Primeros pasos» presente.
- **Mercado:** se conservan las filas compactas y la ayuda bajo el campo. La medición del gráfico ahora intersecta su caja con `.main` y con la ventana; la barra inferior ya no cuenta como gráfico visible. Se mantiene el mínimo de 150 px y la comprobación de filas de como máximo 56 px con los 25 activos y SPY.
- **Barra inferior:** `styles.css` permite al grupo de estados encogerse y envolver sus elementos dentro del ancho disponible (`min-width: 0; max-width: 100%`). Antes, `flex-shrink: 0` podía impedir ese ajuste con mensajes más largos. Se comprueban Inicio y Riesgo a 1100 × 760, con conexión y sin ella, incluyendo «Agentes en pausa». La prueba mide límites izquierdos y derechos y los rectángulos reales del texto visible, además del ancho desplazable y los solapamientos. Las etiquetas largas reservadas para lectores de pantalla se excluyen de la medición visual, pero siguen comprobándose en el DOM.
- **Aislamiento de las pruebas:** cada caso recupera 1440 × 900, restablece el desplazamiento de `.main` y espera las fuentes locales antes de medir. Así no hereda el tamaño de ventana de otro caso ni mide con fuentes de respaldo.

Las capturas verificadas de la entrega provisional se encuentran en `capturas/identidad-correcciones/`. Su prueba se vuelve a ejecutar para actualizar la evidencia con estas comprobaciones más estrictas. La corrección conserva el gráfico parcialmente visible: ver su altura completa aún requiere desplazarse; no se afirma que todo el lienzo quepa en el primer pliegue.

## Verificación

- `npm install`: correcto; no cambió el lockfile.
- `npm run build` y `npm run typecheck`: correctos con los cambios actuales.
- `npm run lint` y `npm run format:check`: correctos en la comprobación final.
- `npx vitest run src/renderer/src/legibilidad-identidad.test.ts --maxWorkers=1`: 4/4.
- `npx playwright test e2e/identidad-legibilidad.spec.ts`, tras recompilar: 10/10 (32,5 s). Barra aislada: 2/2, en línea y sin conexión, ambos temas.
- Inspección de las capturas regeneradas de Mercado oscuro y Riesgo claro a 1100 px: consistente con las mediciones. No aparecen recortes ni solapamientos en la barra.
- Búsqueda de geometría y colores anteriores en `src`, `build`, `resources`, `scripts`: sin coincidencias. `git diff --check`: correcto.

La primera ejecución global coincidió con otras tres baterías sobre el mismo checkout y con archivos en edición. No es una certificación de la versión final: Vitest tuvo tiempos de espera en ingesta, estrategias y buscador; se relanzó completa con dos workers, sin modificar configuración, casos ni umbrales. Esa repetición también registró tiempos de espera de 120 s en las semillas de `src/main/backtest/service.regime.test.ts` y `service.test.ts`. El E2E inicial cargó una versión intermedia de esta spec que medía las etiquetas visualmente ocultas: sus dos fallos de barra quedan corregidos y comprobados en la ejecución actualizada 10/10; también falló inicialmente el primer recorrido de IA bajo carga.

Las dos baterías propias se detuvieron para liberar recursos: la E2E inicial había ejecutado 60 de 126 casos y conservaba una versión intermedia de la spec; Vitest había registrado los dos timeouts indicados. No se cuentan como ejecuciones completas ni como aprobadas. `audit-fix-2` coordina una única ejecución global consolidada sobre los cambios estables. Hasta que termine, no se declara cumplida la aceptación global de `npm test` ni de `npm run test:e2e`. Las incidencias ajenas a esta tarea quedan explícitas; no se ha debilitado ninguna prueba para conseguir verde.
