# QA · Fase 4 · Señales informativas, panel y diario

## Alcance de la prueba

Se revisa el comportamiento entregado por la fase 4 en dos perfiles de usuario, con una batería automática de validación y un conjunto de pruebas de regresión E2E. La comprobación no corrige código de producto; documenta pruebas, resultados y fallos que deben resolver los roles responsables.

## Evidencias automáticas ejecutadas

- `npm run typecheck` → OK
- `npm run lint` → OK
- `npm test -- --run` → 116 archivos, 1413 pruebas correctas
- `npm run test:e2e` → 22 aprobadas, 1 fallida

## Capturas relevantes

- `docs/qa/capturas/fase-4-panel-1440.png`
- `docs/qa/capturas/fase-4-panel-700.png`
- `docs/qa/capturas/fase-4-diario-1440.png`
- `docs/qa/capturas/fase-4-diario-700.png`
- `docs/qa/capturas/fase-4-ajustes-1440.png`
- `docs/qa/capturas/fase-4-senales-fallo-1440.png`

## Sesión 1: Profesional independiente que organiza varios proyectos

- Pasos:
  1. Abrir la app y aceptar el aviso legal.
  2. Añadir los activos `SPY` y `QQQ` al seguimiento.
  3. Activar la estrategia semilla `Reversión RSI/Bollinger` y dejar que la ventana se cierre para que la evaluación siga en segundo plano.
  4. Avanzar el reloj al cierre de una vela nueva y comprobar panel, señales vivas y diario.
  5. Validar que el sistema emite notificación de señal y de límite.
- Esperado:
  - La nueva vela cierra y se genera una señal aprobada o, al menos, una decisión válida enlazada al diario.
  - El panel muestra señales vivas con motivo y confianza.
  - La entrada del diario referencia la `signalId` y no un veto sin vínculo.
  - Las notificaciones de señal y límite llegan con el contenido correcto.
- Observado:
  - La señal emitida queda vetada por `RR_TOO_LOW`, sin objetivo y con `target: null`.
  - El panel y el diario solo reflejan un veto con `signalId: null`.
  - No aparece ninguna señal aprobada; la prueba E2E falla en la comprobación de enlace al diario y de la notificación aprobada.
- Evidencia:
  - `e2e/signals-dashboard.spec.ts:58-230`
  - `npm run test:e2e` → 1 fallo en `e2e/signals-dashboard.spec.ts`
  - `test-results/signals-dashboard.png`
  - Error reproducible: `la señal no aparece enlazada en el diario; entradas: [{"type":"veto","signalId":null,"result":"vetada"}]`
- Resultado: `passed: false`

## Sesión 2: Responsable de equipo que revisa entregas

- Pasos:
  1. Abrir la app con el usuario de equipo y validar que se puede filtrar el diario por activo y resultado.
  2. Enviar una decisión de riesgo de prueba `AAPL` y comprobar la vista de detalle con motivo, datos usados y cumplimiento de reglas.
  3. Exportar el diario a CSV y validar columnas y filas.
  4. Ejecutar la rutina diaria simulada para comprobar los tres resúmenes (preapertura, cierre y conciliación).
  5. Revisar la restauración de copia y la rotación de registros con la batería de regresión.
- Esperado:
  - El diario presenta filtros y detalle del motivo y la regla aplicada.
  - El CSV exportado incluye cabecera y filas válidas.
  - Las tres rutinas aparecen como entradas del diario y notificaciones.
  - La restauración y la copia de seguridad tienen los mismos datos en una instalación limpia.
- Observado:
  - El filtrado, exportación CSV y rutina diaria cumplen las expectativas.
  - La restauración de backup también pasa.
  - La regresión real de la fase 4 está casi completa; los fallos se concentran en la generación automática de la señal de cierre de vela y en su trazabilidad.
- Evidencia:
  - `e2e/journal-export.spec.ts` → OK
  - `e2e/daily-routine.spec.ts` → OK
  - `e2e/backup-restore.spec.ts` → OK
  - `npm run test:e2e` → 22/23 pruebas OK; la única caída es la señal automática del perfil independiente.
- Resultado: `passed: true`

## Hallazgos confirmados

### Hallazgo 1 · La señal automática no se enlaza al diario y no se aprueba

- Severidad: high
- Rol: backend
- Persona: Profesional independiente que organiza varios proyectos
- Pasos:
  1. Activar estrategia válida en segundo plano.
  2. Cerrar una nueva vela con la ventana oculta.
  3. Esperar al motor de señales y consultar el panel y el diario.
- Esperado:
  - La evaluación emite una señal con `signalId` y razón suficiente para mostrarla en panel y diario.
  - La notificación de señal aprobada aparece.
- Observado:
  - La única entrada relevante es un veto con `signalId: null` y razón `RR_TOO_LOW`.
  - La decisión no llega a una señal aprobada ni al diario enlazado.
- Evidencia:
  - `e2e/signals-dashboard.spec.ts:223-230`
  - `e2e/signals-dashboard.spec.ts` expect soft falla con `la señal no aparece enlazada en el diario...`
  - `e2e/signals-dashboard.spec.ts` expect soft falla con `no hubo señal aprobada...`
  - `test-results/signals-dashboard.png`

### Hallazgo 2 · El motor de riesgo vetó la señal por objetivo ausente, no por una contradicción funcional

- Severidad: medium
- Rol: backend
- Persona: Profesional independiente que organiza varios proyectos
- Pasos:
  1. Ejecutar la señal automática en la nueva vela.
  2. Ver la decisión de riesgo del motor.
- Esperado:
  - La estrategia activa genera una señal válida con motivo/objetivo y confianza coherente.
- Observado:
  - El motor devuelve `RR_TOO_LOW` con `ratio: "sin objetivo"`, `mínimo: 2`.
  - Eso convierte la decisión en veto y bloquea la notificación aprobada.
- Evidencia:
  - `e2e/signals-dashboard.spec.ts` y el contexto de error de la ejecución E2E.
  - `decision.reasons[0].code === "RR_TOO_LOW"`

## Resumen para el equipo

- Se ejecutó la batería de validación del proyecto: typecheck, lint y unit test pasan en verde.
- La regresión E2E de la fase 4 queda en 22 pruebas correctas y 1 fallida.
- El único fallo reproducible está en la señal automática del perfil independiente, no en la exportación, la rutina diaria ni las copias.
- El problema principal aparece en la generación del cierre de vela con la ventana cerrada: la decisión se vetó por riesgo y no se enlaza al diario.
- El panel principal y el diario de la fase 4 quedan validados por la batería existente salvo este fallo concreto.
- El perfil de equipo pasa las pruebas de exportación CSV, resumen diario y restauración de copia.
- El perfil independiente no cumple la expectativa de “señal automática aprobada + diario enlazado + notificación”.
- El bloque funcional pendiente corresponde al backend del motor de señales y a la integración con la pasarela de riesgo.
- El área visual y la UI del panel/diario no se señala como causa principal; el ajuste requerido está en la lógica del cierre de vela y la trazabilidad con el diario.
- El entregable de documentación queda en `docs/qa/fase-4.md`; la captura del error queda en `docs/qa/capturas/fase-4-senales-fallo-1440.png`.
