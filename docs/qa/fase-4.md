# QA · Fase 4 · Señales informativas, panel y diario

## Alcance y rectificación

Este informe recoge la batería automática y los escenarios de los dos perfiles de usuario. No acredita sesiones con usuarios reales: el canal del equipo indica que ambos perfiles estaban sin sesión. Las comprobaciones con servicios y notificaciones reales siguen correspondiendo al usuario.

La revisión independiente rectifica el diagnóstico inicial: el fallo de `e2e/signals-dashboard.spec.ts` era un defecto de la prueba, no una pérdida de trazabilidad del motor. Se retira la incidencia funcional y la captura que la presentaba como tal. La corrección de la prueba corresponde a la tarea de backend; su resultado posterior debe distinguirse de la ejecución histórica siguiente.

## Evidencias automáticas históricas

- `npm run typecheck` → OK.
- `npm run lint` → OK.
- `npm test -- --run` → 116 archivos, 1413 pruebas correctas.
- `npm run test:e2e` → 22 aprobadas, 1 fallida en la ejecución original.
- La revisión independiente repitió typecheck, lint y las pruebas unitarias, y reprodujo los dos errores de aserción de la spec de señales sobre una compilación nueva. No repitió el resto de la batería E2E.

El 22/23 describe la ejecución anterior a la corrección; no es evidencia de un fallo funcional ni de una nueva ejecución en verde.

## Validación de esta rectificación documental

El 9 de octubre de 2026 se ejecutaron `npm run typecheck`, `npm run lint` y `npm test`: todos pasan, con 116 archivos y 1413 pruebas. `git diff --check` pasa y no quedan referencias al archivo de captura retirado en docs, scripts ni E2E. Esta tarea no modifica ni vuelve a ejecutar la spec E2E, cuya corrección está asignada a backend.

## Capturas relevantes

- `docs/qa/capturas/fase-4-panel-1440.png`
- `docs/qa/capturas/fase-4-panel-700.png`
- `docs/qa/capturas/fase-4-diario-1440.png`
- `docs/qa/capturas/fase-4-diario-700.png`
- `docs/qa/capturas/fase-4-ajustes-1440.png`

Se retira la captura del supuesto fallo de señales: mostraba el resultado de una consulta con un ticker incorrecto y no demostraba que faltara la entrada de la señal automática.

## Escenario 1: Profesional independiente que organiza varios proyectos

1. Abrir la app y aceptar el aviso legal.
2. Añadir `SPY` y `QQQ` al seguimiento.
3. Activar `Reversión RSI/Bollinger`, ocultar la ventana y avanzar el reloj al cierre de una vela nueva.
4. Comprobar la señal emitida, el panel y su entrada de diario por ticker e identificador de la señal.
5. Comprobar la notificación de señal vetada y el aviso de límite.

La señal automática observada fue de **QQQ**, vetada por `RR_TOO_LOW`, con `target: null`. Es el resultado esperado de la estrategia semilla sin objetivo bajo un mínimo de beneficio/riesgo de 2. La aprobación no es una condición de éxito de este escenario.

El motor registra la señal como una entrada de tipo `senal`, con `signalId: signal.id`, motivo, datos usados, referencias de estrategia, resultado y comprobaciones de riesgo (`src/main/signals/engine.ts`, bloque `recordJournal` posterior a `insertSignal`). La revisión sustentó el ticker en el log del proceso principal y el enlace en el código; no consultó directamente la entrada de QQQ.

La prueba original consultaba `journal.list({ ticker: 'SPY', limit: 1000 })`. Encontraba el veto manual de SPY, generado mediante `risk.submitSignal`, cuyo `signalId: null` no demuestra un defecto de la señal automática de QQQ. Además, exigía simultáneamente una señal vetada y una notificación «Señal aprobada».

Resultado histórico: E2E fallido por dos expectativas incorrectas. La rectificación documental elimina la atribución al motor. La regresión de la spec corregida debe verificar la entrada `senal` enlazada y la notificación coherente con el veto.

## Escenario 2: Responsable de equipo que revisa entregas

1. Filtrar el diario por activo y resultado.
2. Enviar una decisión de riesgo de prueba de `AAPL` y consultar motivo, datos usados y cumplimiento de reglas.
3. Exportar el diario y validar cabecera y filas del CSV.
4. Ejecutar preapertura, cierre y conciliación con reloj simulado y comprobar entradas y notificaciones.
5. Restaurar una copia en un directorio limpio y comprobar la rotación de registros.

La ejecución original informó resultados correctos para filtrado, detalle, CSV, rutina diaria y restauración. Evidencias: `e2e/journal-export.spec.ts`, `e2e/daily-routine.spec.ts` y `e2e/backup-restore.spec.ts`. La revisión independiente no volvió a ejecutar estas specs; mantiene como referencia el informe de testing.

## Incidencia de la prueba y corrección

### Filtro de ticker y expectativa de notificación incorrectos

- Clasificación: defecto del E2E; se retira la clasificación de fallo funcional del motor.
- Archivo: `e2e/signals-dashboard.spec.ts`.
- Causa: consulta de SPY para comprobar una señal de QQQ y expectativa de aprobación incompatible con el veto previamente exigido.
- Corrección: consultar por el ticker emitido (o sin filtro de ticker), exigir `entry.type === 'senal'` y el `signalId` de la señal emitida, y comprobar la notificación de veto.
- Validación de cierre: ejecutar la spec corregida y la batería general hasta obtener 23/23. El resultado posterior se debe registrar con la evidencia del responsable de la corrección, sin sustituir silenciosamente el resultado histórico.

El veto `RR_TOO_LOW` por objetivo ausente es una decisión válida de la pasarela de riesgo, no una segunda incidencia. No requiere modificar el motor para forzar una aprobación.

## Cobertura pendiente y comprobaciones del usuario

La señal aprobada generada automáticamente en segundo plano no estaba cubierta por este escenario original. La aprobación se cubre en pruebas unitarias del motor y en `e2e/risk-engine.spec.ts`; ello no equivale a observar una aprobación automática con la ventana oculta.

Siguen pendientes las comprobaciones del usuario de notificaciones nativas en macOS, Windows y Linux, Telegram y SMTP reales, los tres resúmenes durante un día de mercado, restauración entre instalaciones y revisión visual con Tiingo y FRED reales.

## Resumen para el equipo

- El diagnóstico inicial de pérdida de trazabilidad era incorrecto y queda retirado.
- El fallo histórico 22/23 corresponde a la prueba de señales.
- La señal automática observada era QQQ; la consulta original filtraba SPY.
- El veto manual de SPY sin `signalId` no era la entrada de esa señal.
- El motor registra la entrada `senal` con el identificador de la señal.
- El veto por objetivo ausente es coherente con la estrategia y los límites.
- La expectativa de notificación aprobada contradecía el veto esperado.
- La captura del supuesto fallo se retira para evitar evidencia engañosa.
- Backend corrige la spec y aporta la evidencia de regresión posterior.
- Las validaciones con servicios reales permanecen a cargo del usuario.
