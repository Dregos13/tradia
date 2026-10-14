# Prueba de experiencia con los perfiles de usuario — Mejoras en Tradia

> **Entregable de**: Prueba de experiencia con los perfiles de usuario (Testing)
> **Entorno**: App Electron arrancada con `electron .` sobre el build de producción
> (`npx electron-vite build`), con los ganchos deterministas `TRADIA_E2E=1` que ya usa
> la suite E2E del proyecto (perfil de usuario vacío, servidor local de conectividad,
> reloj de mercado anclado). Sin red real ni claves reales.
> **Documentos leídos antes de empezar**: `.orquesta/ROLES.md`, `docs/diseno-mercado-ia.md`,
> `.orquesta/feedback/8edbd742-184f-4d4a-80e6-e5dd6245fba4.png` y
> `.orquesta/feedback/ff7396b4-0f1d-4715-925b-2a4e0d1edfa7.png` (capturas del fallo real
> del usuario). `docs/qa/e2e-mejoras-tradia.md` todavía no existía en el repositorio en
> el momento de esta sesión (la tarea de E2E seguía en curso); sí existía ya
> `e2e/mejoras-mercado-ajustes.spec.ts` (trabajo en curso de esa tarea hermana), que se
> ha usado como referencia de selectores pero no se ha tocado ni se depende de su
> resultado.
> **Nota de entorno**: no hay pantalla física disponible en este equipo para capturar
> con `screencapture` (macOS), así que las capturas de evidencia se han tomado con
> `page.screenshot()` de Playwright conectado a la app Electron real en ejecución (la
> misma técnica que usa `e2e/*.spec.ts` en este repositorio), no con una herramienta de
> captura de pantalla externa. Todas las capturas citadas están en `docs/qa/capturas/`.

## Resumen ejecutivo

Las tres mejoras (desplegable de IA, buscador de activos y gráfico de velas con
EUR/USD) funcionan como describe `docs/diseno-mercado-ia.md` y resuelven la mayor
parte de la frustración original del usuario: el desplegable deja elegir
proveedor de IA con autodetección y diagnóstico claro, el buscador encuentra
EUR/USD al instante con un clic, y el gráfico de velas se expande al apagar los
paneles de RSI/ATR y formatea la divisa a 4 decimales. Sin embargo, al intentar
completar la comprobación textual del usuario «poder operar EUR/USD» por la vía
manual más visible de la app (Órdenes › Crear orden limitada), la operación
falla con un mensaje genérico que no explica el motivo real, lo que puede
reproducir la misma sensación de bloqueo que motivó la queja original
(**UXP-1**, alta). También se observa una duplicación del aviso de actualización
de datos en Mercado (**UXP-2**, media).

---

## Sesión 1 — Profesional independiente que organiza varios proyectos

Perfil: alguien que gestiona su propia cartera de activos y quiere elegir su
IA de confianza y seguir EUR/USD junto a sus acciones habituales.

### Paso 1. Ajustes › Análisis de noticias — evaluar el desplegable de IA

- **Pasos**: Abrir Ajustes → desplazarse a «Análisis de noticias» → leer las 5
  opciones del desplegable → seleccionar cada motor de suscripción
  (`suscripcion-claude`, `-codex`, `-antigravity`, `-copilot`) y comprobar que
  el texto explicativo y la etiqueta «Ruta de {motor} (opcional)» cambian.
- **Esperado**: 5 opciones (Claude Code, OpenAI Codex, Google Antigravity,
  GitHub Copilot, Analizador local), autodetección del primer CLI disponible
  preseleccionada (decisión del usuario registrada en el plan), textos y campo
  de ruta condicionales por motor.
- **Observado**: Las 5 opciones aparecen en el orden esperado. Con una CLI
  `claude` real presente en el `PATH` de este equipo de pruebas, el
  desplegable autodetectó y preseleccionó **Claude Code** mostrando
  `[✓] Ejecutable detectado automáticamente: /Users/dregos/.nvm/versions/node/v24.21.0/bin/claude`,
  tal y como pide la decisión «Autodetectar el primer CLI instalado». Al
  cambiar a Codex/Antigravity/Copilot el texto, el placeholder y la etiqueta de
  ruta (`Ruta de OpenAI Codex (opcional)`, `Ruta de Google Antigravity
(opcional)`, `Ruta de GitHub Copilot (opcional)`) se actualizan sin recargar la
  página. Todo accesible por teclado (el `<select>` nativo soporta flechas).
- **Evidencia**: `docs/qa/capturas/perfiles-profesional-ajustes-ia-inicial.png`,
  `docs/qa/capturas/perfiles-profesional-ajustes-ia-codex.png`.
- **Veredicto**: cumple. Facilidad de uso alta: un perfil técnico entiende de
  un vistazo qué motor está activo y por qué.

### Paso 2. Probar la conexión del motor elegido

- **Pasos**: Con Claude Code seleccionado (CLI detectada pero sin sesión
  iniciada en este entorno de pruebas), pulsar «Probar de nuevo».
- **Esperado** (según `docs/diseno-mercado-ia.md` §2.4): mensaje «Suscripción no
  disponible · No hay una sesión iniciada en {motor}» con instrucción concreta
  y botón «Comprobar de nuevo».
- **Observado**: aparece «Suscripción no disponible · sesión no iniciada» con el
  texto «Abre un terminal, ejecuta claude y después /login. Vuelve aquí y
  prueba de nuevo. Mientras tanto, se usa el analizador local.» — mensaje
  correcto, accionable y en español claro (variante ligeramente distinta en la
  redacción exacta de la especificación, pero el contenido — qué pasó, a qué
  afecta, qué hacer — se cumple).
- **Evidencia**: `docs/qa/capturas/perfiles-profesional-ajustes-ia-prueba-conexion.png`.
- **Veredicto**: cumple el objetivo de la queja original («no puedo conectar
  Claude... debería dejarme elegir»): ahora el usuario puede elegir
  explícitamente su IA y recibe una explicación clara de por qué no conecta,
  en vez de quedarse bloqueado.

### Paso 3. Mercado — buscar y añadir EUR/USD

- **Pasos**: Ir a Mercado → escribir «EUR» en «Buscar activo o divisa» →
  revisar sugerencias → pulsar «+ Añadir» sobre EUR/USD.
- **Esperado**: sugerencias con badge de clase de activo, EUR/USD en primer
  lugar con su descripción Forex 24/5, adición con un clic.
- **Observado**: aparecen 4 sugerencias ordenadas por relevancia: `EUR/USD`
  (Divisa, con subtítulo «Forex 24/5 · Cartera simulada interna»), `FXE`
  (ETF), `VGK` (ETF), `EZU` (ETF). Un clic en «+ Añadir» sobre EUR/USD lo
  incorpora a la lista de seguimiento al instante, con el badge «Divisa» y
  cotización a 4 decimales (`1,1000 EUR/USD`, `+0,0017 (+0.16 %)`) y el texto
  «EUR/USD · Tipo de cambio Forex 24/5 · Operativa en cartera simulada
  interna».
- **Evidencia**: `docs/qa/capturas/perfiles-profesional-mercado-buscador-eur.png`,
  `docs/qa/capturas/perfiles-profesional-mercado-eurusd-anadido.png`,
  `docs/qa/capturas/perfiles-profesional-mercado-grafico-eurusd.png`.
- **Caso límite — texto largo / sin resultados**: escribir
  `zzzznoexistenada12345` muestra correctamente «No encontramos ningún activo
  para “zzzznoexistenada12345”. Comprueba que el símbolo esté bien escrito o
  introduce un ticker directo para añadirlo.» sin romper el buscador ni dejarlo
  en un estado inconsistente. Vaciar el campo cierra el desplegable de
  resultados.
  Evidencia: `docs/qa/capturas/perfiles-profesional-mercado-sin-resultados.png`.
- **Veredicto**: cumple el criterio de aceptación 2 y 3. Esta es exactamente la
  función que el usuario pidió explícitamente («debería poder añadir lo que
  quiera, por ejemplo divisas, EUR/USD... ¿No estaría bien tener un
  buscador?»).

### Paso 4. Analizar las velas de EUR/USD con medias móviles y RSI/ATR

- **Pasos**: Seleccionar EUR/USD en la lista → comprobar SMA 20/50/200 activas
  → pulsar «Panel RSI 14» y «Panel ATR 14» para ocultarlos → mover el cursor
  sobre el lienzo para leer el tooltip OHLCV → reactivar los paneles.
- **Esperado**: al apagar ambos paneles, las velas ocupan el 100 % de la
  altura; tooltip con apertura/máximo/mínimo/cierre y RSI/ATR.
- **Observado**: con ambos paneles apagados el lienzo de velas se expande
  visiblemente (confirmado por captura); los botones alternan correctamente
  entre `+ Panel RSI 14` / `✓ Panel RSI 14`. El tooltip (`.ohlcv-bar`) muestra:
  `2024-11-07 Alcista Apertura: 1,1056 Máximo: 1,1142 Mínimo: 1,1043 Cierre:
1,1070 RSI 14: 69,06 · ATR 14: 0,0136` — con 4 decimales correctos para un par
  de divisa.
- **Evidencia**: `docs/qa/capturas/perfiles-profesional-mercado-grafico-sin-paneles.png`,
  `docs/qa/capturas/perfiles-profesional-mercado-tooltip-ohlcv.png`.
- **Veredicto**: cumple el criterio de aceptación 4.

---

## Sesión 2 — Responsable de equipo que revisa entregas

Perfil: alguien que no necesariamente configura cada detalle, pero que debe
poder confiar en que los avisos son claros, los datos de las nuevas divisas son
correctos y que nada se solapa ni se bloquea en pantalla.

### Paso 1. Claridad del aviso cuando la IA no conecta

- **Pasos**: En Ajustes, seleccionar `suscripcion-claude` y pulsar «Probar de
  nuevo» sin sesión iniciada.
- **Esperado**: un único aviso claro, con `role="alert"`, que explique qué
  pasó y qué hacer.
- **Observado**: aparece un solo `role="alert"` con el texto «LLM de noticias:
  sesión no iniciada: ejecuta claude y después /login y vuelve a probar» junto
  con el bloque principal ya descrito en la sesión 1. El mensaje es consistente
  y no deja al usuario sin indicación de qué hacer.
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-ajustes-aviso-cli.png`.
- **Veredicto**: cumple.

### Paso 2. Integridad de datos de divisas con varios activos a la vez

- **Pasos**: Añadir EUR/USD, SPY y QQQ seguidos desde el buscador, sin recargar
  la app, y comprobar que ninguno de los tres queda en pausa o bloqueado
  mientras el resto carga.
- **Esperado**: los tres activos conviven en la lista, EUR/USD sigue
  mostrando su badge «Divisa» y sus propios datos, el resto de activos no se
  pausa mientras llegan las velas de EUR/USD (criterio de aceptación 3).
- **Observado**: los tres símbolos se añaden sin error; EUR/USD muestra sus
  velas y badge correctamente sin impedir que SPY/QQQ sigan su propia carga en
  paralelo (banner «Poniéndose al día… Descargando 2 de 3 activos» visible
  mientras tanto, sin bloquear la interacción).
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-mercado-lista-mixta-1280.png`.
- **Veredicto**: cumple el criterio de aceptación 3 («sin pausar ni bloquear el
  resto de activos»).

### Paso 3. Resoluciones 1280×800 y 1024×700 sin desbordamiento

- **Pasos**: Con EUR/USD, SPY y QQQ en la lista y el gráfico de EUR/USD
  abierto, medir `scrollWidth - clientWidth` de `.market-chart-card` y de
  `.market-workspace` a 1280×800 y después a 1024×700.
- **Esperado**: 0 px de desbordamiento horizontal en ambas resoluciones.
- **Observado**: 0 px de desbordamiento en los cuatro casos medidos
  (`chartCard` y `workspace`, en ambas resoluciones).
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-mercado-lista-mixta-1280.png`,
  `docs/qa/capturas/perfiles-responsable-mercado-lista-mixta-1024.png`.
- **Veredicto**: cumple el criterio de aceptación 4.

### Paso 4. Caso límite — sin conexión a internet

- **Pasos**: Simular pérdida de conexión (`window.tradia.testing.simulateOffline(true)`)
  y comprobar el aviso, luego restaurarla.
- **Esperado**: aviso «Sin conexión» visible, sin que la app se quede en un
  estado roto.
- **Observado**: el badge «Sin conexión» aparece correctamente y desaparece al
  restaurar la conectividad simulada.
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-sin-conexion.png`.
- **Veredicto**: cumple.

### Paso 5. Caso límite — operar EUR/USD en la cartera simulada interna

- **Pasos**: Conectar la cuenta paper desde Ajustes (claves de prueba, como
  hace `e2e/paper-trading.spec.ts`) → ir a Órdenes → «Crear orden limitada» →
  Activo `EURUSD`, cantidad `1000`, precio límite `1.05` → «Enviar orden
  limitada». Como control, repetir la misma acción con `AAPL`.
- **Esperado** (comprobación explícita del usuario: «Realizar una operación
  paper sobre EUR/USD y verificar que se registra en la cartera simulada
  interna»): la orden se acepta y queda registrada.
- **Observado**: con la cuenta paper ya conectada, la orden de `AAPL` se envía
  y queda «Enviada» en la tabla de órdenes (control correcto). La orden de
  `EURUSD` **falla** con el mensaje genérico «No se pudo enviar la orden
  limitada. Comprueba la cuenta paper e inténtalo de nuevo.», que no explica
  el motivo real. Revisando el código (`src/main/broker/orderManager.ts:859-902`
  y `src/shared/fxTrading.ts`), el rechazo es intencionado: las divisas no
  llegan nunca al bróker (Alpaca no las opera) y solo se operan
  automáticamente «en la cartera simulada» cuando una estrategia emite una
  señal aprobada — no existe ninguna vía manual en la interfaz para que un
  usuario ejecute una operación paper de EUR/USD él mismo. El error específico
  que sí explica esto (`el bróker conectado no opera divisas; se opera solo en
  la cartera simulada`) se genera en el backend pero `OrdersPage.tsx` lo
  descarta en un `catch` genérico y muestra siempre el mismo texto, igual que
  si hubiera un problema de credenciales.
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-orden-eurusd.png` (fallo),
  `docs/qa/capturas/perfiles-responsable-orden-aapl-control.png` (control, éxito).
- **Veredicto**: **no cumple** la comprobación explícita del usuario tal y como
  está planteada en la interfaz hoy. Ver **UXP-1**.

---

## Incidencias

### UXP-1 — El único botón visible para «operar EUR/USD» manualmente falla con un mensaje que no explica por qué (Alta)

- **Dónde**: Órdenes › Crear orden limitada, con «Activo» = `EURUSD` (o
  `EUR/USD`).
- **Pasos para reproducir**:
  1. Conectar la cuenta paper en Ajustes (botón «Probar conexión» con claves
     de prueba).
  2. Ir a Órdenes → «Crear orden limitada».
  3. Escribir `EURUSD` en «Activo», una cantidad y un precio límite válidos.
  4. Pulsar «Enviar orden limitada».
- **Esperado**: o bien la orden se acepta y queda en la cartera simulada
  interna (como pide el criterio de aceptación 3 y la comprobación explícita
  del usuario «Realizar una operación paper sobre EUR/USD»), o bien, si no es
  posible operar manualmente, un mensaje específico que lo explique (p. ej.
  «Las divisas se operan solo de forma automática mediante las señales de tus
  estrategias en la cartera simulada interna; no se pueden enviar órdenes
  manuales de EUR/USD»).
- **Observado**: la orden de `EURUSD` siempre falla con «No se pudo enviar la
  orden limitada. Comprueba la cuenta paper e inténtalo de nuevo.» — el mismo
  texto genérico que se mostraría ante un fallo real de la cuenta paper. Una
  orden idéntica con `AAPL` sí se envía correctamente en la misma sesión,
  confirmando que el fallo es específico de la divisa y no un problema de la
  cuenta. El motivo real (el bróker conectado no opera divisas; esto es una
  decisión de diseño documentada en `src/shared/fxTrading.ts`) nunca llega al
  usuario.
- **Impacto**: recrea, dentro de la propia función que se construyó para
  resolver la queja del usuario, la misma sensación de «no puedo operar
  EUR/USD» sin explicación que motivó el feedback original. Un usuario que siga
  la ruta más intuitiva (Órdenes → Crear orden limitada) para cumplir la
  comprobación «Realizar una operación paper sobre EUR/USD» concluirá que la
  función no funciona, cuando en realidad el diseño exige que sea una
  estrategia automática la que opere el par.
- **Severidad**: alta.
- **Rol**: frontend (`src/renderer/src/components/orders/OrdersPage.tsx`,
  función `submitCreate`, línea ~106: el `catch` descarta el mensaje de error
  específico que sí llega desde `window.tradia.orders.create(...)` y lo
  sustituye siempre por el texto genérico).
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-orden-eurusd.png`,
  `docs/qa/capturas/perfiles-responsable-orden-aapl-control.png`.

### UXP-2 — El aviso «Poniéndose al día…» aparece duplicado en Mercado (Media)

- **Dónde**: Mercado (y Macro), con activos todavía descargando datos.
- **Pasos para reproducir**:
  1. Abrir Mercado con varios activos recién añadidos a la lista de
     seguimiento (p. ej. EUR/USD, SPY, QQQ).
  2. Observar la zona superior de la página mientras los datos siguen
     descargándose.
- **Esperado**: un único aviso de actualización de datos, sin duplicar el
  mismo mensaje y el mismo enlace «Ver detalles» dos veces seguidas.
- **Observado**: el mensaje «Poniéndose al día… Descargando N de M activos.
  Régimen, predicciones y señales esperan a terminar. ▸ Ver detalles» aparece
  dos veces: una vez en el banner global de la app (`ProviderBanner`, que se
  renderiza fuera de la página, encima del contenido) y otra vez dentro de la
  propia página de Mercado (`DataFreshness` dentro de `MarketDataPage.tsx`,
  línea 48). Ambos leen el mismo estado y muestran el mismo texto, ocupando
  espacio vertical duplicado antes de llegar al buscador y a la lista de
  seguimiento.
- **Impacto**: no bloquea ninguna función, pero es ruido visual y contradice el
  criterio de «ausencia de solapes» que debe revisar el perfil Responsable de
  equipo; en pantallas compactas (1024×700) empuja el buscador y la lista más
  abajo de lo necesario.
- **Severidad**: media.
- **Rol**: frontend (`src/renderer/src/components/ProviderBanner.tsx` +
  `src/renderer/src/components/MarketDataPage.tsx:48`, ambos instancian
  `DataFreshness` con el mismo estado).
- **Evidencia**: `docs/qa/capturas/perfiles-responsable-mercado-lista-mixta-1024.png`
  (se ve el primer banner global y, justo debajo del subtítulo de la página,
  el segundo banner idéntico).
- **Nota**: no se ha podido confirmar si esta duplicación ya existía antes de
  esta misión (el componente `DataFreshness` no aparece en la lista de
  archivos tocados por las tareas de esta misión) o si es consecuencia
  indirecta de los cambios; se reporta igualmente porque el criterio de esta
  sesión pide explícitamente comprobar la ausencia de solapes en Mercado.

---

## Valoración final sobre la frustración del usuario

La queja original tenía dos partes y ambas quedan sustancialmente resueltas:

1. **«No puedo conectar Claude, debería dejarme elegir de un desplegable»**:
   resuelto. El desplegable de Ajustes ofrece las cinco opciones pedidas, con
   autodetección del primer CLI disponible (tal y como decidió el usuario) y
   mensajes de prueba de conexión claros y accionables. Ya no hay ningún
   bloqueo permanente: si la IA elegida no conecta, la app explica qué hacer y
   sigue funcionando con el analizador local.
2. **«En Mercado debería poder añadir lo que quiera, como EUR/USD, con un
   buscador y un gráfico de velas»**: resuelto en la parte de descubrimiento y
   visualización. El buscador encuentra EUR/USD al instante, lo añade con un
   clic, muestra su cotización a 4 decimales y sus velas diarias con medias
   móviles, y los paneles de RSI/ATR se pueden ocultar para ver las velas más
   grandes, todo sin desbordar la pantalla en 1280×800 ni 1024×700. **No
   obstante**, la parte de «operar» EUR/USD con dinero simulado no está resuelta
   de forma transparente para el usuario: la única vía manual visible (Órdenes
   › Crear orden limitada) falla sin explicación (UXP-1). Si el usuario
   interpreta «operar en la cartera simulada» como poder enviar una orden él
   mismo —como hace con cualquier acción—, volverá a sentir que «no puede»
   hacerlo con EUR/USD, aunque el motivo ahora sea una decisión de diseño (solo
   las estrategias automáticas operan divisas) y no un fallo de conexión.

**Conclusión**: la app ya no es la «muy difícil de usar» que describía el
usuario para elegir su IA y para descubrir y visualizar activos nuevos como
EUR/USD. Para cerrar del todo la frustración sobre «operar» EUR/USD hace falta
que el equipo de frontend corrija UXP-1 (mensaje específico, o una vía manual
real) antes de dar por resuelta la comprobación de «Realizar una operación
paper sobre EUR/USD».

---

## Batería automática

No se ha encontrado todavía `docs/qa/e2e-mejoras-tradia.md` en el repositorio
en el momento de esta sesión (la tarea «Pruebas E2E: Desplegable de IA,
buscador y gráfico de velas con EUR/USD» seguía en curso en paralelo, con
`e2e/mejoras-mercado-ajustes.spec.ts` ya escrito pero sin commitear). No se ha
ejecutado esa suite para no interferir con el trabajo en curso de esa tarea
hermana ni condicionar su resultado; sus hallazgos, cuando se publiquen, deben
cruzarse con este informe antes del cierre.

Se ha ejecutado `npm run format:check` sobre el estado del repositorio al
cerrar esta sesión: falla únicamente por `e2e/mejoras-mercado-ajustes.spec.ts`
(archivo todavía sin formatear de la tarea E2E en curso, no tocado por esta
sesión); ningún archivo de esta entrega incumple el formato.

---

## Sesiones (resumen estructurado)

Ver bloque `ORQUESTA_FINDINGS_START` al final de la respuesta de esta tarea
para el resumen estructurado de sesiones y hallazgos.
