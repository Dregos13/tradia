# Tareas del usuario

Lo que solo tú puedes hacer: necesita tus cuentas, tus claves, tu dinero o
tu firma. Las pruebas automáticas (`npm test`, `npm run test:e2e`) usan
proveedores simulados y no sustituyen ninguna de estas comprobaciones.

Cada tarea dice los pasos, el comando y el resultado esperado. Hazlas en
este orden: las primeras no tienen riesgo y las últimas mueven dinero real.

El análisis de noticias **no usa ninguna API de pago**: funciona con tu
suscripción de Claude (CLI de Claude Code) o con el analizador local, sin
coste. No necesitas ninguna clave de Anthropic.

## Reglas sobre las claves

- **Nunca** pegues una clave en un archivo del repositorio (`.env`,
  `package.json`, scripts, documentos ni capturas que vayas a subir).
- En la app, las claves se guardan en **Ajustes** y se cifran con el
  almacén del sistema. No salen del proceso principal.
- En la terminal, pásalas solo como variables de entorno del comando.
  Para que no queden en el historial del shell, léelas sin eco:

  ```bash
  read -rs TIINGO_API_KEY && export TIINGO_API_KEY   # pega y pulsa Intro
  ```

  Al cerrar la terminal desaparecen. Ningún script de `qa:*` ni de
  `eval:*` imprime la clave, tampoco en los errores.

## Resumen de comandos

| Comando                                                 | Sin argumentos                      | Para qué                                    |
| ------------------------------------------------------- | ----------------------------------- | ------------------------------------------- |
| `npm run eval:news-llm -- --provider local`             | Evalúa con el analizador local      | Comprobar el conjunto etiquetado sin coste  |
| `npm run eval:news-llm -- --provider suscripcion`       | —                                   | Evaluar con la CLI de Claude Code           |
| `npm run qa:providers`                                  | Muestra el uso y sale sin consultar | Probar las claves de Tiingo y FRED          |
| `npm run qa:alpaca-paper`                               | Muestra el uso y sale sin consultar | Probar el adaptador contra la cuenta paper  |
| `npm run qa:alpaca-live-smoke`                          | Muestra el uso y sale sin enviar    | Prueba de humo con dinero real (1 USD)      |
| `npm run dist` / `dist:mac` / `dist:win` / `dist:linux` | Empaqueta en `release/`             | Instaladores para probar la app empaquetada |

## 0. Actualiza `main` y lanza la CI de la pull request

Tu `main` local va por detrás de `origin/main`. Antes de revisar o fusionar
la pull request de esta misión:

1. En la carpeta principal del proyecto (no en un worktree de Orquesta):

   ```bash
   git fetch origin
   git switch main
   git merge --ff-only origin/main
   ```

   Esperado: «Fast-forward» o «Already up to date». Si dice que no puede
   avanzar sin fusión, tienes commits locales en `main` que no están en
   `origin/main`: revísalos con `git log origin/main..main` antes de seguir.

2. En Orquesta, abre la pestaña **Git** de la pull request y lanza la CI.
   Esperado: `typecheck`, `lint`, `format:check`, `npm test` y
   `npm run test:e2e` en verde en las tres plataformas que tenga
   configuradas.
3. Si quieres repetirlo en tu equipo: `npm ci`, y después los mismos
   comandos uno a uno.

## 1. Análisis de noticias con tu suscripción de Claude

Antes, revisa que las condiciones de tu suscripción de Claude permiten este
uso personal automatizado desde la CLI. Si prefieres no usarla, elige el
analizador local en Ajustes y salta esta tarea.

1. Instala la CLI de Claude Code si no la tienes y comprueba que responde:

   ```bash
   claude --version
   ```

2. Inicia sesión con tu suscripción: ejecuta `claude`, escribe `/login`,
   sigue el navegador y sal con `/exit`.
3. En la app, ve a **Ajustes › Análisis de noticias**, en **«Proveedor de análisis»** elige
   «Suscripción (Claude Code)» y pulsa **«Probar de nuevo»** (el botón se
   llama así también la primera vez).
   - Esperado: correcto con la latencia.
   - «CLI no encontrada»: indica la ruta de `claude` en el campo de la
     ruta (la da `which claude`).
   - «Sesión no iniciada»: repite el paso 2.
4. Evalúa sobre el conjunto de titulares etiquetados:

   ```bash
   npm run eval:news-llm -- --provider suscripcion
   ```

   Si `claude` no está en el PATH: `CLAUDE_CLI_PATH=/ruta/a/claude npm run eval:news-llm -- --provider suscripcion`.

   Esperado: el acierto en activo y en sentimiento por encima de sus
   umbrales, la línea final «SUPERA los umbrales documentados» y el uso del
   día por debajo del tope diario (`NEWS_LLM_DAILY_CAP`, 200 titulares).
   Como referencia sin coste, `--provider local` debe dar lo mismo.

5. Comprueba el aviso con la app abierta, cerrando la sesión de verdad:
   1. Deja Tradia abierta con «Suscripción (Claude Code)» elegida y
      funcionando (paso 3 correcto).
   2. En una terminal ejecuta `claude`, escribe `/logout` y sal con
      `/exit`.
   3. Espera a la siguiente lectura de noticias (o pulsa «Probar de nuevo»
      en Ajustes para ver el motivo enseguida).
   - Esperado: **una** notificación del sistema «Tradia usa el analizador
     local» (no una por titular). En **Noticias** y en **Ajustes** aparece
     «Suscripción no disponible · sesión no iniciada» con el paso para
     resolverlo y el texto de que mientras tanto se usa el analizador local.
   4. Vuelve a iniciar sesión (`claude`, `/login`, `/exit`).
   - Esperado: otra notificación, «Suscripción de Claude recuperada», y el
     aviso desaparece de Noticias y de Ajustes.
   - Si al abrir la app la CLI ya no se encuentra, también llega **una**
     notificación al arrancar (con el texto de «CLI no encontrada»).

Si la suscripción falla en uso (sesión caducada, CLI no encontrada o tope
diario), la app te avisa **una vez** con una notificación del sistema y
muestra el motivo y el paso para resolverlo en Ajustes y en Noticias;
mientras tanto los titulares se analizan con el analizador local, sin
perderse, y al volver la sesión llega otra notificación. No hay API de
pago: si venías de una versión que la tenía, su clave guardada se borra
sola la primera vez que la app la encuentra.

## 2. Claves de Tiingo y FRED

1. Consigue las claves en las webs de Tiingo y de FRED (St. Louis Fed).
2. En **Ajustes › Proveedores de datos**, guarda cada clave y pulsa
   **«Probar conexión»** en cada proveedor.
   - Esperado: «Conectado» con la fecha del último dato disponible.
   - Si no, el motivo exacto: sin clave, clave rechazada, cuota agotada o
     sin red. Corrige y vuelve a probar.
3. Repite la prueba desde la terminal, con los adaptadores reales:

   ```bash
   read -rs TIINGO_API_KEY && export TIINGO_API_KEY
   read -rs FRED_API_KEY && export FRED_API_KEY
   npm run qa:providers
   ```

   Esperado: `ok` en los dos, con la fecha del último dato, y salida 0.
   Comprueba que esa fecha coincide con la web del proveedor (cotización de
   SPY en Tiingo y serie VIXCLS en FRED). Salida 1: algún proveedor falla
   (el motivo sale en pantalla). Salida 2: no había ninguna clave.

4. Con las claves guardadas, la franja «Datos desactualizados» debe
   desaparecer tras la puesta al día. Si sigue, usa sus acciones para
   resolverlo.

## 3. Reentrenar el modelo con datos reales

El entorno virtual va **fuera del repositorio** para que nunca se suba.
Detalle completo en `ml/README.md`.

1. Crea el entorno e instala las dependencias (macOS necesita además
   `brew install libomp`):

   ```bash
   python3 -m venv ~/.venvs/tradia-ml
   ~/.venvs/tradia-ml/bin/pip install -r ml/requirements.txt
   ```

2. Cierra la app y exporta las velas limpias de tu base de datos:

   ```bash
   ~/.venvs/tradia-ml/bin/python ml/export_candles.py --out ml/data/velas.csv
   ```

   Si no encuentra la base, indícala con `--db` (en macOS,
   `~/Library/Application\ Support/tradia/tradia.db`). Ayuda:
   `~/.venvs/tradia-ml/bin/python ml/export_candles.py --help`.

3. Entrena declarando el origen real:

   ```bash
   ~/.venvs/tradia-ml/bin/python ml/train.py --data ml/data/velas.csv --origin real
   ```

4. Abre `resources/models/<versión>/model-card.json` y comprueba que el
   Brier fuera de muestra es **menor** que el de referencia. Si no lo es,
   la ficha queda no apta y la app no usará el modelo para las señales.
5. Abre la app: en **IA › Ficha del modelo** deben verse la nueva versión,
   el periodo de entrenamiento y de prueba, el Brier y la calibración.
6. Comprueba que no se ha colado nada del entorno: `git status` no debe
   listar ningún entorno virtual (`ml/data/` tampoco se versiona).

## 4. App empaquetada en macOS, Windows y Linux

Cada instalador se genera en su propio sistema:

```bash
npm install
npm run dist:mac      # en macOS  → release/*.dmg
npm run dist:win      # en Windows → release/*.exe
npm run dist:linux    # en Linux  → release/*.AppImage y *.deb
```

En cada sistema:

1. Instala y abre la app (sin firmar: acepta el aviso de Gatekeeper o de
   SmartScreen).
2. Con un perfil vacío, el **tour guiado** aparece la primera vez y no se
   salta el aviso de riesgo.
3. En **IA**, la ficha del modelo carga (el módulo nativo de
   onnxruntime-node funciona) y se muestran predicciones por activo.
4. La pantalla «Dinero real» sigue bloqueada: en la app empaquetada la
   evidencia sembrada de las pruebas no cuenta.
5. **Solo en Windows: `claude.cmd` sin `spawn EINVAL`.** Si instalaste
   Claude Code con npm, la CLI es un `claude.cmd`, que Node no deja lanzar
   directamente.
   1. En PowerShell, `where.exe claude` debe listar la ruta (por ejemplo,
      `…\AppData\Roaming\npm\claude.cmd`) y `claude --version` debe
      responder.
   2. En la app empaquetada, ve a **Ajustes › Análisis de noticias**,
      elige «Suscripción (Claude Code)» y pulsa **«Probar de nuevo»**. Si no
      la encuentra sola, pega esa ruta en «Ruta de Claude Code (opcional)».
   3. Desde la carpeta del proyecto, ejecuta
      `npm run eval:news-llm -- --provider suscripcion`.
   - Esperado: la prueba sale correcta con su latencia y la evaluación
     termina. En ningún sitio (Ajustes, Noticias ni la terminal) aparece
     `spawn EINVAL`. Si aparece, anota la ruta exacta de `claude` y la
     versión de Node (`node --version`) y avísanos.

## 5. Revisión legal y fiscal, plan de contingencia y paper

Estos requisitos de la lista de **Dinero real** son declaraciones tuyas: la
app solo guarda el texto que firmas y la fecha. En las pruebas se marcan
con datos sembrados; en tu app, márcalos solo cuando sean ciertos.

1. **Revisión legal y fiscal** con profesionales: régimen aplicable en
   España (CNMV / MiFID II) y tributación de las operaciones (IRPF).
2. **Plan de contingencia** escrito: qué haces si cae la app, el broker o
   la red, cómo cierras posiciones a mano y a quién avisas. Guárdalo fuera
   del repositorio; en la declaración puedes poner una nota o ruta local.
3. **Paper trading real durante meses**: la lista exige al menos 91 días y
   30 operaciones cerradas con un resultado dentro de ±30 % del backtest.
   Esto se cumple solo; no se puede marcar a mano.
4. Prueba la parada (botón de «Probar parada») y envía una alerta de
   prueba por Telegram o correo: ambos requisitos se cumplen solos.

## 6. Prueba de humo con dinero real en Alpaca

Mueve dinero real (1 USD de SPY). Hazla al final, con todo lo anterior.

1. En el panel de Alpaca genera claves **live** sin permiso de retirada de
   fondos y declara ese hecho en la lista de comprobación.
2. Antes, si quieres, valida el adaptador con tu cuenta **paper** (claves
   `PK…`):

   ```bash
   read -rs APCA_API_KEY_ID && export APCA_API_KEY_ID
   read -rs APCA_API_SECRET_KEY && export APCA_API_SECRET_KEY
   npm run qa:alpaca-paper
   ```

   Esperado: las órdenes de prueba aparecen canceladas en el panel paper.

3. Completa los siete requisitos de **Dinero real**, guarda los límites y
   confírmalos con la frase escrita.
4. Con las claves **live** (`AK…`) en el entorno de una terminal nueva:

   ```bash
   npm run qa:alpaca-live-smoke
   ```

   Escribe `CONFIRMO` cuando lo pida. Esperado: compra de 1 USD nocional,
   ejecución, venta de cierre y listado de posiciones y órdenes sin
   posición abierta.

5. En el panel web de Alpaca comprueba que la orden, el cierre y el saldo
   coinciden con lo que muestra la app en **Órdenes** y en el **Diario**
   (hora, precio pedido, precio ejecutado y slippage).
6. Escala capital solo si los resultados reales respaldan el backtest
   («Estado del escalado» en `docs/dinero-real.md`).

## 7. Corto con dinero real en Alpaca

Las estrategias, también las propias, pueden abrir cortos con dinero real,
pero solo si tú lo habilitas. Hazlo después de la prueba de humo (§6) y
solo si lo quieres: sin estos pasos el corto con dinero real queda
**desactivado** y las órdenes de entrada en corto se rechazan.

1. **Cuenta de Alpaca preparada para el corto** (en su panel web):
   - cuenta **de margen** (no de efectivo) con el préstamo de títulos
     habilitado (el corto activado, `shorting_enabled`);
   - al menos **2 000 USD** de capital en la cuenta (suelo de margen de
     EE. UU.);
   - el título que vayas a vender debe estar disponible para préstamo
     (`shortable` y `easy_to_borrow`). Si no lo está, la app rechaza la
     orden con ese motivo.
2. **Fija los límites del corto** en **Ajustes › Límites de capital real**.
   Vienen a 0, y con cualquiera a 0 el corto sigue desactivado. Los techos
   fijos (tu valor debe ser igual o menor) son:
   - «Máximo por orden en corto»: **100 USD**;
   - «Exposición corta total máxima»: **200 USD**;
   - «Posiciones cortas simultáneas»: **1**;
   - además, cada corto lleva siempre un stop de compra como máximo al
     **5 %** por encima de la entrada (no se configura: lo exige la app).
3. Pulsa «Guardar límites» y después **«Confirmar límites y activar dinero
   real»**, escribiendo la frase que incluye los límites del corto.
   Esperado: la ficha de una estrategia con reglas de corto pasa a decir
   que el corto con dinero real está permitido por los límites
   confirmados, sujeto al motor de riesgo de cada orden.
4. Ten en cuenta el riesgo: en corto la pérdida no tiene tope natural y un
   salto de precio puede superar el stop. Empieza con importes por debajo
   de los techos.
5. Cuando se ejecute el primer corto, cuadra en el panel de Alpaca la venta
   de entrada (venta stop, nunca a mercado), el stop de compra y la
   recompra con lo que muestran **Órdenes** y el **Diario**.

## Al terminar

Cierra la terminal (las variables de entorno con las claves se pierden) y
revisa con `git status` que no hay archivos nuevos con datos tuyos.
