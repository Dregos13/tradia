# Revisión de Ajustes y ficha: límites del corto con dinero real

Codex · Frontend · 13-10-2026. Revisión de la entrega provisional
`.orquesta/outputs/7d9830c6-supervise-4-task-2-v3.md` y del código vigente.
La entrega final provisional solo describe el parser: los componentes y el
E2E originales entraron en `3720f610` junto con la auditoría; `951cc20c`
actualizó la documentación. Se han revisado ambos cambios y sus contratos.

## Resultado y corrección

Los límites ya estaban implementados: 100 USD por orden en corto, 200 USD
de exposición corta total, una posición y stop obligatorio a un máximo del
5 %. El formulario toma los techos de `LIVE_FIXED_SHORT_CAPS`, permite
reducirlos y explica que cualquier límite a cero desactiva el corto. No hay
un campo que permita elevar el stop. El diálogo incluye los tres valores
cortos y la frase de confirmación; la ficha consume `LiveState.limits`, que
el contrato reserva a los límites confirmados. No presupone permiso si
falta la lectura o falla. Cada orden sigue pasando por Riesgo y la guarda
real; el aviso de la ficha explica las condiciones del broker.

Se encontró y corrigió un fallo: con un límite corto guardado en cero,
vaciar el campo hacía que `Number('') === 0` mantuviera el formulario como
sin cambios. Se podía abrir la confirmación de los límites guardados
mientras el borrador mostraba un error. No elevaba los techos del backend,
pero permitía confirmar desde un formulario inválido.

`src/renderer/src/components/live/LimitsForm.tsx:61` calcula el borrador
pendiente con la validación de cada valor además de su comparación con el
guardado. La misma función gobierna el texto de límites guardados y el
estado comunicado al padre: un campo vacío bloquea la confirmación y
oculta la frase guardada; escribir de nuevo cero recupera ambas cosas.

## Pruebas y evidencia

- `LiveLimitsSettings.test.tsx:101`: regresión con lista completa y límite
  corto guardado en cero. Falló antes de la corrección en `toBeDisabled()`;
  pasa con el arreglo. Log previo: `/tmp/tradia-short-before.log`.
- `LimitsForm.test.tsx:18`: los tres techos, posiciones fraccionarias,
  negativos y vacío producen errores asociados al campo y no llegan a
  `onSave`, incluso ante envío directo. Cero conserva los otros límites.
- `LiveShortStatus.test.tsx:54`: cada uno de los tres límites a cero
  desactiva el permiso. Un evento con límites sin confirmar retira el
  permiso de la ficha. Se mantienen carga, error y reintento originales.
- `e2e/live-short-limits.spec.ts:77`: en Electron, guardar límites con el
  corto cerrado, vaciar el cero, comprobar el bloqueo y corregirlo antes
  de validar los techos, guardar, confirmar y consultar la ficha.
- Pruebas existentes: cancelación por Escape, foco atrapado y devuelto,
  confirmación exacta y foco en el resultado, error de guardado conservando
  el borrador (`LiveLimitsSettings.test.tsx:36`, `:86`); guardar/confirmar el
  corto desde la lista (`ChecklistPage.test.tsx:619`).
- Estilos revisados: `checklist.css` usa tokens y reduce la cuadrícula a una
  columna hasta 700 px. Etiquetas, errores con `aria-describedby`, estados
  de carga/error y controles deshabilitados conservados. Sin cambios de
  diseño, dependencias, endpoints ni plataformas.

## Verificación

Typecheck, lint y format:check: EXIT 0. `npm test`: **2.731/2.731**, 193
archivos, EXIT 0. Logs: `/tmp/tradia-short-{typecheck,lint,format,all}.log`.

La ejecución del directorio de componentes live y estado corto previa a
las cuatro pruebas adicionales de la ficha pasó **86/86**. La batería
completa incluye estas cuatro pruebas.

`git ls-files .venv-ml`: vacío. Búsqueda ampliada de saltos prohibidos en
`src` y `e2e`: vacía. `docs/tareas-del-usuario.md` conserva sus pasos sin
API de pago, incluyendo la cuenta del broker para el corto real. No se
han usado cuentas reales, enviado órdenes reales ni probado manualmente
un lector de pantalla. Las pruebas de integración usan los adaptadores
simulados acordados.
