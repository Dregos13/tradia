# Verificación de las pantallas de Tradia

Ámbito: entregables de diseño de `design-sistema-pantallas`. No certifica que la identidad esté aplicada en Electron: esa aplicación, sus E2E y las pruebas de instalación corresponden a las tareas dependientes. Este trabajo no cambia `src/`, `build/`, `resources/`, `scripts/`, pruebas ni dependencias.

## Comprobación específica de la entrega

- Diez familias completas en `dominio.tokens.json`; un script Python externo al repositorio comparó recursivamente claves, tipos e índices con los diez JSON de dominio de `src/renderer/src/design/`. Resultado: coincidencia exacta. Ubicación del script de esta sesión: `/tmp/tradia-pantallas-qa/verify.py`.
- Contraste: 430 combinaciones de colores, 215 por tema; cero pares bajo su umbral de 4,5:1 o 3:1. Incluye texto de franja real sobre su relleno normal y hover, texto de estados sobre sus fondos, series sobre el gráfico y cifras sobre rellenos de resultados. Valores y cocientes en `.orquesta/design/edcd494e/contraste-dominio.json` y tabla completa en la guía.
- Diez maquetas HTML autocontenidas: cuatro WOFF2 e icono Arco incrustados. Sin recursos externos para representación. La navegación de muestra solo conecta HTML de la entrega; no llama servicios ni ejecuta operaciones.
- Safari: abiertas las ocho vistas de los cinco grupos en claro y oscuro. El visor `00-indice.html` transmite `prefers-color-scheme` por la propiedad `color-scheme` de cada iframe. Se comprobó también la preferencia contraria para cada archivo, mediante «Invertir preferencias de tema».
- Las ocho vistas se revisaron en ventanas de 1440 × 1100 y 390 × 844 px. El diagnóstico del navegador confirmó las dos fuentes cargadas, el color calculado del tema correcto y ausencia de desbordamiento horizontal del documento. Tablas, navegación y gráfico conservan desplazamiento local cuando hace falta.
- Se corrigieron antes del cierre el ancho mínimo de la navegación compacta y el estilo nativo de los selectores de Safari. Los estados de aviso, carga, error, éxito y falta de permisos conservan el copy de la app; el apéndice «Estados» es documentación de diseño.
- Revisión independiente de Impeccable: **ship**, sin correcciones materiales, después de abrir las 16 capturas (ocho vistas × dos anchuras, con ambos temas en cada hoja). Capturas de esta sesión: `/tmp/tradia-pantallas-qa/desktop.png`, `desktop-2.png`–`desktop-8.png`, `mobile.png`, `mobile-2.png`–`mobile-8.png`. Se guardaron directamente los bytes de la API nativa de captura de Safari; no son capturas de Electron ni sustituyen las de QA de la misión.

## Verificación general del repositorio

Ejecutada secuencialmente, sin modificar configuración, tiempos o expectativas de las pruebas:

| Comando                | Resultado final                                             |
| ---------------------- | ----------------------------------------------------------- |
| `npm install`          | Correcto; sin cambios de dependencias.                      |
| `npm run typecheck`    | Correcto.                                                   |
| `npm run lint`         | Correcto.                                                   |
| `npm run format:check` | Correcto.                                                   |
| `npm test`             | **213 archivos, 3282 pruebas correctas**. Duración 86,13 s. |

Dos ejecuciones anteriores fallaron mientras la máquina estaba muy cargada y otros agentes modificaban la rama compartida. La primera pasó 3156/3157 y falló una expectativa temporal en `cliEngines.test.ts`; la segunda pasó 3277/3282 y tuvo timeouts en `ingestion`, `data-flow`, `App` y `StrategiesPage`, además de una búsqueda de región después de un timeout. Se conservaron los fallos y se repitió la verificación sin tocar esas pruebas. La última ejecución pasó completa. Registros de sesión en `/tmp/tradia-pantallas-qa/{npm-test,npm-test-retry,npm-test-final,typecheck-final,lint-final,format-final}.log`.

`npm run test:e2e` no se ejecutó desde esta tarea de diseño: la comprobación de Electron y sus capturas completas pertenece a `qa-e2e-identidad` y a `qa-verificacion-identidad`, después de aplicar todos los tokens y estilos. No se dan por realizadas las pruebas manuales de instalación de macOS, Windows o Linux.
