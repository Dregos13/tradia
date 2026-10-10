# Dinero real (fase 7): lista de comprobación y bloqueo

El modo real está **bloqueado por defecto** y solo se activa cuando la
lista de comprobación de la sección 18 del plan (criterio §4.4 de
`docs/alcance.md`) está completa y los límites escritos se han confirmado
por escrito. La puerta vive entera en el proceso principal: ni la
interfaz ni un cliente IPC puede forzarla.

Piezas: `src/main/live/checklist.ts` (evaluadores puros de cada
requisito y sus umbrales), `service.ts` (almacén, estado del modo real,
declaraciones, límites, activación y suspensión), `index.ts`
(`registerLive`: cableado de dependencias y canales `live:*`) y las
tablas de la migración 011 (`live_checklist`, `live_limits`,
`live_mode`).

## Los siete requisitos

| Requisito | Origen | Qué lo cumple |
| --- | --- | --- |
| `validacion-fuera-muestra` | Automático | Todas las estrategias candidatas (estado `paper` o `activa`) tienen un run `prueba-final` guardado en su versión vigente. |
| `paper-continuo` | Automático | ≥ 91 días entre la primera y la última orden paper ejecutada, ≥ 30 operaciones cerradas (par entrada/salida) y desviación relativa del resultado frente a la expectativa del backtest dentro de ±30 %. |
| `parada-probada` | Automático | Una prueba de parada correcta en los últimos 30 días: la acción `live:test-kill-switch` (activa y reanuda la parada real) o cualquier reanudación registrada en `kill_switch_events`. |
| `alertas-activas` | Automático | Un envío de prueba correcto por Telegram o correo (`delivery:test`, anotado en `delivery.lastTestSuccess`) cuyo canal siga activo y configurado. |
| `claves-sin-retirada` | Declaración | `live:declare` con el texto fijo y fecha (el usuario no lo escribe a mano). |
| `plan-contingencia` | Declaración | Igual, con nota o enlace local opcional al plan. |
| `revision-legal` | Declaración | Igual. |

Los cuatro automáticos se evalúan en el proceso principal en cada
consulta (`live:checklist`, `live:state`), en cada mutación y en la
rutina (`reevaluate()`): **nunca se marcan desde IPC** — `live:declare`
solo acepta las tres declaraciones y `live:seed-progress` solo existe en
modo E2E. Las declaraciones guardan el texto suscrito, el detalle y la
fecha; retirarlas (`confirmed: false`) las devuelve a pendiente.

## Límites escritos y techos fijos

`live:set-limits` guarda los cuatro límites siempre que sean positivos y
no superen los techos fijos de la fase (`LIVE_FIXED_CAPS`: 1 000 USD de
capital, 200 USD por orden, 20 USD de pérdida diaria y 2 posiciones). La
validación se aplica tres veces: guarda `isLiveLimitsInput` en el borde,
doble comprobación en el servicio y CHECK en `live_limits`. Guardarlos
reinicia la confirmación escrita y devuelve la frase exacta generada con
esos valores (`liveConfirmationPhrase`).

`live:activate` exige, en este orden: lista completa, límites guardados
y la frase escrita literal (solo ignora espacios en los extremos). Con
todo en regla marca los límites como confirmados (`confirmados_en`) y
pasa el modo a `activo`. Un intento fallido **no lanza excepción**:
devuelve `activated: false`, la lista exacta de requisitos pendientes y
los motivos legibles, y queda en el Diario.

## Estados y suspensión

`live_mode.estado`: `bloqueado` (falta algo), `listo` (lista completa y
límites guardados, aún no activado), `activo`, `suspendido`. Los dos
primeros se derivan en cada evaluación; los dos últimos persisten.

El modo `activo` se suspende (`suspendido`, sin órdenes nuevas) cuando:

- salta la parada de emergencia (`risk:changed` con la parada activa →
  `parada-emergencia`);
- se pierde la conexión (`connectivity:changed` en `offline` →
  `sin-conexion`);
- un requisito deja de cumplirse — parada vencida, canal de alertas
  desactivado, una declaración retirada o los límites cambiados — en la
  siguiente evaluación o mutación (`requisito-vencido`).

Cada suspensión escribe el Diario, envía una notificación crítica que
abre «Dinero real» y emite `live:changed`. **Nunca se reactiva solo**:
volver a `activo` exige `live:activate` con la lista vigente y la frase
correcta (si los límites cambiaron, la frase es otra). `live:deactivate`
devuelve a `listo`/`bloqueado` al instante y conserva todo el historial.

## Auditoría

Todo paso queda en el Diario (`journal_entries`): cada declaración, los
límites guardados con su comprobación de techos, cada activación
rechazada con los motivos, la activación con los límites confirmados, la
prueba de parada, cada suspensión y la vuelta a paper.

## Canales registrados aquí

`live:checklist`, `live:state`, `live:declare`, `live:set-limits`,
`live:activate`, `live:deactivate`, `live:test-kill-switch` y, solo con
`TRADIA_E2E` sin empaquetar, `live:seed-progress`. Los canales
`live:connect`, `live:smoke-test`, `live:scaling` y
`live:use-simulated-broker` los registran sus propias tareas
(`be-broker-real`, `be-prueba-humo-escalado`).

## Cableado y evidencia externa

`registerLive(ctx)` toma del contexto: `storage` (migración 011),
`settings` (evidencia `live.evidence` y `delivery.config`), `broker`
(órdenes ejecutadas), `backtest` (expectativa por estrategia),
`killSwitch` (la acción «Probar parada» lo ejerce de verdad), `secrets`
(`hasCredentials` de la ranura live), `journal`, `notifications` y
envuelve `ctx.broadcast` para ver la parada y la conexión. Debe
registrarse después de `killSwitch`, `broker`, `backtest`, `delivery`,
`journal` y `settings` (lo hace `be-servicios-ipc-e2e`).

El servicio de entrega anota cada `delivery:test` correcto en
`settings['delivery.lastTestSuccess']` (`{channel, at}`) — es la
evidencia de `alertas-activas` y se verifica de nuevo contra
`delivery.config`: si el canal probado se desactiva, el requisito vuelve
a pendiente.

## Riesgo que queda

- La prueba de parada ejerce la parada real (pausa agentes y notifica)
  antes de reanudarla: es deliberado — es la única forma honesta de
  probarla — y se rechaza si la parada ya estaba activa o el modo real
  está activo.
- «Paper continuo» se mide entre la primera y la última orden ejecutada;
  una cuenta con meses de inactividad al final podría sobrestimar la
  continuidad. La evidencia del requisito muestra los números tal cual.
- La evidencia sembrada (`live:seed-progress`) solo existe en E2E; en la
  app empaquetada el canal no está registrado.
