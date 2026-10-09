# QA · Fase 4 · Señales y posiciones simuladas

## Auditoría

Auditoría del motor de señales y la cartera simulada en el proceso principal; no se modificó código de producción. Los casos corren sobre el motor y el tracker con dependencias controladas y datos de velas simuladas.

### Sesión: Profesional independiente que organiza varios proyectos

- **Pasos:** se propuso una señal válida para AAPL; se simuló un error transitorio de la pasarela de riesgo, se comprobó que no se persistió una señal y se repitió la evaluación de la misma vela tras recuperar la pasarela. También se evaluó con pausa y parada de emergencia activas.
- **Esperado:** ninguna señal se guarda sin una decisión obtenida del motor de riesgo; en pausa o parada no se emiten señales; una interrupción temporal de riesgo no debe hacer que una señal desaparezca permanentemente.
- **Observado:** no se guardó señal sin decisión y las guardas no emitieron señales. Hallazgo: el error de riesgo deja marcada la vela y una repetición de ese cierre se rechaza como ya procesada, por lo que no puede recuperarse esa señal.
- **Evidencia:** `npx vitest run src/main/signals/__audit__/signals.audit.test.ts` (12 pruebas correctas); caso «reproduce la pérdida de una vela al fallar la pasarela de riesgo». `src/main/signals/engine.ts:445` marca la vela antes de `emitSignal`, y `src/main/signals/engine.ts:504-525` captura el error sin quitar la marca. Seguimiento: [#7](https://github.com/Dregos13/tradia/issues/7).
- **Resultado de sesión:** `passed: false`.

### Sesión: Responsable de equipo que revisa entregas

- **Pasos:** se dieron votos largo/corto incompatibles sobre el mismo activo y cierre; se repitió el mismo cierre; se verificaron los datos/versiones/motivo/confianza guardados tras una decisión, varios tamaños reducidos por riesgo, y velas que tocan stop y objetivo a la vez.
- **Esperado:** contradicción y duplicado sin señal adicional; cada señal persistida tiene decisión, procedencia, versión, motivo y confianza entre 0 y 1; el tracker conserva exactamente el tamaño asignado por riesgo y prioriza el stop.
- **Observado:** todos esos invariantes se cumplen. ESLint acepta los imports de `signals/` y mantiene la prohibición de importar escritores de riesgo.
- **Evidencia:** `src/main/signals/__audit__/signals.audit.test.ts` (12/12); `npm run typecheck` correcto; `npm run lint` correcto; `npm test` correcto (113 archivos, 1386 pruebas). La regla de solo lectura está en `eslint.config.mjs:48-63`.
- **Resultado de sesión:** `passed: true`.

### Hallazgos

#### QA-1 · Se pierde la evaluación si la pasarela de riesgo falla temporalmente

- **Gravedad:** media · **Rol:** backend.
- **Reproducción:** activar una estrategia con una propuesta válida para un activo y fecha; hacer que `submitSignal` falle temporalmente; restablecerlo y volver a entregar la misma vela.
- **Esperado:** reintentar la vela porque no se obtuvo una decisión de riesgo.
- **Observado:** `evaluateTicker` devuelve `error` en el primer intento y `already-processed` en el segundo; no existe señal en `signals`. `markProcessed` se ejecuta antes de llamar a la pasarela.
- **Evidencia:** `src/main/signals/engine.ts:403-405`, `445` y `504-525`; prueba de guardado seguro ante fallo de pasarela en `src/main/signals/__audit__/signals.audit.test.ts`. Bug abierto: [#7](https://github.com/Dregos13/tradia/issues/7).
- **Corrección:** resuelto. `markProcessed` ya no se ejecuta antes de la pasarela: la marca solo se escribe cuando la evaluación llega a un resultado definitivo (señal persistida, contradicción o evaluación completa sin votos). Un fallo temporal de `submitSignal` o de la persistencia deja la vela sin marcar y la reentrega del mismo cierre reintenta la evaluación (en el primer intento `error` con entrada `error` en el diario; al repetir, `emitted`). La misma regla cubre los fallos de evaluación de estrategia (un `no-votes` con errores no marca). Regresión cubierta por el caso «reintenta la vela tras un fallo temporal de la pasarela de riesgo» de `signals.audit.test.ts` y por dos casos de `engine.test.ts`.

### Resultado de la batería

- `npx vitest run src/main/signals/__audit__/signals.audit.test.ts`: 1 archivo, 12 pruebas correctas.
- `npm run typecheck`: correcto.
- `npm run lint`: correcto; comprobada también la regla de imports restringidos para todos los archivos `src/main/signals/**/*.ts`.
- `npm test`: 113 archivos, 1386 pruebas correctas.

La auditoría no sustituye la prueba E2E de la app completa ni las comprobaciones de notificación real en los tres sistemas operativos; estas comprobaciones quedan fuera de esta tarea.
