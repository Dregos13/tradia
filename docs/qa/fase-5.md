# QA · Fase 5 · Paper trading

## Alcance y entorno

Recorrido E2E en Electron con el broker simulado, almacenamiento temporal por sesión y servicio local de conectividad. No se introdujeron claves de Alpaca reales ni órdenes externas. La generación usa el reloj simulado y una estrategia parametrizada para producir una señal aprobada; los datos de los informes son ocho semanas sembradas. Las capturas son de la interfaz ejecutada, no mockups.

## Perfil A · Profesional independiente que organiza varios proyectos

1. En una instalación limpia, acepta el aviso legal, abre **Ajustes** y conecta el broker simulado con las credenciales de prueba. Confirma `Solo paper · sin dinero real`, `Broker simulado`, almacenamiento cifrado y la ejecución activada.
2. Añade SPY, activa la estrategia semilla `Reversión RSI/Bollinger`, ajusta sus parámetros para el recorrido determinista y avanza el reloj hasta obtener una señal aprobada/reducida por Riesgo.
3. Abre **Órdenes** y localiza la entrada SPY. Comprueba hora solicitada y ejecutada, precio pedido y ejecutado, slippage y protección OCO.
4. Crea una limitada de compra AAPL, 2 unidades a 1 USD para mantenerla sin cruce, comprueba el estado `Enviada` y la cancela confirmando la acción.
5. Arma un timeout de envío para la siguiente señal y comprueba que conserva una sola orden de entrada para esa señal.

**Esperado:** la cuenta y toda ejecución son paper; una señal autorizada genera una entrada trazable y una protección OCO; la limitada queda cancelable; un timeout ambiguo no duplica la orden.

**Observado:** conexión, insignia, cifrado indicado en Ajustes, interruptor activo, señal, campos de ejecución, OCO, cancelación y control de duplicados pasaron en E2E. Sin embargo, la cotización que usa el broker simulado no concuerda con la señal: en la evidencia SPY se pidió a **1.451,93 USD** y se ejecutó a **284,21 USD** (−8.042,52 pb, etiquetado favorable); la pata OCO pidió **1.386,84 USD** y se ejecutó a **284,07 USD** (+7.951,67 pb, desfavorable). La diferencia de más del 80 % invalida el slippage presentado como resultado de una simulación realista. Se registra como incidencia media, reproducible abajo. La captura de Ajustes confirma que el nombre del broker es `Broker simulado`; la pantalla de Órdenes conserva la insignia paper.

**Evidencia:** [Ajustes paper](capturas/fase-5-perfil-a-ajustes-paper.png), [orden ejecutada y OCO](capturas/fase-5-perfil-a-orden-ejecutada.png), [limitada pendiente](capturas/fase-5-perfil-a-orden-limitada-pendiente.png), [limitada cancelada](capturas/fase-5-perfil-a-orden-limitada-cancelada.png). Automatización: `e2e/paper-trading.spec.ts`, escenarios de Profesional independiente.

## Perfil B · Responsable de equipo que revisa entregas

1. Conecta el broker simulado y crea una orden fantasma AAPL directamente en el adaptador E2E para provocar una diferencia entre broker y aplicación.
2. En **Órdenes**, pulsa `Conciliar ahora`. Verifica el aviso con el detalle de la orden que existe en el broker sin registro en Tradia, y que la prueba captura la notificación.
3. Abre **Diario**, localiza la entrada de error y consulta su detalle: se registra la conciliación y los datos usados incluyen el descuadre de AAPL.
4. Ejecuta backtests de `Cruce de medias` y `Reversión RSI/Bollinger`, siembra ocho semanas en paper y revisa **Real vs backtest** en las vistas semanal y mensual.
5. Decide con la alerta y la desviación qué estrategias superan el margen configurado.

**Esperado:** la diferencia concreta se ve en pantalla, se registra en el Diario y genera una notificación; los informes semanales y mensuales comparan por estrategia y marcan las desviaciones fuera del margen. Ninguna vista debe insinuar que la cuenta es live.

**Observado:** la alerta de Órdenes especifica AAPL y la orden fantasma; Diario muestra el error y su detalle técnico contiene `AAPL`; la notificación se capturó en el proceso principal. Con ocho semanas, la vista semanal marca 8 periodos fuera de margen de `Reversión RSI/Bollinger`; la mensual marca 4 periodos entre `Cruce de medias` y `Reversión RSI/Bollinger`. Ajustes, Órdenes y Real vs backtest indican Solo paper; el texto de Ajustes dice que no se admiten cuentas live ni retiradas. No se observó ninguna indicación de dinero real. Los flujos E2E de esta persona pasaron.

**Evidencia:** [aviso de conciliación](capturas/fase-5-perfil-b-conciliacion-descuadre.png), [detalle del Diario](capturas/fase-5-perfil-b-diario-descuadre.png), [informe semanal](capturas/fase-5-perfil-b-real-vs-backtest-semanal.png), [informe mensual](capturas/fase-5-perfil-b-real-vs-backtest-mensual.png). Automatización: `e2e/paper-trading.spec.ts`, escenarios de Responsable de equipo.

## Incidencia reproducible

### El broker simulado ejecuta a un precio de referencia ajeno al precio de mercado de la señal

- **Gravedad:** media. Afecta las pruebas de aceptación con broker simulado y hace que el slippage y la conciliación de la ejecución no sean representativos; esta observación no demuestra un fallo del adaptador Alpaca paper conectado a un broker real.
- **Responsable:** backend (precio de referencia del adaptador simulado).
- **Pasos:** 1) En E2E, conecta el broker simulado. 2) Añade SPY y activa `Reversión RSI/Bollinger` con `rsiPeriod: 2`, `oversold: 50`, `trendPeriod: 2` y `atrPeriod: 2`. 3) Avanza el reloj simulado, en incrementos de 24 h + 8 h, hasta la primera señal aprobada/reducida (el spec repite hasta 90 días). 4) Abre Órdenes y compara el `Precio pedido` de la entrada con `Precio ejecutado` y `Slippage`.
- **Esperado:** la ejecución de mercado sigue el precio de referencia de SPY usado por la señal, con el deslizamiento configurado del simulador (5 pb por defecto), y la protección OCO se ejecuta en torno a sus niveles de objetivo/stop.
- **Observado:** SPY 1.451,93 → 284,21 USD y OCO 1.386,84 → 284,07 USD; el informe etiqueta diferencias de aproximadamente 8.000 pb. La interfaz muestra esos importes y estados sin advertir que los precios de origen no concuerdan.
- **Evidencia:** [captura de Órdenes](capturas/fase-5-perfil-a-orden-ejecutada.png). En `src/main/broker/simulated.ts`, `refPrice()` usa como fallback `20 + (hashSeed(...) % 48_000) / 100`, mientras `src/main/broker/orderManager.ts` persiste `signal.entry` como precio pedido de la entrada.

## Comprobaciones automatizadas

| Comando | Resultado |
| --- | --- |
| `npm run typecheck` | Correcto |
| `npm run lint` | Correcto |
| `npm test` | 130 archivos y 1.677 pruebas correctas |
| `npm run test:e2e` | 29/29 pruebas correctas; `test-results/.last-run.json`: `passed`, `failedTests: []` |

La batería unitaria incluye los contratos HTTP de Alpaca paper, los casos de error y los fallos simulados del gestor de órdenes. E2E valida la conciliación bajo demanda; la periodicidad, el cifrado y el manejo de reintentos/huérfanas se cubren en tests automatizados de servicios. No se considera una sesión E2E periódica con OS en bandeja.

## Fuera de este entorno

Quedan para el usuario, tal como define el alcance: conectar credenciales reales de Alpaca Paper y verificar órdenes/cancelaciones en su panel; probar el rechazo de claves live; comprobar llavero y permisos nativos en Linux/macOS/Windows; y dejar la app en bandeja durante sesión de mercado para validar conciliación y notificaciones del sistema operativo. No se registran como fallos del producto porque no se ejecutaron aquí.

## Resumen para el equipo

- Se recorrieron los dos perfiles en Electron con el broker simulado.
- Se guardaron ocho capturas de los estados paper, órdenes, conciliación, Diario e informes.
- Ajustes confirma broker simulado, cifrado indicado e interruptor de ejecución activo.
- La señal aprobada genera entrada y OCO visibles con los datos requeridos.
- La limitada AAPL queda pendiente y se cancela desde Órdenes.
- El timeout simulado no duplica la orden de entrada.
- La discrepancia AAPL aparece en Órdenes, se registra en el Diario y notifica.
- Ocho semanas producen informes semanal y mensual con alertas por estrategia.
- Ajustes, Órdenes y Real vs backtest identifican explícitamente el modo Solo paper.
- Hallazgo medio: el precio fallback del broker simulado no concuerda con el precio de la señal y distorsiona el slippage.
- No se corrigió código de producto; el hallazgo queda para backend.
- Typecheck, lint, tests unitarios y E2E quedaron en verde.
- Credenciales reales y permisos/notificaciones nativos quedan pendientes para el usuario.
