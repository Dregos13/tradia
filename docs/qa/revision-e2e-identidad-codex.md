# Revisión de las ocho correcciones E2E de identidad

Revisión de la entrega provisional `edcd494e-fix-2-v1` y del commit
`22cb6759`. Se conserva la dirección «Telemetría de box», los contratos de IPC,
los textos y selectores de los recorridos existentes y la configuración de pruebas.

## Resultado de la revisión

| Hallazgo | Evaluación |
| --- | --- |
| IDV-E2E-1 | La corrección provisional cerraba el desplegable al enviar, pero recordaba el símbolo elegido en vez de la consulta del campo. Por ejemplo, elegir `EURUSD` buscando `EURO` dejaba que el foco o una respuesta tardía reabrieran el desplegable sobre el aviso. Se recuerda ahora `query.trim()`. |
| IDV-E2E-2 | Correcto: `.orders-reconcile` conserva los cuatro bordes, relleno con token y fondo `surfaceSubtle`, sin sombra. La regresión mide 1280×800 y 1024×700 en ambos temas. |
| IDV-E2E-3 | Correcto: «Divisa» tiene su propio elemento y se conserva la descripción accesible completa con calendario y restricción operativa. |
| IDV-E2E-4 | Correcto: título contractual «Suscripción no disponible · sesión no iniciada» y recuperación específica del CLI en el detalle. Los dos fondos actualizados en la spec corresponden a los tokens de la nueva identidad. |
| IDV-E2E-5 | Correcto: dos radios nativos, etiquetados y sincronizados con el selector de motores. Se añade una prueba de arranque desde el analizador local: Claude ausente y Codex/Copilot instalados elige Codex y guarda ese motor. |
| IDV-E2E-6 | Correcto: el aviso es hijo directo de `.ai-page`; el atributo de medición vive en `DataFreshness`, sin envoltorio extra ni cambio de datos o de comportamiento del motor. |
| IDV-E2E-7 | Corrección conservada: cabeceras y prosa en Sora, cifras en mono y tabla sin recorte a 1120 px. La spec r2 mide las ocho columnas en ambos temas. |
| IDV-E2E-8 | Corrección conservada: estado completo y horas indivisibles, etiquetas temporales cortas cuando falta anchura. La spec r2 verifica «En línea» y «Agentes activos» en Inicio, Mercado y Riesgo. |

Se inspeccionaron también las capturas de la tabla de Estrategias oscura a
1120 px, Órdenes claro a 1024 px, los radios oscuros y la barra de estado clara
de `docs/qa/capturas/identidad-correcciones-r2/`.

## Cambios de esta revisión

- `AssetSearch.tsx`: el cierre queda asociado a la consulta visible, aunque el
  símbolo elegido sea diferente. Las flechas permiten reabrirlo voluntariamente.
- `AssetSearch.test.tsx`: regresión con búsqueda pendiente, sugerencia rechazada,
  recuperación de foco y reapertura explícita con flecha. La prueba provisional
  usa ahora eventos de foco envueltos por Testing Library: antes comprobaba el DOM
  sin esperar la actualización de React y podía pasar incorrectamente.
- `AiSettings.test.tsx`: prueba de elección y guardado del primer CLI instalado
  cuando se activa la suscripción desde el analizador local.

La regresión de foco falló con el código provisional y pasó después de la
corrección. No se han eliminado pruebas ni relajado expectativas.

## Verificación

- `npm install`, `npm run typecheck`, `npm run lint` y `npm run format:check`:
  correctos en el árbol consolidado.
- Las pruebas específicas de `AssetSearch` y `AiSettings` pasan (29 pruebas).
- Búsqueda de geometría y colores anteriores en `src`, `build`, `resources` y
  `scripts`: sin coincidencias.

Las primeras suites globales coincidieron con otras tres baterías del equipo y
con ediciones de pruebas todavía en curso. Registraron fallos de tiempo y una
versión intermedia de las mediciones de la barra; se interrumpieron y no se usan
como evidencia de aprobación. El equipo acordó una pasada final consolidada,
sin alterar configuración, tiempos límite ni aserciones.

Resultado de esa pasada: pendiente de finalizar.
