# Revisión de los ocho hallazgos E2E de identidad

Revisión de la entrega provisional `edcd494e-fix-2-v1` y del commit `22cb6759`, con los cambios posteriores del equipo presentes. Se conserva la dirección «Telemetría de box», el monograma Arco, la paleta y las fuentes locales. No se alteran las operaciones de trading, los proveedores, los límites ni los contratos IPC.

## Revisión y corrección

Las correcciones originales de cierre del buscador, caja de conciliación, etiqueta «Divisa», título de sesión no iniciada y contenedor de frescura son coherentes con los hallazgos. La separación visual de «Divisa» mantiene la descripción accesible completa. Los dos radios de origen siguen sincronizados con los cinco motores del selector y usan el primer CLI disponible al partir del analizador local. Las correcciones de legibilidad de Estrategias y barra inferior proceden de la tarea de legibilidad y se verifican mediante los recorridos existentes en ambos temas.

Se encontró un defecto adicional en los radios: escribir una ruta personalizada, seleccionar «Analizador local» y regresar a la suscripción perdía la ruta aún sin guardar. `AiSettings.tsx` conserva ahora los borradores por motor durante la edición. Una carga o guardado correcto recupera como referencia los ajustes persistidos. Se amplía `AiSettings.test.tsx` para exigir que la ruta sobreviva al cambio de origen y llegue al guardado con el motor correcto.

La ejecución completa detectó además que «Comprobando conexión» hacía crecer la barra a 71 px a 1024 px de ancho. `styles.css` reduce la separación horizontal mediante el token de espaciado compacto bajo 1200 px, sin reducir la letra ni recortar estados. `identidad-correcciones-r2.spec.ts` retiene la sonda HTTP real para medir ese estado transitorio a 1024 × 700 y exige altura de 48 px y ausencia de recortes, en ambos temas.

También se corrige `e2e/phase-6-7.helpers.ts`: el servicio de conectividad requiere dos URL válidas, pero el helper solo aportaba una y caía en los destinos públicos de respaldo. Se aportan dos URL atendidas por el mismo servidor local, sin modificar el servicio de producción. La regresión comprueba que ambas sondas quedan pendientes antes de medir el estado «Comprobando conexión».

`vitest.config.ts` limita la ejecución a dos workers simultáneos. Las ejecuciones anteriores del checkout habían registrado tiempos de espera bajo carga, incluidos los de ingesta y las semillas de backtest. Se conservan todos los casos, expectativas, aislamiento y plazos; únicamente se acota la concurrencia. El comando exacto `npm test` pasa con esta configuración.

## Cobertura de los ocho hallazgos

| Hallazgo | Comprobación |
| --- | --- |
| IDV-E2E-1 | `fx-paper-portfolio.spec.ts`, `mejoras-mercado-ajustes.spec.ts`; unitarias de AssetSearch con respuesta tardía y recuperación de foco. |
| IDV-E2E-2 | `layout-espaciado.spec.ts` y `identidad-correcciones-r2.spec.ts`: caja a 1280 y 1024 px, en ambos temas. |
| IDV-E2E-3 | `mejoras-mercado-ajustes.spec.ts` y `Watchlist.test.tsx`: etiqueta exacta y descripción accesible. |
| IDV-E2E-4 | `news-sentiment.spec.ts` y `SubscriptionNotice.test.tsx`: título contractual y pasos de recuperación. |
| IDV-E2E-5 | `news-sentiment.spec.ts`, `identidad-correcciones-r2.spec.ts` y `AiSettings.test.tsx`: radios, motor, autodetección y guardado de ruta. |
| IDV-E2E-6 | `stale-data.spec.ts`: desconexión, fecha y recuperación del aviso de IA. |
| IDV-E2E-7 | `identidad-correcciones-r2.spec.ts` y `identidad-legibilidad.spec.ts`: columnas de Estrategias a 1120 px. |
| IDV-E2E-8 | Las mismas specs: barra a 1120 y 1100 px; medición de texto visible, estados conectado/desconectado y comprobación pendiente a 1024 px. |

Se han inspeccionado las capturas de Estrategias oscuro y de los controles de IA claro en `capturas/identidad-correcciones-r2/`; los textos y controles corresponden al código revisado. La suite completa regenera las evidencias de los recorridos.

## Verificación

- Componentes revisados: 115/115 pruebas en cinco archivos.
- `npm install && npm run typecheck && npm test`: correcto; 217 archivos, 3898/3898 pruebas (81,75 s). Sin cambios de dependencias ni lockfile.
- `npm run lint` y `npm run format:check`: correctos.
- Marca anterior: búsqueda solicitada sin coincidencias en `src`, `build`, `resources` y `scripts`.
- Barra y aplicación: 35/35 pruebas unitarias; estado de comprobación a 1024 px: E2E 2/2 en claro y oscuro.
- Primera ejecución E2E: 129/130 correctos; el único fallo fue la altura de barra a 1024 px descrita arriba. El caso de las 15 secciones pasa tras corregirla (1/1), además de la regresión específica del estado transitorio (2/2).
- `npm run test:e2e` final: 130/130 correctos (12,3 min), sobre compilación nueva y con las sondas locales corregidas. Los ocho hallazgos quedan verificados. Log: `/tmp/tradia-fix2-e2e-final.log`.

No se realizan commits, cambios de rama ni publicación. La comprobación de instalación e integración nativa en Windows y Linux queda fuera de esta revisión de interfaz.
