# Tareas del usuario

Lo que solo tú puedes hacer: necesita tus cuentas, tus claves, tu dinero o
tu firma. Las pruebas automáticas (`npm test`, `npm run test:e2e`) usan
proveedores simulados y no sustituyen ninguna de estas comprobaciones.

Cada tarea dice los pasos, el comando y el resultado esperado. Hazlas en
este orden: las primeras no tienen riesgo y las últimas mueven dinero real.

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

| Comando                                               | Sin argumentos                       | Para qué                                        |
| ----------------------------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `npm run eval:news-llm -- --provider local`           | Evalúa con el analizador local       | Comprobar el conjunto etiquetado sin coste      |
| `npm run eval:news-llm -- --provider suscripcion`     | —                                    | Evaluar con la CLI de Claude Code               |
| `npm run eval:news-llm -- --provider api`             | —                                    | Evaluar con la API de Anthropic (de pago)       |
| `npm run qa:providers`                                | Muestra el uso y sale sin consultar  | Probar las claves de Tiingo y FRED              |
| `npm run qa:alpaca-paper`                             | Muestra el uso y sale sin consultar  | Probar el adaptador contra la cuenta paper      |
| `npm run qa:alpaca-live-smoke`                        | Muestra el uso y sale sin enviar     | Prueba de humo con dinero real (1 USD)          |
| `npm run dist` / `dist:mac` / `dist:win` / `dist:linux` | Empaqueta en `release/`            | Instaladores para probar la app empaquetada     |

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
3. En la app, ve a **Ajustes › Análisis de noticias**, elige
   «Suscripción (Claude Code)» y pulsa **«Probar»**.
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

5. (Opcional, de pago) Con la API de Anthropic: guarda la clave en Ajustes
   para la app y, para la evaluación, pásala solo en el entorno:

   ```bash
   read -rs ANTHROPIC_API_KEY && export ANTHROPIC_API_KEY
   npm run eval:news-llm -- --provider api
   ```

   Esperado: además de la precisión, el coste estimado por titular y el
   gasto dentro del presupuesto (`NEWS_LLM_MONTHLY_BUDGET_EUR`, 30 €).

## 2. Claves de Tiingo y FRED

1. Consigue las claves en las webs de Tiingo y de FRED (St. Louis Fed).
2. En **Ajustes › Datos de mercado**, guarda cada clave y pulsa
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

## Al terminar

Cierra la terminal (las variables de entorno con las claves se pierden) y
revisa con `git status` que no hay archivos nuevos con datos tuyos.
