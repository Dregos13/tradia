# Rutina diaria de los agentes (fase 4)

`src/main/routine/` corre tres tareas en segundo plano, en horario
`America/New_York` (`ROUTINE_TIMEZONE`, configurable por
`routine:get-config`/`routine:set-config`; por defecto
`ROUTINE_DEFAULTS`):

| Rutina | Hora por defecto | Contenido |
| --- | --- | --- |
| `preapertura` | 08:30 | Noticias publicadas desde el cierre de la sesión anterior (ordenadas por prioridad; las 'baja' no cuentan como relevantes), eventos del calendario del día y huecos de apertura de la watchlist (apertura de la última vela frente al cierre previo, ≥ `ROUTINE_GAP_MIN_PCT` = 1 %, valores ajustados si existen). |
| `cierre` | 16:15 | Señales del día (aprobadas/reducidas), vetos, posiciones simuladas abiertas y drawdown de la cartera. |
| `conciliacion` | 17:30 | Cuadra señales ↔ posiciones simuladas ↔ diario ↔ curva de capital y anota cada discrepancia como entrada 'error' del diario. |

Reglas:

- **Solo sesiones de negociación**: fines de semana y festivos NYSE se
  omiten (`market/calendar.ts`). En cierres anticipados corren a su hora.
- **«Como mucho una vez al día»**: `routine_runs` (migración 008) reserva
  (rutina, dia) antes de generar — ni un despertar tardío ni dos
  evaluaciones seguidas duplican el envío. `journal_id` enlaza la entrada
  'resumen' correspondiente.
- **Recuperación**: si la hora pasó sin enviar (equipo suspendido, app
  cerrada), la siguiente evaluación (temporizador, `powerMonitor` resume o
  `routine:advance-clock`) la envía marcada «con retraso»: flag
  `con_retraso`, marca « Enviado con retraso.» en el cuerpo y resultado
  'con-retraso' en el diario. Hay un margen de
  `ROUTINE_LATE_GRACE_MS` (1 min) para el jitter del temporizador. Solo se
  recupera el día en curso: resúmenes de días pasados no se reenvían.
- **Salida**: cada tarea graba una entrada 'resumen' del diario (datos
  completos en `datos`, resultado 'completado'/'con-retraso') y envía el
  aviso `resumen-diario` por los canales activos
  (`delivery.sendEvent`): escritorio siempre, Telegram y correo si están
  activados y suscritos.
- **Fallos**: una tarea que lanza no bloquea a las demás; queda una
  entrada 'error' en el diario y el log.

Conciliación — qué se comprueba (`reconcileDay`):

1. Toda señal del día aprobada/reducida con tamaño tiene posición
   simulada enlazada (`senal_id`).
2. Toda posición cerrada en el día tiene su entrada 'operacion' en el
   diario (`datos.posicionId`).
3. Toda 'operacion' del día referencia una posición existente y su P&L
   cuadra con `(salida − entrada) × tamaño` (tolerancia
   `RECONCILE_TOLERANCE` = 0,01).
4. Cada instante de cierre del día tiene su punto en la curva de capital
   y la variación del punto cuadra con el P&L sumado de esos cierres.

Reloj inyectable (`RoutineClock`, mismo patrón que market/news) y
temporizadores inyectables; en modo E2E `routine:advance-clock` adelanta
el reloj y reevalúa al instante.
