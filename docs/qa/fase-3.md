# QA de regresión · Fase 3 — Motor de riesgo con veto

**Resultado:** regresión aprobada para los dos perfiles. Se repitieron los flujos en Electron con datos simulados y almacenamiento temporal aislado; no se modificó código de producto.

## Sesión · Profesional independiente que organiza varios proyectos

- **Pasos:** Abrí la app en la prueba E2E, acepté el aviso inicial y comprobé Mercado en estado vacío. Probé un ticker demasiado largo y confirmé el error de validación; añadí AAPL y comprobé que carga el gráfico y sus indicadores simulados. En la navegación estrecha enfoqué «Estrategias» y recorrí con Tab y Shift+Tab «Riesgo» y «Ajustes». Después abrí Riesgo, comprobé valores por defecto y probé 3 % por operación y ratio 1:1,5; envié señales sin stop y con ratio 1:1; activé y confirmé la parada manual; por último inyecté un evento IPC de alto impacto.
- **Esperado:** Los datos inválidos se rechazan; el teclado recorre los enlaces en orden; los límites fuera de margen muestran errores en línea; las señales vulnerables aparecen vetadas con el motivo legible; la parada bloquea nuevas señales hasta confirmación y el evento activa cautela.
- **Observado:** Todo lo anterior se cumplió. Los vetos `STOP_MISSING` y `RR_TOO_LOW` aparecen en el registro. La parada impide operar con «Parada activa» y requiere confirmación para reanudar. El evento «IPC EE. UU. (E2E)» activa «Modo cautela» y veta la señal. La señal limpia de AAPL se aprueba con tamaño de 100 unidades antes de inyectar el evento.
- **Evidencia:** `npm run test:e2e`, pruebas `e2e/market-chart.spec.ts:9` y `e2e/risk-engine.spec.ts:87,146,253`; salida: 19 pruebas E2E aprobadas.
- **Resultado:** Aprobada.

## Sesión · Responsable de equipo que revisa entregas

- **Pasos:** Verifiqué que existen `e2e/risk-engine.spec.ts` y `src/main/risk/__audit__/risk.audit.test.ts`. Ejecuté la validación general y revisé que la auditoría cubre reglas por operación, límites de pérdida/exposición, modo cautela, parada manual/automática, persistencia y cobertura del contrato.
- **Esperado:** La batería E2E de riesgo y la auditoría deben estar presentes y pasar; las pruebas deben cubrir cada límite exigido y cada causa automática de parada, con veto y motivo verificables.
- **Observado:** Ambas rutas existen. La auditoría comprueba falta de stop, ratio menor de 1:2, tamaño dependiente de la distancia al stop, pérdidas diaria/semanal/mensual, drawdown, posiciones, exposiciones, correlación, apalancamiento y liquidez, además de cautela y causas de parada. `MAX_DRAWDOWN` se verifica en el evaluador de límites, ya que la pasarela activa antes la parada por pérdida anómala en ese escenario. Las cuatro pruebas E2E de riesgo pasan.
- **Evidencia:** `npm test`: 93 archivos y 1180 pruebas aprobadas; `npm run typecheck` y `npm run lint` aprobados; `npm run test:e2e`: 19/19 aprobadas. Casos en `src/main/risk/__audit__/risk.audit.test.ts:189-625` y `e2e/risk-engine.spec.ts:87-291`.
- **Resultado:** Aprobada.

## Regresión de los problemas anteriores

- **[high] Falta la batería E2E y la auditoría del motor de riesgo de la Fase 3:** resuelto. Las dos rutas ahora existen y pasan en la suite.
- **[medium] La suite E2E general falla por un problema de foco del teclado en la UI:** resuelto. `e2e/market-chart.spec.ts` verifica el orden actual de navegación, «Estrategias» → «Riesgo» → «Ajustes», en ambos sentidos; la prueba pasa en la suite completa.

## Comprobaciones no realizadas en este entorno

La prueba de Electron no sustituye las comprobaciones manuales de bandeja y notificaciones del sistema en macOS, Windows y Linux, ni una desconexión real de más de 60 segundos con la ventana en segundo plano. Esas comprobaciones corresponden al usuario y no se consideran fallos del producto en este informe.

## Hallazgos

No se encontraron problemas de producto en esta regresión.
