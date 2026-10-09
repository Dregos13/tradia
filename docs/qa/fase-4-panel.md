# QA del panel de inicio · Fase 4

El panel usa los contratos IPC existentes y los tokens de `dashboard.tokens.json`, junto con los de base y riesgo. No lee `.orquesta` en ejecución.

## Capturas reproducibles

Ejecutar `node scripts/qa-panel.mjs` con Chromium de Playwright instalado. El script inicia y cierra un servidor Vite local, usa el adaptador simulado explícito y las fixtures tipadas de `dashboard/testFixtures.ts`. Los valores de las capturas son de pruebas, no precios de mercado reales.

- `capturas/fase-4-panel-1440.png`: rejilla de 12 columnas, bloques 4/8, 8/4 y 4/4/4.
- `capturas/fase-4-panel-700.png`: siete bloques apilados, margen del shell de 20 px.

Las imágenes abarcan el contenido completo; la altura de la ventana se ajusta para evitar recortar el contenedor de desplazamiento del shell. Se comprueban errores del navegador, desbordamiento horizontal y activación con teclado del selector de exposición. Revisión visual realizada en ambos anchos: títulos, fuentes y fechas, señales, motivos, confianza, decisiones de riesgo, posiciones, límites, exposición y versiones visibles.

## Cobertura del renderer

`dashboard/Dashboard.test.tsx` cubre los siete bloques, carga, vacío, errores parciales y reintento, desconexión, conservación de instantáneas, parada, confianza accesible, contradicciones, precios ausentes, umbrales de drawdown, selector por teclado, suscripciones, eventos de señales y riesgo y carreras con consultas IPC antiguas. La prueba de suscripciones de `App.test.tsx` incorpora los tres listeners adicionales contabilizados por el adaptador.

## Integración que debe conservar la siguiente tarea

- Enlaces al diario: `#diario`, `#diario?signalId={id}` y `#diario?entryId={id}`. La tarea de Diario debe reconocer estos hashes y seleccionar la entrada relacionada. El router actual todavía no incluye Diario: la página y su navegación pertenecen a esa tarea posterior.
- Estrategias enlazan al formato existente `#estrategias/{id}`.
- Las contradicciones proceden de `journal.list({type: 'contradiccion'})`, no de señales aprobadas. Se muestran sus motivos y referencias a estrategias sin interpretar JSON arbitrario.
- El régimen macro se mantiene en `Sin clasificar`: ningún contrato entrega una clasificación de régimen. VIX, Treasury 10 años e IPC reutilizan `MacroCard` con sus fechas y estado de fiabilidad.
- Se conservan los banners globales de desconexión y parada de fase 3. El panel mantiene posiciones y métricas visibles durante una parada y congela la instantánea si se pierde la conexión.
- Si los handlers de señales o cartera todavía están inertes, el error permanece dentro de sus bloques y ofrece reintento. La verificación contra esos servicios reales corresponde a la integración de la fase.

Las notificaciones reales, servicios externos y comprobaciones con Tiingo/FRED reales quedan en la lista de verificaciones del usuario; estas capturas no las sustituyen.
