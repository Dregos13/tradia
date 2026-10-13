# Diseño · requisitos del corto con dinero real

Contrato de experiencia para **Ajustes › Límites de capital real**. La especificación visual completa y la maqueta de esta misión están en `.orquesta/design/22ccc436/`; este documento fija las decisiones que debe conservar la implementación.

## Objetivo

Antes de permitir límites del corto mayores que 0, la pantalla muestra y exige:

1. Cuenta live de Alpaca con margen, corto habilitado y al menos 2.000 USD de capital.
2. Declaración específica `revision-legal-corto` sobre ventas en corto (CNMV/MiFID II) y su fiscalidad (IRPF).
3. Evidencia automática `paper-cortos`: al menos 4 semanas, 5 cortos cerrados y ningún descuadre de conciliación paper abierto en el periodo.

Los requisitos del largo no cambian. Los techos del corto siguen en 100 USD por orden, 200 USD de exposición total, 1 posición y stop de compra como máximo al 5 %. Cada entrada corta real exige orden limitada y stop de compra de protección. Los tres límites nacen a 0: corto desactivado.

## Textos de contrato

- `revision-legal-corto`: `Declaro que he revisado con un profesional la normativa aplicable a las ventas en corto (CNMV/MiFID II) y su fiscalidad (IRPF).`
- `paper-cortos`: `{semanas} de 4 semanas · {cortos} de 5 cortos cerrados · {estado de conciliación}`.
- Cuenta cumplida: `Cuenta live con margen · corto habilitado · capital {importe}, mínimo 2.000,00 USD.`
- Bloqueo: `Completa los requisitos del corto antes de fijar límites mayores que 0.`
- Límites previos bloqueados: `Tus límites del corto siguen guardados, pero las nuevas entradas en corto real están bloqueadas. Cumple de nuevo los requisitos y confirma otra vez la frase antes de operar.`

La declaración general `revision-legal` y `revision-legal-corto` son distintas; una no sustituye a la otra.

## Comportamiento

- Orden de la pantalla: preparación del corto → motivo de bloqueo → límites generales → límites propios del corto → guardar/confirmar.
- `paper-cortos` ofrece `Ver órdenes paper`; la declaración ofrece su checkbox y `Guardar declaración`; la cuenta ofrece `Revisar conexión live`.
- Si falta cualquier requisito, los inputs del corto siguen enfocables con `readonly aria-disabled="true"` y `aria-describedby` al motivo común. No usar `disabled` en esos inputs.
- Con los tres límites cortos a 0 se pueden guardar cambios generales aunque falten requisitos. Si hay límites cortos previos mayores que 0 y ya no se cumplen, se conservan en lectura y no se reenvían ni confirman hasta recuperar los requisitos.
- Si ya había límites confirmados, conservarlos y mostrarlos en lectura; no ponerlos a 0. Solo quedan bloqueadas las nuevas entradas cortas reales.
- El proceso principal es la fuente de verdad. La interfaz muestra los motivos `[corto-requisitos] …` y nunca habilita por una inferencia local.

## Estados

| Estado | Contenido |
| --- | --- |
| Vacío | Tres requisitos pendientes, progreso 0/4 y 0/5, límites a 0. |
| Parcial | Todos los requisitos visibles con mezcla de cumplido, pendiente y revisar. |
| Cumplido | `Ya puedes fijar límites del corto mayores que 0.` y campos editables. |
| Cargando | Esqueletos estables, campos bloqueados y anuncio en la región `aria-live="polite"` persistente. |
| Error | Fallo cerrado, motivo seguro y `Reintentar comprobación`. |
| Sin permisos | Evidencia legible; declaración y edición bloqueadas con explicación. |
| Guardado | `Límites del corto guardados · todavía debes confirmar la nueva frase por escrito.` |

Los estados `Pendiente`, `Cumplido` y `Revisar` siempre combinan icono, palabra y color. Objetivos mínimos de 44 px, foco de 3 px separado 2 px y contraste WCAG AA. A 860 px se apilan las filas; a 700 px, los campos y acciones pasan a una columna. El tema oscuro usa `base.tokens.json` y `live.tokens.json`.

## Referencias

- Tokens documentados: `.orquesta/design/22ccc436/tokens.json`.
- Guía completa de componentes, ARIA y mensajes: `.orquesta/design/22ccc436/guia.md`.
- Maqueta interactiva: `.orquesta/design/22ccc436/01-limites-corto-real.html`.
