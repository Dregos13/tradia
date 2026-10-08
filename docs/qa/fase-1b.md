# QA — Fase 1b · Noticias, fuentes y calendario

**Fecha:** 2026-10-08  
**Entorno:** macOS; Electron en modo `TRADIA_E2E`, SQLite temporal, servidor RSS local y fixtures. No se usaron claves ni endpoints reales.  
**Resultado:** suites automáticas aprobadas. No se encontraron fallos reproducibles del producto en el alcance ejecutado. Quedan límites de cobertura de la API desde la interfaz y de la bandeja/notificación nativa, detallados abajo.

## Criterios de aceptación

| # | Criterio | Resultado | Evidencia |
| --- | --- | --- | --- |
| 1 | Typecheck, lint, pruebas, reglas de prioridad máxima/media/por activo y redes nunca confirmadas | **APROBADO** | `npm run typecheck`, `npm run lint` y `npm test -- --reporter=dot` terminaron correctamente; 59 archivos y 745 pruebas aprobadas. `src/main/news/priority.test.ts` cubre las tres prioridades y la confirmación; la prueba integrada comprueba que una noticia solo de redes queda sin confirmar y no manda aviso crítico. |
| 2 | Añadir RSS local desde Fuentes, probar conexión, ver titulares completos y dejar de consultar tras quitar la fuente | **APROBADO** | `e2e/news-phase.spec.ts:247`: alta por interfaz; URL inexistente y feed vacío; prueba correcta; titular largo limitado; fecha, fuente, fiabilidad, prioridad y AAPL relacionados; retirada confirmada con teclado y cero titulares nuevos desde esa fuente. Capturas: [Fuentes tras el alta](capturas/fase-1b-fuentes-rss-anadida.png), [feed RSS](capturas/fase-1b-feed-rss.png) y [estado tras retirar](capturas/fase-1b-feed-tras-retirada.png). |
| 3 | Fuentes oficiales de prueba y deduplicación con ambas fuentes visibles | **APROBADO** | `e2e/news-phase.spec.ts:328`: feed simulado comprueba Fed, BCE, BLS, BEA, SEC EDGAR 8-K, SEC EDGAR Form 4 y CNMV como oficiales; el mismo comunicado Fed/BCE aparece una vez con ambas fuentes. Captura: [feed oficial](capturas/fase-1b-fuentes-oficiales.png). |
| 4 | Eventos de la semana con impacto; fechas de NFP, EIA y triple witching según reglas de pruebas | **APROBADO** | E2E recorre los eventos de la semana actual y exige nivel de impacto en cada uno. `src/main/news/calendar/rules.test.ts` verifica fechas de NFP, miércoles y festivos de EIA y fechas de triple witching, incluido el ajuste por Juneteenth. Captura: [calendario semanal](capturas/fase-1b-calendario-semana.png). |
| 5 | Actualización y avisos con ventana cerrada, registrados por E2E | **PARCIALMENTE VERIFICADO** | `e2e/news-phase.spec.ts:328` oculta la ventana, comprueba que el feed recibe una noticia crítica y verifica en `notification_log` el aviso de noticia y el aviso previo a un evento alto. La prueba sustituye `Electron Notification` por un registro de prueba y no comprueba el icono/menú real de bandeja; por tanto no acredita entrega nativa ni permanencia visible en bandeja. |

## Ejecuciones

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | Aprobado. |
| `npm run lint` | Aprobado. |
| `npm test -- --reporter=dot` | 59 archivos; 745/745 pruebas aprobadas. |
| `npm run test:e2e` | Build aprobado; 11/11 pruebas E2E aprobadas, incluidas las dos rutas de noticias. |
| `npx vitest run src/main/news/__integration__/news-alerts.integration.test.ts src/main/news/priority.test.ts src/main/news/poller.test.ts src/main/news/alerts.test.ts` | Ejecución previa registrada: 161 pruebas aprobadas. La suite completa actual volvió a ejecutar y aprobar esas pruebas. |

La integración `src/main/news/__integration__/news-alerts.integration.test.ts` usa SQLite en memoria, conectores reales con respuestas `fetch` simuladas y reloj falso. Cubre persistencia del RSS, deduplicación RSS/Finnhub con ambas fuentes, confirmación de comunicados oficiales, rumor social sin confirmación ni aviso crítico, aviso único a 30 minutos y recuperación tras desconexión. Finnhub queda ejercitado en integración, pero **no se completó un alta de API financiera desde la pantalla Fuentes** en el recorrido E2E de interfaz.

## Sesiones por perfil

### Profesional independiente que organiza varios proyectos — incompleta (`passed: false`)

1. Acepté el aviso inicial, añadí AAPL a la lista de seguimiento y abrí Fuentes.
2. Probé una URL RSS inexistente y una respuesta RSS vacía; después probé y añadí un feed local válido clasificado como agencia.
3. Revisé los titulares normales y largos; comprobé fecha, fuente, fiabilidad, prioridad y activo relacionado.
4. Quité la fuente usando el diálogo con teclado y comprobé que un titular nuevo del endpoint eliminado no se importara.
5. Verifiqué por separado en integración la ingestión desde Finnhub y la deduplicación con RSS; no añadí la API desde la interfaz.

- **Esperado:** configurar RSS y API, filtrar por activos, revisar metadatos y que quitar una fuente detenga nuevas lecturas.
- **Observado:** recorrido E2E RSS aprobado, incluidos errores, feed vacío, titular largo, filtro/activo AAPL, retirada y navegación con Tab/Enter. La API se probó a nivel de integración, no como alta interactiva; no doy por cubierto ese paso del perfil.
- **Evidencia:** `e2e/news-phase.spec.ts:247`; `src/main/news/__integration__/news-alerts.integration.test.ts`; capturas RSS enlazadas en el criterio 2.

### Responsable de equipo que revisa entregas — incompleta (`passed: false`)

1. Añadí AAPL y apunté las fuentes oficiales de prueba a feeds RSS locales.
2. Revisé los comunicados oficiales y el duplicado compartido entre Fed y BCE.
3. Abrí Calendario, confirmé que había eventos de la semana y que todos mostraban impacto.
4. Cerré la ventana y comprobé que el feed recibía una noticia crítica; adelanté el reloj E2E y revisé los avisos de noticia crítica y evento de alto impacto en el registro.
5. Comprobé las reglas de prioridad/confirmación y las fechas de reglas calendáricas con las pruebas unitarias.

- **Esperado:** metadatos fiables, ninguna noticia solo de redes confirmada, eventos semanales con impacto y avisos persistentes con la ventana cerrada.
- **Observado:** feeds oficiales, deduplicación, calendario e historial de avisos aprobados. El test reemplaza la notificación Electron por un mock y solo acredita que la ventana no está visible, no el icono/menú de bandeja ni la recepción nativa del sistema operativo.
- **Evidencia:** `e2e/news-phase.spec.ts:328`; `src/main/news/priority.test.ts`; `src/main/news/calendar/rules.test.ts`; `src/main/news/__integration__/news-alerts.integration.test.ts`; capturas oficial y calendario enlazadas en los criterios 3–4.

## Límites y comprobaciones pendientes

- La notificación nativa con Tradia en la bandeja no se probó en macOS, Windows ni Linux; las verificaciones de esta sesión son de registro E2E con `Notification` simulado.
- El E2E cierra/oculta la ventana, pero no afirma el estado del icono ni las acciones del menú de bandeja.
- El perfil profesional no ejercitó el alta de Finnhub desde la interfaz; el conector y deduplicación se probaron mediante integración.
- No se consultaron fuentes oficiales reales, claves de Finnhub/Alpha Vantage/NewsAPI ni GDELT en vivo; no se compararon fechas económicas con publicaciones actuales de organismos. Son comprobaciones manuales reservadas al usuario.
- La captura de Fuentes se tomó tras guardar (el formulario aparece vacío y la fila queda fuera del área visible); la aserción E2E comprueba la fila guardada. La captura del calendario muestra el rango semanal; la aserción comprueba cada evento y su nivel de impacto.

## Hallazgos

**Fallos reproducibles del producto:** ninguno. Las limitaciones anteriores son comprobaciones no ejecutadas o alcance del test, no defectos confirmados.
