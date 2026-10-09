# Diseño de fase 3 · Motor de riesgo con veto

Esta fase amplía **Cuaderno cuantitativo** sin crear una identidad paralela. La interfaz debe sentirse como una hoja de control auditable: límites explícitos, valores medidos, decisiones legibles y una salida de emergencia imposible de confundir. La especificación visual ejecutable está en `src/renderer/src/design/risk.tokens.json`; las maquetas y la guía de entrega están en `.orquesta/design/6b8bbe06/`.

## Arquitectura de la pantalla

La ruta `#riesgo` tiene dos zonas principales. La columna de **Límites** ocupa aproximadamente 4/12 del ancho y agrupa reglas por operación, pérdidas, exposición y cautela. La zona **Registro de vetos** ocupa 8/12 y conserva la tabla como elemento dominante, de modo que motivo y valores sean visibles sin desplazamiento en escritorio amplio. Debajo, el **Probador de señales** se presenta como herramienta secundaria, siempre rotulada `Simulación`. A menos de 980 px las zonas se apilan; a menos de 700 px la tabla mantiene desplazamiento horizontal y los campos pasan a una columna. Es una aplicación de escritorio responsive, no una interfaz móvil primaria.

No se anidan tarjetas. Cada grupo usa una sección de papel con cabecera y divisores. Los números, porcentajes, fechas y ratios usan la familia numérica y cifras tabulares.

## Parada en la cabecera

`Parada` permanece visible en la cabecera, a la derecha de las acciones y antes del estado de conexión. Área mínima: 44 × 44 px. Usa un octógono con cuadrado interior, texto y color; el color nunca comunica el estado por sí solo.

| Estado | Etiqueta | Presentación | Acción |
| --- | --- | --- | --- |
| Normal | `Parada` | contorno crítico, icono stop | Un clic activa inmediatamente, sin confirmación. |
| Activa | `Parada activa` | fondo crítico, icono stop, `aria-pressed="true"` | Abre el flujo de reanudación; nunca reactiva directamente. |
| Reanudando | `Reanudando…` | cobalto, indicador giratorio más texto | Deshabilitado, `aria-busy="true"`. |

Al activarse aparece bajo la cabecera un banner global con `role="alert"`: **“Parada activa: {causa} · {hora local con zona} · Activada por {persona/sistema}”**. Incluye `Ver en Riesgo` y `Reanudar`. Permanece visible tras reiniciar la app mientras siga activa. No se cierra.

### Confirmación de reanudación

El diálogo protegido lleva el título `Confirmar reanudación`, el texto `Volverán a admitirse señales y órdenes. La causa de la parada seguirá en el registro.`, un resumen de causa, hora y autor, y las acciones `Mantener parada` (foco inicial) y `Confirmar y reanudar`. Escape y cerrar equivalen a mantener la parada. Durante la petición, la acción confirma con `Reanudando…`; si falla, el diálogo permanece abierto y muestra `No se pudo reanudar. La parada sigue activa. Inténtalo de nuevo.`

## Límites y validación

Encabezado: `Límites de riesgo`, estado de guardado y la nota persistente con icono de candado: **“Estas reglas no las puede cambiar la IA”**. Cada campo muestra etiqueta, valor, unidad, `Predeterminado: …` y el margen duro cuando exista. `Restablecer valores prudentes` restaura el grupo completo, no guarda automáticamente.

Valores prudentes y márgenes:

| Grupo | Regla | Predeterminado | Margen duro / condición |
| --- | --- | ---: | --- |
| Por operación | Riesgo por operación | 0,5 % | 0,5–2 % |
| Por operación | Stop | Obligatorio | no editable |
| Por operación | Beneficio/riesgo mínimo | 1:2 | mínimo 1:2 |
| Pérdidas | Diaria / semanal / mensual | 2 % / 4 % / 6 % | mayores que 0; los límites derivados del contrato mandan |
| Pérdidas | Drawdown máximo | 10 % | activa la parada al alcanzarse |
| Exposición | Posiciones abiertas | 5 | entero positivo |
| Exposición | Por activo / sector / divisa no USD | 20 % / 30 % / 25 % | 0–100 % |
| Exposición | Correlación a 60 días | 0,7 | −1 a 1 |
| Exposición | Apalancamiento | 1× | fijo, no editable |
| Exposición | Volumen medio de 20 días | 1 % | máximo por posición |

El frontend puede anticipar la validación, pero el error del proceso principal se muestra literalmente. El campo inválido usa `aria-invalid`, se enlaza por `aria-describedby` y conserva el valor para corregirlo. Ejemplos: `Introduce un riesgo entre 0,5 % y 2 %.` y `El ratio mínimo no puede ser inferior a 1:2.` El error añade icono, texto y borde; no depende del rojo. `Guardar límites` queda disponible para que el servidor sea la autoridad. Tras éxito: `Límites guardados · {hora}` con `role="status"`. Si la carga inicial falla, se conserva la última instantánea cuando exista y se muestra `No se pudieron actualizar los límites` con `Reintentar`.

## Registro de vetos

Título `Registro de vetos`, contador y filtro `Todas las reglas` / regla concreta. La tabla ordena de más reciente a más antigua y contiene: `Fecha`, `Activo`, `Regla`, `Motivo`, `Valores`. La fecha visible es local e incluye segundos; el valor `datetime` conserva ISO. El motivo es lenguaje humano, por ejemplo: `Falta el stop obligatorio` o `Ratio 1:1,5; el mínimo es 1:2`. `Valores` compara observado y límite (`Observado 1,5 · Mínimo 2,0`) y nunca expone solo un código interno.

- Cargando: filas esqueleto sin datos ficticios, tabla con `aria-busy="true"` y texto accesible `Cargando vetos…`.
- Vacío general: `Todavía no hay vetos` y `Las señales rechazadas aparecerán aquí con la regla y los valores.`
- Vacío filtrado: `No hay vetos para esta regla` y acción `Quitar filtro`.
- Error: `No se pudo cargar el registro de vetos` más `Reintentar`; no sustituir la tabla por una pantalla completa.
- Nuevo veto: se inserta arriba; se anuncia por una región `aria-live="polite"` sin mover el foco.

En ventanas estrechas se preservan todas las columnas con desplazamiento horizontal, sombra interior sutil y texto `Desplázate para ver valores`; no se oculta la causa ni los valores.

## Probador de señales

El encabezado comienza con la insignia con icono **`Simulación`**, seguido de `Probador de señales`. Texto fijo: `No envía órdenes al mercado. Evalúa la señal con la cartera simulada.` Campos: activo, dirección, entrada, stop, objetivo, confianza y origen. La acción es `Evaluar señal` y durante carga `Evaluando…`.

La respuesta siempre nombra la decisión:

- `Aprobada · Tamaño calculado: {n} unidades`.
- `Tamaño reducido al 50 % · {evento de cautela}`.
- `Vetada · {motivo legible}` y comparación observado/límite.
- Error técnico: `No se pudo evaluar la señal. No se envió ninguna orden.` con `Reintentar`.

Tras un veto, el registro se actualiza en directo. No usar “operación ejecutada” ni celebraciones: es una simulación de una decisión de riesgo.

## Modo cautela

Cuando no está activo no ocupa espacio global; su estado se resume dentro del grupo Cautela. Cuando está activo aparece antes de las dos zonas principales con `role="status"`, icono de triángulo y el título `Modo cautela activo`.

- Reducción: `VIX 35 · El tamaño de las nuevas señales se reduce al 50 %.` Insignia `Tamaño × 0,5`.
- Bloqueo: `IPC de EE. UU. en 10 min · Se bloquean nuevas señales hasta las 14:00.` Insignia `Entradas bloqueadas`.

Mostrar nombre del evento, intervalo efectivo y efecto; nunca solo “calendario activo”. Si hay varias causas, se enseña la más restrictiva y `+{n} causas`, desplegable. El modo cautela no se presenta como parada: la cabecera sigue mostrando el control `Parada` normal salvo que la parada esté activa.

## Bandeja y notificación crítica

Menú normal: `Parada de emergencia`. Al activarla cambia a `Reanudar (requiere confirmar)` y abre la ventana en Riesgo para confirmar; la bandeja no reanuda directamente. Tooltip activo: `Tradia — Parada activa`. El estado `stopped` tiene prioridad visual sobre `paused` y `offline`.

Notificación:

- Título: `Tradia ha activado la parada`.
- Cuerpo: `{causa}. Señales y órdenes detenidas desde las {hora}. Abre Riesgo para revisar y reanudar.`
- Acción conceptual al pulsar: abrir/focalizar la app en `#riesgo`.

Para activación manual: causa `Parada manual` y autor `Tú`. Para causas automáticas usar textos completos: `Pérdida anómala`, `Dato de mercado anómalo`, `Sin conexión durante más de 60 s` o `Comportamiento errático del modelo`; autor `Sistema`.

## Accesibilidad e implementación

- WCAG 2.2 AA; textos críticos usan pares de `riskStatus` probados sobre su superficie.
- Foco exterior de 3 px con 2 px de separación. No retirar el foco nativo sin sustituirlo.
- Objetivos interactivos de al menos 44 × 44 px. Tablas, unidades y errores deben soportar zoom al 200 %.
- Estado por icono + etiqueta + color. Los iconos decorativos usan `aria-hidden`; el control conserva nombre accesible completo.
- `prefers-reduced-motion` elimina giro y transiciones. La información nunca depende de animación.
- El botón de parada precede a navegación secundaria en el orden de tabulación. El diálogo captura foco y lo devuelve al disparador.
- Mantener textos comprobables o añadir `data-testid` semánticos para `Parada`, `Parada activa`, `Confirmar y reanudar`, `Estas reglas no las puede cambiar la IA`, `Simulación`, `Evaluar señal`, `Registro de vetos` y `Modo cautela activo`.

## Estados mínimos que debe cubrir frontend

1. Operativo sin vetos (vacío).
2. Carga inicial de límites y vetos.
3. Error de carga y error en línea al editar un margen duro.
4. Veto nuevo visible con regla, motivo y valores.
5. Cautela con reducción y cautela con bloqueo.
6. Parada activa manual o automática, persistente.
7. Reanudación: diálogo, petición y fallo sin levantar la parada.
8. Probador: reposo, evaluando, aprobada, reducida, vetada y error técnico.
