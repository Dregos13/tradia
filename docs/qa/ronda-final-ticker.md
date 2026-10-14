# Ronda final de EUR sin cobertura

Fecha: 14-10-2026. Verificación sobre el código final, después del pulido de textos y avisos.

## Hallazgos

**Sin hallazgos medios ni altos pendientes** en `e2e-cierre-ticker.md` y `perfiles-cierre-ticker.md`.

El informe E2E confirma resueltos los tres fallos originales: eliminación persistente de EUR, aviso y botón únicos, y motivos en español llano. Sus regresiones están fijadas en los casos H1, H2 y H3 de `e2e/ticker-sin-cobertura.spec.ts`, además de `e2e/quitar-activo-sin-cobertura.spec.ts`.

El informe de perfiles solo recoge tres hallazgos bajos. La tarea de pulido ya corrigió el texto visible del botón, la jerga y el aviso de SPY atrasado junto a EUR sin cobertura. Las pruebas existentes de `DataFreshness`, `DataProvidersSettings` y `ProviderBanner` pasan con esas correcciones.

Esta ronda no requiere cambios adicionales en producto ni pruebas. No se han relajado aserciones ni marcado fallos como esperados.

## Verificación

| Comando | Resultado |
| --- | --- |
| `npm install && npm test` | EXIT 0; 203 archivos y 3060 pruebas pasan |
| `npm run lint` | EXIT 0 |
| `npm run typecheck` | EXIT 0 |
| `npm run format:check` | EXIT 0 |
| `npm run build && for i in 1 2 3; do npx playwright test e2e/ticker-sin-cobertura.spec.ts e2e/quitar-activo-sin-cobertura.spec.ts || exit 1; done` | EXIT 0; 8/8 en cada una de las tres pasadas |
| `npm run test:e2e` | EXIT 0; 71 pruebas pasan, 0 fallan |

Los E2E usan Electron y el proveedor simulado. Las capturas versionadas regeneradas por la batería se restauraron a su estado inicial; se conserva únicamente este informe como cambio de la ronda.

## Pendiente del usuario

No se han comprobado la clave real de Tiingo, `qa:providers` con esa clave ni los instaladores de macOS, Windows y Linux. Esas comprobaciones siguen correspondiendo al usuario.
