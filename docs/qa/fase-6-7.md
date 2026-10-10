# QA · Fase 6-7 · IA predictiva y capital mínimo real

_Testing · recorridos por perfil de usuario · 11-10-2026_

## Alcance y entorno

- **Cómo se probó:** recorridos en la app Electron real (`electron-vite build` + Playwright `_electron`), con `TRADIA_E2E=1`. Se usó la base común `e2e/phase-6-7.helpers.ts`:
  - reloj de mercado anclado al 06-10-2026;
  - datos de usuario temporales por sesión;
  - servidor local para la conectividad y para los feeds RSS de la prueba.
- **Ganchos usados:**
  - `ai:simulate-regime`, solo en el Perfil A;
  - `ai:simulate-drift`;
  - `live:seed-progress`, para la evidencia que solo da el tiempo (meses de paper, prueba final y alerta externa);
  - `live:use-simulated-broker`: es el adaptador Alpaca Live contra el servidor falso, que ejecuta a 250 USD.
- **Qué no se tocó:** no se introdujeron claves reales, no se envió ninguna orden fuera del equipo y no se modificó código del producto.
- **Guiones exploratorios:** los recorridos se automatizaron con dos especificaciones temporales (`qa-fase-6-7-perfil-a/b.spec.ts`). Anotan lo que ven en lugar de detenerse en el primer fallo. Se retiraron de `e2e/` al terminar para no alterar la batería.
- **Capturas:** todas las de este informe son de la app ejecutada, a 1440 × 900, y están en `docs/qa/capturas/fase-6-7-qa-*.png`. Las capturas `fase-6-7-*.png` sin `qa` son de la tarea de E2E y se citan cuando aplican.

> **Nota sobre los datos del entorno E2E.** Las fuentes de noticias por defecto (SEC, Fed, BCE…) también se consultan en red durante la sesión. Por eso el feed incluye titulares reales además de los de la prueba. No afecta a las conclusiones, pero conviene saberlo al leer las capturas de Noticias.

---

## Perfil A · Profesional independiente que organiza varios proyectos

Sigue cuatro carteras (índices SPY y QQQ; valores AAPL y MSFT). Quiere saber en qué régimen está cada una y qué dicen las predicciones, entender por qué el modelo «no es apto», leer el sentimiento de las noticias y, por último, intentar pasar a dinero real sin haber completado la lista.

| # | Paso | Esperado | Observado | Evidencia |
| --- | --- | --- | --- | --- |
| A1 | Abre **IA** antes de seguir ningún activo | Estado vacío claro | «Todavía no hay cierres suficientes…», «Aún no hay estimaciones». Todas las estrategias salen **«Activa por régimen»**, incluida la que «falla en Tendencia». El motivo dice «Todavía no hay régimen calculado» (ver P11) | [ia-vacia](capturas/fase-6-7-qa-a-ia-vacia.png) |
| A2 | Añade SPY, QQQ, AAPL y MSFT; el mercado queda fijado en Lateral · Volatilidad alta | Régimen del mercado y de cada activo; estrategias activadas o desactivadas según su ficha | Régimen del mercado con referencia SPY y métricas ADX y volatilidad. Tabla por activo con «Cambio anterior». Cruce de medias, Ruptura y Momentum salen «Desactivada por régimen» («Solo funciona en Tendencia…»); RSI/Bollinger, «Activa». ✔ | [ia-regimen-carteras](capturas/fase-6-7-qa-a-ia-regimen-carteras.png), [ia-estrategias](capturas/fase-6-7-qa-a-ia-estrategias.png) |
| A3 | Revisa las predicciones de su seguimiento y filtra MSFT | Probabilidad vigente de subida y bajada a 5 sesiones y volatilidad por activo | La tabla mezcla **todo el histórico**: 50 filas, unas 12 por activo, sin marcar cuál es la vigente. El diseño muestra una sola por activo (**P3**) | [ia-predicciones](capturas/fase-6-7-qa-a-ia-predicciones.png) |
| A4 | Pulsa «Ver ficha del modelo» en una predicción | Baja a la ficha | Navega a **Inicio** («Estado del sistema») (**P2**) | [enlace-ficha-modelo](capturas/fase-6-7-qa-b-enlace-ficha-modelo.png) |
| A5 | Lee la ficha para entender el «no apto» | Versión, horizonte, periodos, Brier frente a la referencia, calibración y por qué no es apto | v0.1.0, 5 sesiones, entrenamiento, calibración y prueba (60/20/20). Brier 0,197 frente a 0,25. Diagrama con tabla accesible. La insignia «Datos sintéticos · no apto» y el texto «La mejora no elimina el bloqueo: el origen es sintético… no puede influir en señales» lo explican bien. «Copiar hash» → «Hash copiado.» ✔ | [ficha-modelo-no-apto](capturas/fase-6-7-qa-a-ficha-modelo-no-apto.png) |
| A6 | Ingiere titulares: dos de agencia (AAPL+, MSFT−), uno de 190 caracteres sobre AAPL y MSFT, uno de la Fed sin activo y un rumor de redes sobre MSFT | Resumen y sentimiento por activo de los confirmados; el rumor, sin analizar | AAPL «Favorable», MSFT «Desfavorable». El titular largo da dos análisis (AAPL y MSFT, favorables) y se ajusta sin desbordar. La Fed, sin activo: «Sin análisis disponible». El rumor: «Sin verificar · no genera señales», sin análisis. ✔. Ya documentados por E2E: «(abre en el navegador externo)» visible, y el método «LLM» con el resumen «Análisis local del titular» | [noticias](capturas/fase-6-7-qa-a-noticias.png), [titular-largo](capturas/fase-6-7-qa-a-noticias-titular-largo.png), [sin-activo](capturas/fase-6-7-qa-a-noticias-sin-activo.png) |
| A7 | Abre **Dinero real** sin cumplir nada | Bloqueado y con cada requisito pendiente | «Dinero real bloqueado · faltan 7 de 7 requisitos». Cada requisito sale «Pendiente» con su evidencia. El panel «No se puede activar todavía» enumera los 7 motivos, más claves y límites. El botón está deshabilitado y con `aria-describedby` a la lista de motivos. ✔ | [dinero-real-bloqueado](capturas/fase-6-7-qa-a-dinero-real-bloqueado.png) |
| A8 | Recorre la pantalla con Tab | Orden lógico y sin trampas | Parada → Reintentar → acciones de cada requisito → declaraciones → límites → «Ver evidencia» → salto a la navegación. ✔ | Registro de foco del guion |
| A9 | Guarda límites y llama a `live:activate` por IPC con la frase exacta | Rechazo con cada requisito pendiente | `activated: false`, 7 `pendingRequirements` y 9 motivos legibles. Queda en el Diario como «Activación de dinero real rechazada: 7 requisito(s) pendiente(s).» (Límite · Alcanzado). ✔ | Salida IPC del guion |
| A10 | Va a Ajustes y vuelve | Los límites guardados siguen en el formulario | Formulario vacío. Confirma lo que el E2E solo había visto en el código (hallazgo 5 del E2E) | — |
| A11 | Escribe −10, 0 y 1,5 en los límites | Error junto a cada campo | «Escribe un límite mayor que cero» y «Escribe un número entero de posiciones». «Guardar límites» deshabilitado. ✔ | [limites-invalidos](capturas/fase-6-7-qa-b-limites-invalidos.png) |
| A12 | Pega 6.000 caracteres en el plan de contingencia | Límite claro | Se corta a 1.000 (`maxlength`), como anuncia la ayuda. ✔ | — |
| A13 | Pierde la conexión con la pantalla abierta | No se puede activar y se avisa | «Sin conexión · no se puede activar dinero real», con «Reintentar conexión». Por IPC sigue rechazado. ✔ | [sin-conexion](capturas/fase-6-7-qa-a-dinero-real-sin-conexion.png) |

**Resultado del Perfil A:** completa el recorrido. Lo esencial funciona:
- entiende el régimen y por qué cada estrategia vota o no;
- entiende el «no apto» del modelo;
- lee el sentimiento por activo;
- no puede pasar a real ni por la interfaz ni por IPC.

Le estorban la tabla de predicciones sin la vigente destacada (P3) y el enlace roto a la ficha (P2).

---

## Perfil B · Responsable de equipo que revisa entregas

Revisa lo que hizo el equipo: por qué una estrategia dejó de votar o una señal salió rebajada, qué hacer con una estrategia degradada y si la evidencia de la lista y la prueba de humo son auditables.

| # | Paso | Esperado | Observado | Evidencia |
| --- | --- | --- | --- | --- |
| B1 | El equipo activa «Reversión RSI/Bollinger» (falla en Tendencia) con el mercado real del simulador en Tendencia y avanza 6 sesiones | La estrategia no vota y el motivo queda en el Diario | Por cada sesión, una entrada Resumen · Sin señal: «'Reversión RSI/Bollinger' v2 no vota en SPY (régimen: desactivada): El mercado está en Tendencia · Volatilidad alta y la estrategia declara que falla en Tendencia.» También hay entradas de «Cambio de régimen del mercado (SPY, cierre…)». ✔ | [diario-estrategia-desactivada](capturas/fase-6-7-qa-b-diario-estrategia-desactivada.png) |
| B2 | Filtra el Diario por Tipo «Resumen» y Activo SPY, abre el detalle y lo cierra con Escape | Detalle con motivo y datos; teclado operativo | Motivo completo, versión de la ficha, `barDate` y régimen. Escape cierra el panel. ✔. El régimen sale como JSON crudo (P12) | Ídem |
| B3 | Quita la restricción de régimen (versión 3), añade noticias de agencia y avanza hasta una señal | La señal rebajada explica por qué | Señal SPY «Reducida». «Cumplimiento de reglas» explica la causa: «Modo cautela · evento=VIX 36.9, factor=0.5». El motivo añade «IA: noticias: 10 análisis (×1.00)». Las 10 noticias solo aparecen como ids numéricos en JSON, sin titular ni enlace, y no se puede saber cuáles influyeron (P12) | [diario-senal](capturas/fase-6-7-qa-b-diario-senal.png) |
| B4 | Dos revisiones mensuales malas seguidas (`ai:simulate-drift` rendimiento 1 y 2) | Degradada solo tras la segunda, con motivo, fecha y aviso | Degradada con 34 operaciones y −36 %. Diario: «… pasa a «degradada»: Desviación −36,0 % fuera del ±30 %… en 2 revisiones mensuales». La ficha muestra la insignia, el motivo, la «Última revisión» y el enlace a Salud de modelos, que funciona. ✔ | [ficha-degradada](capturas/fase-6-7-qa-b-ficha-degradada.png) |
| B5 | Revisa **Salud de modelos** | Evidencia de la degradación y propuesta trimestral | Texto «Una racha mala aislada no degrada una estrategia». Persistencia «2 revisiones mensuales · mínimo 2». Propuesta 2026-Q4 con motivo, datos, último reentrenamiento y próxima fecha. Inconsistencias en el modelo: «60/60 predicciones resueltas» pero «Brier móvil Sin referencia», y «desviación Sin referencia %» (P10) | [salud](capturas/fase-6-7-qa-b-salud.png) |
| B6 | Pospone la propuesta al 15-01-2027 con un motivo largo (≈ 250 caracteres) | Queda pospuesta, con nota y rastro en el Diario | La propuesta pasa a «pospuesta hasta 15 ene 2027», con la nota. **No hay ninguna entrada en el Diario** sobre el aplazamiento (aprobar sí deja una) (**P4**) | [posponer-dialogo](capturas/fase-6-7-qa-b-posponer-dialogo.png), [propuesta-pospuesta](capturas/fase-6-7-qa-b-propuesta-pospuesta.png) |
| B7 | Con la evidencia sembrada, prueba la parada, firma las tres declaraciones (la legal con nota) y revisa la evidencia de cada requisito | Cada requisito cumplido con su evidencia verificable | Los automáticos muestran su evidencia («122 de 91 días · 34 de 30 operaciones · −4,0 %», «Canal externo (simulado)…»). La parada dice «Última prueba **hoy (10 oct 2026)**», pero la fecha local ya es 11 oct (**P9**). Las tres declaraciones devuelven `evidence: null`: la fila cumplida dice «Sin evidencia guardada.» junto a «Declarada <fecha>» (**P8**) | [lista-evidencia](capturas/fase-6-7-qa-b-lista-evidencia.png) |
| B8 | Conecta las claves live (simuladas), guarda límites 200/20/5/1 y pulsa «Activar dinero real» | Botón habilitado y diálogo con la frase | En 3 de 4 ejecuciones el panel sigue con «Guarda los límites de capital real…» y «Los requisitos cambiaron durante la comprobación», y el estado dice «bloqueado · faltan 0 de 7». El proceso principal ya está en `listo`. Reintentar el guardado no lo arregla. **No se puede activar desde la interfaz** (**P1**). Se activó por IPC para seguir | [limites-guardados-sin-reflejo](capturas/fase-6-7-qa-b-limites-guardados-sin-reflejo.png) |
| B9 | Ejecuta la prueba de humo de 1 USD | Compra, cierre y conciliación sin descuadres, con precios coherentes | «Cerrada y conciliada», «Sin diferencias · Revisión #1» y 4 pasos completados. Pero: **slippage −8.278,15 pb «favorable»** (referencia 1.451,93 USD, ejecutado 250,00 USD), y la cantidad (0,000688 uds) se dimensionó con la referencia, así que el nocional real fue unos 0,17 USD y no 1 USD (**P7**). «Precio pedido compra: Mercado» en la pantalla, frente a «referencia 1451,93» en el Diario. El paso «Ejecución de compra» no tiene hora (**P13**) | [humo](capturas/fase-6-7-qa-b-humo.png) |
| B10 | Revisa la prueba de humo en el **Diario** | Hora, precio pedido, precio ejecutado y slippage | Tres entradas: compra («ejecutada a 250,00 USD (referencia 1451,93 USD, slippage −8278,15 pb)»), cierre y resumen, con los ids de cliente de las órdenes y la conciliación. ✔ en datos. El resumen de dinero **real** se clasifica como **«Operación simulada»**, y el subtítulo dice «Señales, operaciones simuladas…» (**P6**) | [diario-humo](capturas/fase-6-7-qa-b-diario-humo.png), [diario-humo-detalle](capturas/fase-6-7-qa-b-diario-humo-detalle.png) |
| B11 | Abre **Órdenes** con el modo real activo | Las órdenes reales de la prueba, marcadas como reales | «0 órdenes · Todavía no hay órdenes paper»: **las órdenes reales no aparecen** (**P5**). La conciliación dice «Sin diferencias» | [ordenes](capturas/fase-6-7-qa-b-ordenes.png) |
| B12 | Revisa **Estado del escalado** | Bloqueado y sin control para subir techos | «Escalado bloqueado · aún no hay operaciones reales conciliadas…», 0 de 8 semanas y 0 de 30 operaciones, sin control para subir los techos. ✔ | [activado](capturas/fase-6-7-qa-b-activado.png) |

**Resultado del Perfil B:**
- **Completa la auditoría del Diario y la decisión sobre el reentrenamiento.**
- **Activar el dinero real desde la interfaz queda bloqueado** en 3 de 4 ejecuciones (P1); se documenta como problema y se continuó por IPC.
- **La prueba de humo cierra y concilia, pero la evidencia no permite verificarla de verdad:** precios incoherentes (P7), órdenes reales ausentes en Órdenes (P5) y la entrada real rotulada como simulada (P6).

---

## Problemas

Severidad: **alta** = impide completar el recorrido o engaña sobre dinero real; **media** = el usuario no puede hacer o verificar algo de la fase; **baja** = texto, coherencia o comodidad.

### P1 · Alta · frontend — Tras guardar los límites, la pantalla no los reconoce y no deja activar el dinero real
- **Pasos:**
  1. Completa la lista: evidencia sembrada, parada, tres declaraciones y claves live.
  2. En «Dinero real», escribe 200 / 20 / 5 / 1 y pulsa «Guardar límites».
  3. Mira el panel de activación.
- **Esperado:** «Límites guardados · todavía debes confirmarlos por escrito.», el estado «Lista completa» y el botón «Activar dinero real» habilitado.
- **Obtenido (3 de 4 ejecuciones):**
  - el panel muestra «Los requisitos cambiaron durante la comprobación. Reintenta la verificación.» y «Guarda los límites de capital real antes de confirmarlos por escrito.»;
  - el estado dice «Dinero real bloqueado · faltan 0 de 7 requisitos» y el botón sigue deshabilitado;
  - `live:state` devuelve `mode: 'listo'`, es decir, los límites sí están guardados;
  - volver a guardar o «Reintentar verificación» no lo arregla.
- **Causa probable:**
  - `useLiveChecklist.ts`: el `live:changed` que emite `setLimits` llega con `working = true`, sube `generation` y descarta la relectura de `save()`, así que `limits` nunca se fija;
  - cualquier recarga posterior pone `state.limits`, que es `null` hasta confirmar.
  - Es la misma condición de carrera que el hallazgo 2 del E2E, pero aquí bloquea la activación antes de llegar al diálogo.
- **Captura:** [fase-6-7-qa-b-limites-guardados-sin-reflejo.png](capturas/fase-6-7-qa-b-limites-guardados-sin-reflejo.png)
- **También en la batería:** `npm run test:e2e` → `live-gate.spec.ts:141` falla en el mismo punto (`getByText(frase de confirmación)` no visible; el error-context muestra «faltan 0 de 7» y la alerta de requisitos cambiados).

### P2 · Media · frontend — «Ver ficha del modelo» en «Predicción por activo» lleva a Inicio
- **Pasos:**
  1. Sigue SPY y espera las predicciones.
  2. En IA → Predicción por activo, pulsa «Ver ficha del modelo».
- **Esperado:** desplazarse a la ficha del modelo en la misma página.
- **Obtenido:** la app navega a «Estado del sistema». El `href="#ai-model-card"` (en `PredictionsTable.tsx`) choca con el enrutado por hash de `App.tsx`. El enlace aparece en cada una de las filas, hasta 50.
- **Captura:** [fase-6-7-qa-b-enlace-ficha-modelo.png](capturas/fase-6-7-qa-b-enlace-ficha-modelo.png)

### P3 · Media · frontend — «Predicción por activo» mezcla el histórico y no destaca la predicción vigente
- **Pasos:**
  1. Sigue SPY, QQQ, AAPL y MSFT.
  2. Abre IA → Predicción por activo y filtra MSFT.
- **Esperado:** una predicción vigente por activo (la del último cierre), como en el diseño `01-ia-y-modelo.html`, con el histórico aparte si se quiere.
- **Obtenido:**
  - 50 filas (`limit` de la lista) con unas 12 por activo;
  - todas con la misma hora «Calculado» y solo la fecha de «Cierre» como diferencia;
  - al filtrar MSFT salen 12 filas con probabilidades del 7,8 % al 66,7 %.
  - Un usuario con varias carteras no sabe cuál es la vigente, y al crecer el seguimiento los activos más antiguos desaparecen de las 50 filas.
- **Captura:** [fase-6-7-qa-a-ia-predicciones.png](capturas/fase-6-7-qa-a-ia-predicciones.png)

### P4 · Media · backend — Posponer un reentrenamiento no deja rastro en el Diario
- **Pasos:**
  1. Degrada una estrategia con dos revisiones mensuales.
  2. En Salud de modelos → Propuesta, pulsa «Posponer», pon el 15-01-2027 y un motivo, y confirma.
  3. Busca la decisión en el Diario.
- **Esperado:** una entrada con la propuesta, la fecha de aplazamiento y el motivo, igual que la que deja «Aprobar».
- **Obtenido:**
  - ninguna entrada; solo está la de la degradación;
  - `drift/service.ts` (`resolve`, líneas 879-889) solo llama a `recordJournal` y `emitChanged()` cuando la acción es `aprobar`;
  - el responsable no puede auditar quién pospuso ni por qué.
- **Captura:** [fase-6-7-qa-b-propuesta-pospuesta.png](capturas/fase-6-7-qa-b-propuesta-pospuesta.png)

### P5 · Media · backend — Órdenes no muestra las órdenes reales (prueba de humo)
- **Pasos:**
  1. Activa el modo real con el broker simulado.
  2. Ejecuta la prueba de humo.
  3. Abre «Órdenes».
- **Esperado:** la compra y el cierre de la prueba, marcados «Real», ya que la página anuncia «modo indicado en cada orden».
- **Obtenido:** «0 órdenes · Todavía no hay órdenes paper». Las órdenes de `broker_orders_live` no llegan a `orders:list`. Junto con el hallazgo 1 del E2E (modo no disponible), Órdenes no distingue ni enseña nada real.
- **Captura:** [fase-6-7-qa-b-ordenes.png](capturas/fase-6-7-qa-b-ordenes.png)

### P6 · Media · frontend — El Diario rotula la prueba de humo con dinero real como «Operación simulada»
- **Pasos:**
  1. Ejecuta la prueba de humo.
  2. En el Diario, filtra SPY y abre la entrada «Prueba de humo real completada…».
- **Esperado:** un tipo que no diga «simulada» (p. ej. «Operación real») y un subtítulo que no hable solo de operaciones simuladas.
- **Obtenido:** Tipo «Operación simulada» (`journal/labels.ts`: `operacion → 'Operación simulada'`) y subtítulo «Señales, operaciones simuladas y decisiones auditables.». El filtro «Operación simulada» mezcla paper y real.
- **Captura:** [fase-6-7-qa-b-diario-humo-detalle.png](capturas/fase-6-7-qa-b-diario-humo-detalle.png)

### P7 · Media · backend — La prueba de humo da por buena una ejecución a −8.278 pb y dimensiona la cantidad con un precio ajeno
- **Pasos:**
  1. Activa el modo real con el broker simulado y SPY en seguimiento.
  2. Ejecuta la prueba de 1 USD.
- **Esperado:**
  - la cantidad se calcula con un precio coherente con el de ejecución;
  - un slippage absurdo (> unos cientos de pb) marca la prueba como fallida o avisa, porque es justo lo que una prueba de humo debe detectar.
- **Obtenido:**
  - referencia 1.451,93 USD (último cierre de las velas simuladas) frente a 250 USD ejecutados;
  - 0,000688 uds, es decir, unos 0,17 USD reales frente al «Nocional 1,00 USD» que se muestra;
  - el estado queda «Cerrada y conciliada», con el slippage «−8278,15 pb · favorable»;
  - la pantalla dice «Precio pedido compra: Mercado» y el Diario, «referencia 1451,93».
- **Contexto:**
  - en el entorno E2E la causa inmediata es que el servidor falso no comparte precio con el mercado simulado (la misma familia que la incidencia de la fase 5);
  - pero `smoke.ts` no tiene ninguna guarda de coherencia, y en real un último cierre desfasado o sin ajustar daría una orden de otro tamaño y una prueba «verde»;
  - relacionado con el hallazgo H2 de la auditoría.
- **Captura:** [fase-6-7-qa-b-humo.png](capturas/fase-6-7-qa-b-humo.png)

### P8 · Baja · backend — Las declaraciones cumplidas dicen «Sin evidencia guardada.»
- **Pasos:** firma «Revisión legal y fiscal» con una nota y guarda.
- **Esperado:** la fila cumplida muestra como evidencia el texto suscrito, la fecha y la nota.
- **Obtenido:**
  - `live:checklist` devuelve `evidence: null` para las tres declaraciones;
  - `ChecklistRow.tsx` pinta «Sin evidencia guardada.» encima de «Declarada <fecha>» y la nota;
  - para el responsable, la fila cumplida parece contradictoria.
- **Captura:** [fase-6-7-qa-b-declaracion-sin-evidencia.png](capturas/fase-6-7-qa-b-declaracion-sin-evidencia.png). La fila muestra «Cumplido», «Sin evidencia guardada.», «Declarada 11 oct 2026, 0:51» y la nota.

### P9 · Baja · backend — «Última prueba hoy (10 oct 2026)» cuando la fecha local ya es 11 oct
- **Pasos:** prueba la parada a las 00:46 CEST del 11-10-2026.
- **Esperado:** «hoy (11 oct 2026)», en la zona horaria del usuario, igual que «Evaluada 11 oct 2026, 0:46» en la misma fila.
- **Obtenido:** «Última prueba hoy (10 oct 2026).» La evidencia se formatea en UTC o en Nueva York.
- **Captura:** [fase-6-7-qa-b-lista-evidencia.png](capturas/fase-6-7-qa-b-lista-evidencia.png)

### P10 · Baja · backend — Salud de modelos: «60/60 predicciones resueltas» con «Brier móvil Sin referencia», y «desviación Sin referencia %»
- **Pasos:** sigue SPY (las predicciones históricas se resuelven al instante) y abre Salud de modelos.
- **Esperado:** con la ventana completa, el Brier móvil y la diferencia frente a la ficha; sin dato, «Sin referencia» sin el «%».
- **Obtenido:**
  - `resolvedCount` se lee en vivo, pero `rollingBrier` y `delta` salen de la última revisión guardada, que se deduplica por día;
  - por eso el contador dice 60/60 y el Brier sigue sin referencia hasta el día siguiente;
  - en las estrategias sin datos aparece «desviación Sin referencia %».
- **Captura:** [fase-6-7-qa-b-salud.png](capturas/fase-6-7-qa-b-salud.png)

### P11 · Baja · frontend — Sin régimen calculado, todas las estrategias salen «Activa por régimen»
- **Pasos:** en una instalación nueva, abre IA antes de seguir ningún activo.
- **Esperado:** una etiqueta neutra («Sin régimen · habilitada por defecto»).
- **Obtenido:** «Activa por régimen» incluso para «Reversión RSI/Bollinger», que falla en Tendencia. El motivo aclara que no hay régimen. Es la «falla abierta» deliberada que ya consultó la auditoría; la etiqueta induce a pensar que el régimen la avala.
- **Captura:** [fase-6-7-qa-a-ia-vacia.png](capturas/fase-6-7-qa-a-ia-vacia.png)

### P12 · Baja · frontend — En el Diario, el régimen y las noticias de una señal salen como JSON crudo e ids
- **Pasos:** abre el detalle de una señal con aportes de IA o de una entrada «no vota».
- **Esperado:** régimen legible («Tendencia · Volatilidad baja») y los titulares que influyeron, con su título y sentimiento.
- **Obtenido:** `regimen {"direction":"tendencia","volatility":"volatilidad-baja"}` y `ai {… "newsItemIds":[144,143,…]}`. No se puede auditar qué noticias movieron la confianza sin consultar la base de datos.
- **Captura:** [fase-6-7-qa-b-diario-senal.png](capturas/fase-6-7-qa-b-diario-senal.png)

### P13 · Baja · backend — El paso «Ejecución de compra» de la prueba de humo no tiene hora
- **Pasos:** ejecuta la prueba de humo.
- **Esperado:** cada paso con su hora.
- **Obtenido:** «Ejecución de compra · Completado», sin hora. `smokeTest.steps` solo trae `compra-enviada`, `posicion-cerrada` y `conciliacion-ok`.
- **Captura:** [fase-6-7-qa-b-humo.png](capturas/fase-6-7-qa-b-humo.png)

### Hallazgos previos confirmados en estos recorridos
- **E2E 2 y 5 (carrera de `useLiveChecklist`; límites que se pierden al navegar):** confirmados y ampliados en P1 y A10.
- **E2E 3:** «(abre en el navegador externo)» visible en Noticias.
- **E2E 1:** Órdenes sin modo por orden; ampliado en P5.
- **Auditoría H1:** la evidencia sembrada se presenta como «Canal externo (simulado)»; en E2E es lo esperado.

---

## Criterios de aceptación de la misión

| # | Criterio | Veredicto | Base |
| --- | --- | --- | --- |
| 1 | Activar el modo real sin la lista se rechaza (pantalla e IPC) y muestra cada requisito pendiente; solo con todo cumplido y los límites confirmados por escrito se activa | **Se cumple el bloqueo; la activación legítima falla de forma intermitente en la interfaz** | A7, A9 y A13: rechazo correcto con los 7 pendientes. Con todo cumplido, por IPC se activa (B8) y el E2E `live-gate` lo hace por la interfaz. P1 impide activar desde la pantalla en 3 de 4 ejecuciones |
| 2 | La prueba de humo envía el importe mínimo, cierra y concilia sin descuadres; el Diario guarda hora, precio pedido, ejecutado y slippage; una orden sobre el techo se bloquea antes del broker | **Se cumple, con reservas** | B9 y B10: cerrada, conciliada y con 0 descuadres; el Diario tiene todos los campos. Techo: lo verifica `live-gate.spec.ts` (0,50 USD) y está en verde. Reservas: P7 (precios incoherentes que se dan por buenos), P5 y P6; H2 de la auditoría (una orden de mercado puede superar el techo por orden) |
| 3 | Ficha de estrategia con «funciona en» y «falla en» y comparación con y sin filtro; la página IA muestra el régimen de cada activo y del mercado y qué estrategias están activas o desactivadas | **Se cumple** | A2 (régimen por activo y del mercado; estrategias activadas y desactivadas, y «Degradada» tras B4). La ficha y la comparación se cubren en `ai-regime-prediction.spec.ts` (verde). P11 es solo de redacción |
| 4 | Ficha del modelo con versión, horizonte, periodos, Brier OOS frente a la referencia y calibración; `npm test` comprueba la paridad ONNX/pipeline | **Se cumple** | A5; `src/main/ai/prediction/parity.test.ts` (paridad a 1e-6 y SHA-256), en verde |
| 5 | `npm test` cubre titulares etiquetados, que un titular sin verificar nunca cree señal, el paso por `risk:submit-signal` y la degradación por drift sostenido… | **Se cumple en `npm test`; un hueco conocido** | 2.216 aprobadas y 5 «expected fail». A6 confirma en la app que el rumor no se analiza ni crea señal, y B4 que una sola revisión no degrada. El hueco: H3 de la auditoría (una racha aislada a caballo de fin de mes degrada en 24 h), marcado `it.fails` |
| 6 | `typecheck`, `lint`, `test` y `test:e2e` en verde | **No se cumple** | `typecheck`, `lint` y `test`, en verde. `test:e2e` da 35/37: `paper-trading` (modo por orden) y `live-gate`, intermitente por P1 |

## Comprobaciones automatizadas

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | Correcto (exit 0) |
| `npm run lint` | Correcto (exit 0) |
| `npm test` | 169 archivos · 2.216 aprobadas · 5 «expected fail» (exit 0) |
| `npm run test:e2e` | **35/37 · en rojo (exit 1).** Fallan dos pruebas:<br>• `paper-trading.spec.ts:179`: Órdenes muestra «Modo no disponible» (hallazgo 1 del E2E, ya conocido).<br>• `live-gate.spec.ts:141`: tras «Guardar límites» no aparece la frase de confirmación. El estado es «Dinero real bloqueado · faltan 0 de 7» con la alerta «Los requisitos cambiaron durante la comprobación», es decir, **P1**. La tarea de E2E la dio por estable (8/8): es intermitente. |

## Fuera de este entorno (comprobaciones del usuario)

No se registran como fallos porque aquí no se pueden ejecutar:
- la prueba de humo con claves live reales de Alpaca y su cuadre en el panel web;
- el reentrenamiento con datos reales;
- `npm run eval:news-llm` con la clave de Anthropic, y su coste;
- el módulo nativo de onnxruntime en los paquetes de macOS, Windows y Linux;
- la revisión legal y fiscal con profesionales y el paper real de varios meses.
