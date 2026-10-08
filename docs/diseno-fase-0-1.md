# Diseño de interfaz — fase 0–1

La fuente de verdad visual de esta fase está en:

- `.orquesta/design/0cf04f7f/` (entrega de la misión)
- `.orquesta/design/fase-0-1/` (copia estable para consumo del frontend)

Ambas rutas contienen `tokens.json`, `guia.md`, tres maquetas HTML autocontenidas y los iconos de bandeja. La dirección visual se denomina **Cuaderno cuantitativo**: una interfaz sobria, editorial y orientada a control, que evita la estética de terminal especulativa.

## Contrato para implementación

1. Importar los valores de `tokens.json`; no copiar colores sueltos desde las maquetas.
2. Seguir el tema claro/oscuro del sistema operativo.
3. Mantener texto e icono junto a cada color de estado: en línea, sin conexión y pausado.
4. Mantener controles de al menos 44 px y foco visible de 3 px con separación de 2 px.
5. Usar `aria-live="polite"` para cambios de conexión y confirmaciones; reservar `assertive` para fallos críticos.
6. Vaciar una clave de API después de guardarla. La interfaz solo puede recuperar `hasKey`; nunca el valor.
7. Usar los PNG `macos-template-*` con `nativeImage.setTemplateImage(true)` en macOS y los PNG `color-*` en Windows/Linux.
8. Los sufijos de icono indican tamaño lógico: `16`, `16@2x`, `32` y `32@2x`.

## Pantallas de referencia

- `01-aviso-riesgo.html`: bloqueo de primer arranque, copia legal v1.0 y aceptación obligatoria.
- `02-principal.html`: barra de estado, latido, pausa de agentes, banner sin conexión y variantes de estado.
- `03-ajustes.html`: inicio automático, niveles de notificación, prueba, claves cifradas y acceso al aviso legal.

La guía documenta además los estados vacío, cargando, error, éxito y sin permisos. Los pares de color usados en texto cumplen WCAG 2.2 AA; el contraste mínimo comprobado en estados semánticos es 5,51:1.
