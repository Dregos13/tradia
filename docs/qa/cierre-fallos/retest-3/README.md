# Regresión R1–R4 (retest-3) · 12 oct 2026

Comprobación de las correcciones de `be-fix-cierre-r1-r2` (53197ab2) y `fe-fix-cierre-r3-r4` (3919eab6).
El arnés de la app real es una copia de `../app-real/` que escribe aquí. Además, tras los 80 s sin red, captura IA (`c1-ia-sin-red`) e Inicio (`c1-inicio-tras-ia`).

Se lanza con `npx electron-vite build && npx playwright test -c docs/qa/cierre-fallos/retest-3 --grep "B0|C-largo"`.

| Hallazgo | Estado | Evidencia |
| --- | --- | --- |
| R1 · clave guardada con `\r` → «Sin conexión a internet.» | **Corregido** | Prueba temporal (ya borrada) con `secrets.getKey` sobre una fila sembrada `tk…SECRETO\rtiingo`. `getKey` lanza `InvalidStoredKeyError` y `classifyProbeError` devuelve `{status:'clave-rechazada', message:'La clave guardada tiene caracteres no válidos; vuelve a pegarla en Ajustes', reachedNetwork:false}`. No se llama a `fetch` y la clave no aparece en ningún texto. |
| R2 · motivos de «actualizando» en ISO | **Corregido** | `ingestion.ts:497,535,543` y `macro/service.ts:234` usan `sessionDateLabel`. App real: ninguna fecha AAAA-MM-DD en `c1-*.txt`, `c2-*.txt` ni `c5-*.txt`. |
| R3 · Inicio congelado en «Actualizando» sin red | **Corregido** | `c1-sin-red-80s.txt:122-135`: VIXCLS «◷ Desactualizado · falta la observación esperada; último dato: 17 sept 2026». Coincide con `c1-estado-80s.json` (`macro:VIXCLS` `desactualizado`). |
| R4 · «fecha del último dato no disponible» sin red | **Corregido** | `e2e/stale-data.spec.ts:225` en verde: los paneles dicen «Sin conexión · datos del 6 oct 2026. No se pudo comprobar si hay datos más recientes.». App real sin red y con datos viejos (`c1-ia-sin-red.txt:30,44,61,73`): una sola fecha, «desde el 17 sept 2026», y nunca «no disponible». |

Batería (`comandos/`): `typecheck`, `lint` y `format:check` en verde. `npm test`: 183 archivos y 2505 pruebas. `test:e2e`: 47 pruebas. `stale-data.spec.ts`: 2 de 2. App real: B0 y C-largo pasan. No hay ningún `it.fails`, `fixme`, `.skip(` ni `.only(` en `src` ni en `e2e`.

## Hallazgo nuevo (efecto secundario de R1)

**R5 · Baja · Backend: una clave guardada con un espacio al principio o al final, que antes funcionaba, ahora se rechaza como «caracteres no válidos».**

- **Pasos:** en `main`, `setKey` guardaba la clave tal cual, sin recortarla. El campo de Ajustes tampoco la recortaba (`SettingsPage.tsx:285` de main). Una clave de Tiingo o de Alpaca pegada con un espacio final funcionaba, porque `Headers` quita los espacios de los extremos: `new Headers({Authorization:'Token abc '}).get('authorization')` → `"Token abc"`. Con esta rama, al leerla con `getKey`…
- **Esperado:** el mismo criterio que `setKey`, que recorta los extremos y solo rechaza controles o espacios **dentro** de la clave. La clave debe seguir funcionando.
- **Observado:** `getKey` lanza `InvalidStoredKeyError` para `'tkSECRETOtiingo '` y para `' tkSECRETOtiingo'` (`secrets.ts:142`). La ingesta de Tiingo pasa a «desactualizado» con «vuelve a pegarla». Las credenciales de Alpaca (`broker/index.ts:362`, `live/broker.ts:381`) y la clave del LLM también fallan, cuando antes funcionaban.
- **Evidencia:** prueba temporal (`RT3 "tkSECRETOtiingo " {"err":"InvalidStoredKeyError",…} {"status":"clave-rechazada",…}`).
- **Sugerencia:** `getKey` debería aplicar `trim()` antes de validar.
