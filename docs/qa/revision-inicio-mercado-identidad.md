# Revisión de Inicio y Mercado con la identidad Arco

Revisión de la entrega provisional de Sonnet por Codex. Se contrastó la implementación con la guía de pantallas y los tokens versionados del proyecto, conservando las funciones, textos operativos y contratos IPC.

## Resultado

`market.tokens.json`, `dashboard.tokens.json` y `data-clarity.tokens.json` coinciden íntegramente con sus objetos en `docs/diseno/dominio.tokens.json`. La aplicación usa sus copias locales. No necesita leer `.orquesta/`.

Inicio conserva la composición por carriles, separadores finos, estados semánticos con texto y cifras en IBM Plex Mono. Sus pruebas existentes cubren carga, errores parciales, recuperación, instantáneas sin conexión, llegada de señales y parada. Mercado mantiene velas ajustadas, series reales del histórico, indicadores, calendario Forex, procedencia y fiabilidad; no se añade una previsión inventada ni un cursor «AHORA» sobre datos que no representan previsiones.

El gráfico usa los tokens del tema del sistema: vela alcista hueca y bajista sólida, mechas de acero y SMA continua, discontinua y punteada. Las muestras de la leyenda coinciden con los trazos del lienzo. Los dos temas usan fuentes locales. La retícula es decorativa y no se trata como una curva informativa.

Se conserva el registro de `market:search` en `registerMarket`: es el cableado necesario para que el buscador existente funcione en Electron. Esta revisión no modifica código de main. Los fallos históricos del desplegable y de la etiqueta Divisa están siendo corregidos por la tarea paralela de E2E; no se duplican sus cambios.

## Correcciones

- **Hueco de 580 px en Mercado estrecho:** al pasar la barra de herramientas de fila a columna, `flex-basis: 580px` medía la altura del formulario. Se restablece `auto` en ese breakpoint para que el formulario mida su contenido y no empuje el gráfico hacia abajo.
- **Gráfico no fiable atenuado:** la regla global reducía al 50 % la opacidad del lienzo completo, incluyendo ejes y series que deben seguir siendo legibles. Mercado conserva opacidad completa y mantiene el aviso, la etiqueta y las guardas del motor. El recorrido existente `market-chart.spec.ts` comprueba el contraste conservado al simular la caída real del proveedor.
- **Transición de los controles RSI/ATR:** se sustituyen duración suelta y `transition: all` por los tokens de movimiento del proyecto y las tres propiedades que cambian.
- **Mock incompleto de los trazos:** la prueba del gráfico sólo definía `LineStyle.Dashed`. Ahora también define `Solid` y `Dotted`, lo que permite comprobar que la distinción visual no se pierde.

## Cobertura añadida

- `MarketWorkspace.test.tsx`: verifica configuración de velas, retícula, fuente, SMA, RSI y ATR en ambos temas, limpieza del gráfico anterior y del listener de sistema, conservación de una SMA oculta tras cambiar de tema y tabla accesible cuando falla el lienzo. La prueba de fallo utiliza treinta velas ajustadas, suficientes para comprobar la alternativa sin montar miles de celdas.
- `market-dashboard-contrast.test.ts`: descubre recursivamente todos los estados y series de los dos dominios y genera sus combinaciones de contraste con las superficies de uso. Exige 4,5:1 para texto y 3:1 para gráficos; también verifica texto de cuerpo y etiqueta sobre cada relleno de estado. No considera las mechas texto ni la retícula información. `surfaceStrong` se comprueba para gráficos; las etiquetas de dominio no se colocan sobre ella (la etiqueta ETF usa `textMuted`, cubierta por la prueba base).
- `inicio-mercado-identidad.spec.ts`: ejecuta Electron en claro y oscuro, carga AAPL mediante el formulario existente, comprueba las fuentes aplicadas y los tres trazos de leyenda, guarda el gráfico con datos y comprueba distribución a 1280, 1024 y 700 px. Fija expresamente la regresión de altura del buscador.

Las capturas del gráfico con datos se guardan en `docs/qa/capturas/identidad/despues-mercado-velas-{claro,oscuro}.png`. Las comprobaciones de Inicio y ventana compacta van a `test-results/inicio-identidad-*` y `mercado-compacto-identidad-*`. Se mantienen las capturas antes/después de la misión.

## Verificación final

- `npm install`: correcto.
- `npm run build` (incluye `npm run typecheck`): correcto.
- `npm run lint` y `npm run format:check`: correctos.
- `npx playwright test e2e/inicio-mercado-identidad.spec.ts`: 2/2 correctos; capturas inspeccionadas.
- `npx playwright test e2e/market-chart.spec.ts`: 1/1 correcto, incluida la conservación de opacidad tras caer el proveedor.
- Contraste de Inicio/Mercado: 458 combinaciones correctas. Las nuevas pruebas unitarias del gráfico pasan.
- Sin coincidencias de geometría o colores antiguos en `src`, `build`, `resources` y `scripts`.

Las primeras suites globales coincidieron con otras tres baterías Electron y varias Vitest completas: registraron timeouts, además de dos fallos de barra de estado de la versión intermedia y un bloqueo del aviso inicial. Se detuvieron las ejecuciones antiguas propias para dejar una única pasada final coordinada por `audit-fix-2`, sin cambiar tests, límites ni configuración. Su resultado se incorporará antes del cierre.
