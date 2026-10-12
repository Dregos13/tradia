# Auditoría de seguridad · lenguaje de reglas propias y retirada de la API de noticias

**Resultado:** 1 hallazgo (**R1, baja — cerrado en esta entrega**): `parseLevel` aceptaba un escalar no finito en el objetivo (`target`) y en los múltiplos `K * atr(n)` del stop/objetivo, que compilaba a un nivel inerte en vez de rechazarse. La corrección va en `src/shared/strategyRules.ts` (un literal `num` no finito evalúa a `null`), pedida por la reentrada de la tarea tras fallar `npm test`: sin ella la prueba de R1 quedaría en rojo y la corrección estaba reservada a `be-correcciones`.

- **Pruebas:**
  - `src/main/backtest/__audit__/reglas.audit.test.ts` (nueva, 19 pruebas)
  - `src/main/ai/__audit__/sin-api.audit.test.ts` (nueva, 9 pruebas)
- **Ejecutar:** `npx vitest run src/main/backtest/__audit__ src/main/ai/__audit__` — 70 pruebas en verde (R1 corre como `it` normal con «HALLAZGO R1 (cerrado)» en el nombre, por la convención de esta misión: sin `it.fails`).
- **Informe previo relacionado:** `docs/qa/auditoria-continuacion-fase-6-7.md` (CLI de Claude, cortos reales, frescura de datos). Esta ronda no reabre esos hallazgos: ataca superficies nuevas.

## Alcance y modelo de amenaza

Dos superficies:

1. **El lenguaje de reglas propias (DSL).** Las reglas son texto libre del usuario que llega al proceso principal por IPC (`strategies:*`), se compila con `parseStrategyRules` (`src/shared/strategyRules.ts`) y se ejecuta como estrategia en el backtest (`createCustomStrategy`, `src/main/backtest/strategies/custom.ts`) y en el motor de señales (sonda `collectLastBarOrders`, `src/main/signals/probe.ts`), cuyas propuestas acaban en `risk:submit-signal` (pasarela única de `src/main/signals/engine.ts`) y, con el modo real activo, en órdenes que pasan `liveOrderBlockReason` (`src/main/live/orderGuard.ts`). Se ataca: inyección (`eval`/`Function`/cadena de prototipos), límites de recursos (cadenas enormes, anidación, aritmética patológica), mirar el futuro, saltarse la pasarela de riesgo y saltarse los techos del dinero real (incluidos los fijos del corto: 100 USD/orden, 200 USD de exposición, 1 posición, stop ≤ 5 %).
2. **La retirada del proveedor 'llm' (API de pago de Anthropic).** Solo deben quedar 'suscripcion' (CLI local de Claude Code) y 'local' (clasificador léxico). Se buscan: clave cifrada heredada que sobreviva, rutas/canales olvidados que reactiven la API, `llm` aceptado de nuevo por el borde IPC, y secretos en registros.

## Cómo se ha atacado

- **Analizador:** entradas maliciosas directas a `parseStrategyRules` (la misma función que corren IPC y señales): `__proto__`/`constructor`/`hasOwnProperty`/`eval`/`Function`/`process` como nombre o función, parámetros con claves del prototipo (propia vs. heredada), campos de 250 KB y más, anidación de 200 niveles, literales que desbordan a `Infinity`, división por cero, periodos negativos/cero/no enteros/fuera de rango, binario y Unicode hostil, y clases erróneas (`rules: null`, `entry: 42`, `entryShort: ['x']`).
- **Ejecutor:** `collectLastBarOrders` sobre `createCustomStrategy` con velas corruptas (`NaN`, `±Infinity`), un parámetro cuyo nombre es `__proto__`/`constructor`, y una serie que demuestra que `maximo(n)`/`minimo(n)` no leen la vela actual.
- **Puerta de señales:** `registerSignals` real con SQLite, ficha propia sembrada por el repositorio y velas en `market_bars`; `risk.submitSignal` espiado y variable; la señal persistida se alimenta después al `createOrderManager` real con `checkOrderAllowed`/`orderWirePrice` cableados a `liveOrderBlockReason`/`liveOrderWirePrice` y un adaptador de broker falso que registra todo lo que llega a la red.
- **Retirada de la API:** `openDatabase(':memory:')` con todas las migraciones, `createSecretsService` real con un `safeStorage` falso reversible, y la fila `secrets`/`settings` heredada **escrita por SQL directo** (sin pasar por `setKey` ni IPC, como quedó guardada en la versión anterior). Handlers IPC reales de `registerNewsAi`. Barrido de `src/` con allowlist justificada de referencias a «anthropic».

## Garantía → prueba

### Lenguaje de reglas

| Garantía | Prueba | Resultado |
| --- | --- | --- |
| Campos de >500 caracteres se rechazan por campo, sin colgar; en el tope exacto sigue valiendo | `reglas.audit.test.ts` · «cadenas enormes…» | Se cumple |
| Anidación profunda (paréntesis, `no`, unarios, cruces, niveles) se rechaza sin desbordar la pila; 32 niveles compila | «anidación profunda…» | Se cumple |
| `constructor`, `__proto__`, `hasOwnProperty`, `eval`, `Function`, `process`, `require`, `globalThis` no resuelven nada; las propiedades heredadas tampoco cuentan como parámetros | «la cadena de prototipos no resuelve nada…» | Se cumple |
| Un parámetro llamado `__proto__`/`constructor` se lee por su clave propia (la orden sale) y `Object.prototype` queda intacto; un `__proto__` no numérico cierra el paso en `init` sin contaminar | «un parámetro llamado «__proto__»…» | Se cumple |
| Literales que desbordan a `Infinity` son inertes; parámetros no finitos cierran el paso en parse (periodo) y en `init` (`TypeError`), también los no usados | «números no finitos…» | Se cumple (ver R1) |
| Un nivel con escalar no finito se rechaza al analizar | «HALLAZGO R1 (cerrado)…» | Se cumple (R1 cerrado) |
| La división por cero nunca produce orden: «sin dato» → falso, o rechazo del nivel | «la división por cero…» | Se cumple |
| Periodos negativos, cero, no enteros, >500 o `sma(-n)` se rechazan en parse; un periodo-parámetro que cambia a inválido cierra en `init` | «periodos negativos…» | Se cumple |
| Binario, Unicode hostil, `sma()`, `cierre >`, `y`, `no`, `>>`, `,` y clases erróneas (`entry: 42`, `entryShort: ['x']`) se rechazan; `rules: null` lanza `TypeError` sin colgar | «texto que no es una regla…» | Se cumple |
| El programa compilado es dato puro serializable (solo nodos `num/field/param/indicator/neg/arith` y `cmp/cross/logic/not`) | «el programa compilado es un AST…» | Se cumple |
| Velas corruptas (`NaN`, `±Infinity`) no producen orden ni excepción | «velas corruptas…» | Se cumple |
| `maximo(n)`/`minimo(n)` solo ven las `n` velas anteriores (la entrada sale cuando el máximo actual sería mayor que el cierre) | «maximo(n)/minimo(n) leen solo…» | Se cumple |
| No hay `eval`, `Function` ni `import()` en analizador/ejecutor | `strategyRules.test.ts` (barrido previo) + «superficie de código» | Se cumple |
| El ejecutor no muta prototipos ni accede a propiedades por nombre de usuario fuera del AST | «superficie de código» | Se cumple |

### Pasarela de riesgo y dinero real

| Garantía | Prueba | Resultado |
| --- | --- | --- |
| Toda propuesta de una propia cruza `risk:submit-signal` (`origin: 'estrategia'`) y la decisión persistida es la de la pasarela | «toda propuesta de una propia cruza…» | Se cumple |
| Sin pasarela de riesgo no se emite nada (resultado 'error' + Diario, nada persistido ni difundido) | «sin pasarela de riesgo…» | Se cumple |
| Una decisión vetada se conserva en la señal y el gestor de órdenes no la ejecuta ('ignorada', 0 llamadas al adaptador) | «una decisión vetada…» | Se cumple |
| Entrada en corto dentro de los techos: venta stop a la referencia, nunca a mercado; por encima del techo por orden: 'bloqueada' antes de la red | «una entrada en corto de una propia respeta los techos…» | Se cumple |
| Corto bloqueado con: stop ausente, stop > 5 %, modo suspendido, límites sin confirmar, techos del corto a cero, cuenta sin/sin comprobar permiso, título no prestable, exposición desconocida, exposición > 200 USD, 1 corto ya abierto, pérdida diaria alcanzada | «los agujeros de la puerta del corto se cierran…» (12 escenarios) | Se cumple |
| La recompra de un corto abierto y la pata 'salida' pasan siempre (con modo suspendido y límites sin confirmar); una orden que daría la vuelta se bloquea; un corto 'market' en bruto también | «los cierres pasan siempre…» | Se cumple |

### Retirada de la API de pago

| Garantía | Prueba | Resultado |
| --- | --- | --- |
| Migrando desde 'llm' no queda clave de Anthropic en `secrets` ni 'llm' en `settings` (ni texto ni cifrado en ninguna fila) | `sin-api.audit.test.ts` · «tras migrar un ajuste «llm»…» | Se cumple |
| Los registros de la migración no filtran la clave ni su cifrado; el aviso existe y solo cuenta qué se hizo | «los registros de la migración…» | Se cumple |
| Una clave reescrita tras la migración se borra en el siguiente arranque | «una clave reescrita…» | Se cumple |
| `setLlmSettings` por debajo del guarda ignora 'llm' | «ninguna vía de servicio acepta «llm»…» | Se cumple |
| `ai:set-llm-settings` real rechaza `{provider:'llm'}`, `provider:'llm'` con `enabled`, claves sueltas (`apiKey`) y `{}`; solo 'suscripcion'/'local' pasan | «ai:set-llm-settings rechaza…» | Se cumple |
| `isNewsLlmSettingsInput`/`isNewsProvider` no dejan pasar 'llm' ni 'api'; `NEWS_PROVIDERS = ['suscripcion','local']` | «isNewsLlmSettingsInput…» | Se cumple |
| `ai:test-llm` migrado prueba la CLI (ping), nunca una API; en 'local' ni siquiera la consulta | «ai:test-llm con el ajuste migrado…» | Se cumple |
| Ningún archivo de producción nombra a Anthropic fuera de la allowlist justificada | «ningún archivo de producción nombra…» | Se cumple |
| Nadie hace `getKey(NEWS_LLM_SECRET_PROVIDER)` ni referencia `api.anthropic.com`/`@anthropic-ai/sdk`; `eval-news-llm.mjs` solo admite `['local','suscripcion']`; `package.json` no depende de Anthropic | «nadie vuelve a leer la clave…» | Se cumple |

## Hallazgos

### R1 · [baja · CERRADO] Un nivel con escalar no finito se aceptaba y quedaba inerte en vez de rechazarse

- **Dónde estaba:** `src/shared/strategyRules.ts` (`evalScalar` devolvía el literal sin comprobar finitud), con las guardas de `parseLevel` (`value > 0` para el objetivo, `multValue > 0` para el multiplicador de ATR) dejando pasar `Infinity`.
- **Reproducción:** una ficha con `target: '999…9%'` (490 nueves), `stop: '999…9 * atr(2)'` o `target` igual — cada uno cabe en los 500 caracteres del campo.
- **Comportamiento anterior:** la regla compilaba. En ejecución `levelPrice` devolvía `INVALID_LEVEL` (`src/main/backtest/strategies/custom.ts:384,390`) y `evaluate` descartaba la entrada (`custom.ts:411`): la ficha **nunca entraba** — inerte, no insegura.
- **Impacto:** ninguno de seguridad (fail-safe en el ejecutor); era un agujero de validación: el usuario creía haber fijado un objetivo/stop y la estrategia pasaba a operar (o no operar) sin él, silenciosamente.
- **Corrección aplicada en esta entrega** (la reentrada de la tarea pidió dejar `npm test` en verde sin desactivar la prueba, así que el arreglo ya no queda para `be-correcciones`): en `src/shared/strategyRules.ts`, caso `num` de `evalScalar`, un literal no finito devuelve `null` — el nivel se rechaza con «no se puede calcular» tanto en la rama `%` como en `K * atr(n)`, y cualquier futuro llamante queda cubierto. Riesgo residual menor, sin hallazgo: un multiplicador enorme pero finito (`1e300`) sigue compilando a un nivel inútil; si se quiere acotar es una mejora de validación, no un agujero de seguridad.
- **Prueba:** `reglas.audit.test.ts` · «HALLAZGO R1 (cerrado) · un nivel con escalar no finito se rechaza al analizar» — verde.

## Restos de compatibilidad legítimos (no son uso de la API)

- **`NEWS_LLM_SECRET_PROVIDER = 'news-llm-anthropic'`** (`src/shared/ai.ts`): solo sirve para `hasKey`/`deleteKey` en la migración (`src/main/ai/news/service.ts:280-287`) y como campo `hasKey` del contrato (inerte; el renderer ya no lo usa).
- **`NEWS_LLM_MODEL = 'claude-haiku-4-5-20251001'`** (`src/shared/ai.ts`): etiqueta histórica del modelo; solo la usan pruebas y el fixture `installFakeCli.ts` para mantener la forma de la salida.
- **`NewsAnalyzer` incluye `'llm'`** (`src/shared/ai.ts:306`, migración `013_news_suscripcion.sql`): la tabla `news_analysis` admite filas históricas analizadas por la API; el `CHECK` es deliberado.
- **`monthlyBudgetEur`, `spentThisMonthEur`, `usage`, `cliPath`** en `NewsLlmSettings`: campos de compatibilidad del contrato; el servicio los devuelve a 0 o los ignora (`service.ts:473`, `:520-524`).
- **`scripts/eval-news-llm.mjs`** conserva su nombre ('llm') por el historial del comando `npm run eval:news-llm`; `PROVIDERS` solo admite 'local'/'suscripcion' y la ayuda documenta que la API se retiró.
- **`analyzer: 'llm'` en `src/renderer/src/adapters/simulated.ts`**: solo E2E; escribe la etiqueta histórica en los análisis simulados.

## Observaciones (sin hallazgo)

- `parseStrategyRules(null)` lanza `TypeError` (`strategyRules.ts:1006` lee `rules.entry`). No llega por IPC (`isStrategyRules` lo corta) ni por el repositorio (`regla_entrada` es `NOT NULL`); el lanzamiento es inmediato y cerrado — `listEvaluables` se llevaría el error por `handleBarStored` (registrado, sin colgar). Se deja como riesgo residual, sin prueba roja.
- `secrets:set-key` admite cualquier nombre de proveedor: un renderer comprometido podría reescribir `news-llm-anthropic`. Nada la lee (verificado: no hay `getKey` sobre ese proveedor en todo `src/`), y la migración la vuelve a borrar en el siguiente arranque (probado). Residual.
- `src/main/live/scaling.test.ts` incumplía `prettier --check` **en el árbol confirmado** (no era de esta tarea). Ya corregido: `npm run format:check` queda en verde.

## Correcciones

Ronda `be-correcciones` (12-10-2026): estado final de los hallazgos de **Backend** de los cuatro informes de la misión (`auditoria-reglas-noticias.md`, `e2e-reglas-noticias.md`, `perfiles-reglas-noticias.md`, `estado-pendientes.md`). Los de Frontend (F1 del E2E; P-1 y P-2 de perfiles) no están en esta tabla: los cierra `fe-correcciones` y van en la tabla «Correcciones de Frontend» de `docs/qa/perfiles-reglas-noticias.md`.

| Id | Origen | Gravedad | Estado | Archivo | Prueba |
| --- | --- | --- | --- | --- | --- |
| R1 | Auditoría | Baja | Corregido | `src/shared/strategyRules.ts:747-750` (caso `num` de `evalScalar`: un literal no finito devuelve `null` y el nivel se rechaza, en `%` y en `K * atr(n)`) | `src/main/backtest/__audit__/reglas.audit.test.ts:294` «HALLAZGO R1 (cerrado)…» |
| P-3 | Perfiles | Media | Corregido | `docs/qa/estado-pendientes.md` reescrito: veredicto al día, E1/E2 cerrados y cada referencia `archivo:línea` comprobada con `sed -n` (H1 → `live/service.ts:551`, H2 → `orderGuard.ts:155` y `:215-216`, H3 → `ai.audit.test.ts:926`, H4 → `news/service.ts:414-428`, H5 → `ai.audit.test.ts:319`, P4 → `ai.audit.test.ts:852`) | Batería de regresiones de su §1: 270/270 en verde |
| P-4 | Perfiles | Media | Corregido | `docs/tareas-del-usuario.md`: §0 (`origin/main` + CI), §1 paso 5 (`/logout`), §4 paso 5 (`claude.cmd` sin `spawn EINVAL`), §7 (corto con dinero real en Alpaca: margen, ≥2 000 USD, techos 100/200/1/stop 5 %) y el botón citado como «Probar de nuevo» | `grep -niE 'corto\|logout\|claude.cmd\|EINVAL\|origin/main' docs/tareas-del-usuario.md` (estado-pendientes §2.2) |
| Obs. «arranque sin CLI» | Perfiles | Observación → criterio 3 | Corregido | `src/main/ai/news/service.ts:586-597` (`start()`: una vez por proceso, si el proveedor guardado es la suscripción activada y no hay CLI, emite el estado y llama a `notifyFailure`); cableado en `src/main/ai/news/index.ts:138` | `src/main/ai/news/service.test.ts:595` «…el arranque notifica UNA vez», `:628` (recaída); `src/main/ai/news/index.test.ts:172`, `:194` (vía `registerNewsAi`) |
| O1 «Venta sin posición» | E2E | Observación | Justificado, sin cambio | `src/main/signals/probe.ts`: las órdenes emitidas por la estrategia son propuestas; una «Venta» sin posición es inerte y el motor de riesgo la veta con motivo legible. Idéntico en las cuatro clásicas — suprimirla solo en las propias rompería la paridad del contrato | Esperado por `e2e/signals-dashboard.spec.ts:152` («las ventas sin protección se vetan con motivo legible») |
| O2 veto con `Objetivo: ninguno` | E2E | Observación | Justificado en backend | Sin objetivo no hay ratio beneficio/riesgo y el motor de riesgo veta la señal: comportamiento correcto, no un fallo | El aviso sugerido es texto de ayuda del editor (`src/renderer/src/components/strategies/RuleEditor.tsx`) → `fe-correcciones` |
| Residual `parseStrategyRules(null)` | Auditoría | — | Justificado | `src/shared/strategyRules.ts`: `TypeError` inmediato y acotado; `isStrategyRules` lo corta en el borde IPC y `regla_entrada` es `NOT NULL` en el repositorio | Sin prueba roja (ver «Observaciones») |
| Residual `secrets:set-key` | Auditoría | — | Justificado | El canal acepta cualquier proveedor, pero nada lee `news-llm-anthropic` y la migración la borra en el siguiente arranque | `src/main/ai/__audit__/sin-api.audit.test.ts:184`, `:257`, `:421` |

No queda ningún hallazgo de Backend abierto: los de gravedad media están corregidos y los de gravedad baja y las observaciones están corregidos o justificados arriba. Las 70 pruebas de los dos archivos de auditoría pasan.

## Verificación

- `npm run typecheck` — verde.
- `npm run lint` — verde.
- `npm run format:check` — verde (tras el formateo de `src/main/live/scaling.test.ts`).
- `npx vitest run src/main/backtest/__audit__ src/main/ai/__audit__` — 70 pruebas en verde.
- `npm test` — 2710/2710 en 192 archivos (verificación de `be-correcciones`).
