# Cierre de fallos (continuación): observación nueva

_Claude · Predeterminado (Testing) · 13-10-2026 · `HEAD` = `d12b7734`. Las puertas están en verde y los dos fallos abiertos están cerrados (`docs/qa/estado-pendientes.md`, «Cierre de los dos fallos abiertos»). Aquí solo se describe lo nuevo._

## C1 · Al insertar un ejemplo, el campo muestra «está vacío» durante ~200 ms · gravedad baja · frontend

**Perfil:** Profesional independiente que organiza varios proyectos.

**Pasos**

1. Abre la app (para reproducirlo, con `TRADIA_E2E` y `launchPhaseApp` de `e2e/phase-6-7.helpers.ts`).
2. Estrategias › «Nueva estrategia».
3. Con el campo Objetivo vacío, pulsa «Sin objetivo».
4. Lee la zona de resultado del campo (`#…-result`, `aria-live="polite"`) a los 100, 500, 1.500 y 3.000 ms.

**Esperado:** en cuanto el campo pasa a `ninguno`, el resultado dice «Válida» (o, como mucho, conserva el texto anterior hasta validar).

**Observado:**

- A 100 ms: el campo ya contiene `ninguno`, pero se muestra en rojo «el campo de objetivo está vacío: escribe «ninguno», un porcentaje como «5%» o un múltiplo como «2 * atr(14)» · caracteres 1–1.». También queda `aria-invalid` y, por `aria-live`, se puede anunciar.
- A 500 ms y después: «Válida».

**Evidencia:** `docs/qa/capturas/cierre-o2-aviso-transitorio.png` (a 100 ms) y `docs/qa/capturas/cierre-o2-sin-objetivo.png` (estable).

**Causa probable (sin tocar código):** `src/renderer/src/components/strategies/StrategyForm.tsx:83-87` publica la validación con 200 ms de retraso (`visibleValidation`). En cambio, `RuleEditor.tsx` (resultado en `:103-121`) pinta el valor nuevo enseguida. Durante esos 200 ms se combina el valor nuevo con el error de «vacío» de la validación anterior, que no se veía mientras el campo estaba vacío. Seguramente pasa con cualquier botón «Insertar …» sobre un campo vacío. No afecta a O2: la ayuda del veto está siempre visible.

**Arreglo sugerido (para Frontend):** no mostrar un error cuyo texto no corresponde al valor actual. Por ejemplo, descartar `visibleValidation` si el borrador cambió y aún no se ha validado, o validar en el acto al insertar un ejemplo.
