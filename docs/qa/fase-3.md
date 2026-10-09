# QA · Fase 3 — Motor de riesgo con veto

Prueba manual por perfiles en Electron con `TRADIA_E2E=1`, datos simulados y almacenamiento temporal aislado. La revisión cubre la fase objetivo: motor de riesgo independiente, límites, paradas, registro de vetos y modo cautela.

## Perfiles de prueba

### Profesional independiente que organiza varios proyectos

**Resultado: cumple**

1. Abrí la app con la pantalla de aviso, la acepté y accedí a la vista **Riesgo**.
2. Revisé los valores prudentes por defecto y validé el formulario con valores fuera de margen (`riskPerTradePct = 3` y `beneficio/riesgo = 1:1,5`): el formulario bloquea el envío y muestra errores en línea.
3. Probé una señal sin stop y otra con ratio 1:1; ambas entraron en la lógica del motor y se vieron vetadas con el motivo correcto.
4. Probé la evaluación de señal con stop correcto y validé que la decisión aprobada devuelve un tamaño calculado por la distancia al stop.
5. Activé la parada manual desde la cabecera y confirmé que cualquier señal nueva queda vetada con el motivo «Parada activa» hasta reanudación explícita.
6. Revisé el estado de cautela con un evento simulado del calendario y comprobé que reduce o bloquea la señal en función del evento.

- **Esperado:** la app no permite salir con riesgo fuera de márgenes ni ejecutar señales no protegidas; la parada manual y la cautela deben bloquear decisiones y dejar trazabilidad.
- **Observado:** los comportamientos esperados se cumplen en la lógica de riesgo y en la UI; los vetos quedan visibles en el registro y con etiquetas legibles.
- **Evidencia:** `npm test` con 1151 pruebas aprobadas; `npm run typecheck`; `npm run lint`; `docs/qa/capturas/fase-3-1440.png`; `docs/qa/capturas/fase-3-700.png`.

### Responsable de equipo que revisa entregas

**Resultado: cumple**

1. Abrí el registro de vetos, filtré por regla (`STOP_MISSING`, `RR_TOO_LOW` y otros mínimos) y comprobé que el motivo incluye la regla y los valores de la señal.
2. Simulé un caso automático de parada y confirmé que la causa se guarda junto con la fecha, el motivo y la reanudación posterior.
3. Revisé la bandera de cautela activa y la referencia del evento que la provoca (`Modo cautela`, evento del calendario, efecto y vencimiento).
4. Comprobé que la reanudación requiere confirmación explícita y que el historial no deja la causa sin contexto.

- **Esperado:** un responsable de equipo debe poder auditar cada veto, entender la regla incumplida y ver cómo se reanuda la operación después de una parada.
- **Observado:** el registro de vetos y la captura del estado cumplen la trazabilidad esperada y los eventos se muestran con detalle legible.
- **Evidencia:** pruebas unitarias del motor y la UI (`src/renderer/src/components/risk/RiskPage.test.tsx`, `src/main/risk/portfolioLimits.test.ts`, `src/main/risk/killSwitch.test.ts`, `src/main/risk/caution.test.ts`); `npm run test:e2e` (14/15 pasando; 1 fallo no relacionado con riesgo).

## Criterios de aceptación

| # | Resultado | Evidencia |
|---|---|---|
| 1 | **Cumple** | `npm test`, `npm run typecheck` y `npm run lint` pasaron. La suite tuvo 92 archivos y 1151 pruebas aprobadas. |
| 2 | **Cumple** | Hay pruebas de veto por pérdida diaria/semanal/mensual, drawdown, posiciones abiertas, exposición por activo/sector/divisa, correlación, apalancamiento y liquidez en `src/main/risk/*` y `src/shared/risk.test.ts`. |
| 3 | **Cumple** | El probador de señales de `RiskPage` y la validación de `listVetoes` muestran el motivo legible, la regla y los valores. La UI de vetos se actualiza en directo. |
| 4 | **Cumple** | Las pruebas de `killSwitch` cubren parada manual y activa por pérdida anómala, datos anómalos, fallo de conexión y modelo errático; la reanudación exige confirmación. |
| 5 | **Cumple** | `RiskPage.test.tsx` valida valores prudentes por defecto y rechaza 3 % y ratio 1:1,5 con error en línea; también bloquea posiciones fraccionarias. |
| 6 | **Cumple** | `src/main/risk/caution.test.ts` y la UI de cautela cubren eventos de alto impacto, tamaño reducido y bloqueo con motivo «Modo cautela». |

## Capturas

- `docs/qa/capturas/fase-3-1440.png` — vista de riesgo en ancho de escritorio (1440 px).
- `docs/qa/capturas/fase-3-700.png` — vista de riesgo en ventana estrecha (700 px).

## Hallazgos

### F3-QA-01 · Baja · Foco de teclado de navegación falla al tabular en la vista de mercado

- **Perfil:** Responsable de equipo que revisa entregas / validación cross-app.
- **Pasos:** Abrir la vista **Mercado**, redimensionar a 700 px, mover el foco desde **Estrategias** a **Ajustes** con Tab y comprobar la navegación lateral.
- **Esperado:** el tabulador debe llegar al enlace **Ajustes** y dejarlo enfocado.
- **Observado:** la prueba E2E `e2e/market-chart.spec.ts` falla en la aserción `toBeFocused()`: el enlace **Ajustes** permanece inactivo y no recibe el foco al tabular.
- **Evidencia:** salida de `npm run test:e2e`: `14 passed`, `1 failed` en `e2e/market-chart.spec.ts` con el error `expect(locator).toBeFocused() failed`.
- **Impacto:** no bloquea la fase 3 de riesgo, pero sí afecta a la accesibilidad por teclado y a la navegación general de la app.

### No se detecta fallo crítico en la fase 3 de riesgo

- La lógica del motor de riesgo, los límites, la parada manual/automática y la cautela cumplen las pruebas unitarias y E2E del producto (con la excepción de la navegación por teclado en mercado, no relacionada con riesgo).
- No se pudo verificar la bandeja completa en macOS/Windows/Linux real desde este entorno, porque la ejecución del equipo es Linux headless; eso no se trata como bug del producto en este informe.

## Resultado global

- **Fase 3 · Motor de riesgo con veto:** La evidencia de pruebas automáticas y de la UI describe un comportamiento correcto para el motor de riesgo y sus criterios de aceptación.
- **Fallo observado fuera del alcance de la fase 3:** la navegación por teclado con foco en el panel de mercado sigue rota y debe resolverse por el rol frontend responsable.
