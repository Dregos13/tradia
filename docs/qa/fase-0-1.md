# QA manual — Fase 0-1

**Fecha:** 2026-10-08  
**Entorno disponible:** macOS 27.0, Apple Silicon arm64; Node.js v24.21.0; npm 11.19.0.  
**Alcance:** pruebas E2E de flujos de usuario sobre Electron, batería unitaria y generación/verificación de imágenes DMG de macOS. No hubo una sesión de escritorio interactiva para observar Gatekeeper, el Centro de notificaciones, la bandeja real ni el inicio de sesión del sistema. Windows y Linux no están disponibles localmente.

## Evidencia ejecutada

| Comprobación | Resultado | Evidencia |
| --- | --- | --- |
| `npm test` | Aprobado: 17 archivos, 106 pruebas | Salida local: `Test Files 17 passed (17)`, `Tests 106 passed (106)` |
| `npm run test:e2e` | Aprobado: 6 pruebas; incluye build, typecheck y arranque de Electron | Salida local: `6 passed (6)`; detalles en `e2e/electron.spec.ts:80-232` |
| `npm run lint` | Aprobado | Proceso finalizó con código 0 |
| `CSC_IDENTITY_AUTO_DISCOVERY=false npm run dist:mac` | Generó DMG x64 y arm64; el proceso terminó con código 0 | `release/Tradia-0.0.1-x64.dmg` (138 MB), `release/Tradia-0.0.1-arm64.dmg` (134 MB) |
| Verificación de imágenes | Aprobada para ambas imágenes | `hdiutil verify` informó checksum `VALID` para x64 y arm64 |
| Empaquetado nativo | Requiere comprobación adicional | electron-builder emitió `Attempting to build a module with a space in the path` al reconstruir `better-sqlite3`, pero continuó y generó los DMG. No se verificó el arranque de las apps empaquetadas. |
| CI remota / artefactos Windows y Linux | Pendiente | `.github/workflows/ci.yml` define matriz macOS, Windows y Ubuntu; no se ejecutó el workflow remoto en esta sesión. |

Las pruebas E2E lanzan la build local con un `userData` temporal por caso. No equivalen a instalar el DMG ni a comprobar los diálogos, permisos y notificaciones del sistema operativo. La simulación de desconexión es determinista y no desconecta físicamente la red.

## Lista de instalación limpia por plataforma

Para cada ensayo, usar una VM o cuenta de prueba y un directorio `userData` nuevo. No borrar datos de una instalación habitual. Anotar versión, arquitectura, hash del artefacto, capturas o logs y permisos concedidos. Los ítems marcados **Pendiente** no se deben dar por aprobados a partir de las pruebas E2E.

### macOS

Artefactos generados localmente: `release/Tradia-0.0.1-arm64.dmg` y `release/Tradia-0.0.1-x64.dmg`.

- [x] **Artefacto:** ambos DMG se generaron y sus checksums se verificaron con `hdiutil verify`.
- [ ] **Instalar y abrir desde DMG:** arrastrar Tradia a Aplicaciones, abrirla y confirmar que la ventana carga. Registrar arquitectura y versión.
- [ ] **Aviso de app sin firmar:** observar Gatekeeper en primera apertura; comprobar que las instrucciones para abrir la app son claras y no implican desactivar Gatekeeper globalmente.
- [~] **Aviso de riesgo:** en `npm run test:e2e`, instalación de datos limpios mostró el aviso, mantuvo Continuar deshabilitado hasta marcar aceptación y, tras reiniciar, permitió consultar el aviso en Ajustes > Legal. Falta repetir desde la app instalada.
- [ ] **Inicio automático:** activar «Iniciar con el sistema», cerrar sesión y volver a iniciarla; confirmar que Tradia arranca sin duplicar procesos. Desactivarlo y repetir para comprobar que no arranca.
- [~] **Bandeja y latido:** E2E cerró la ventana, comprobó que quedaba oculta, que el proceso seguía vivo y que el latido avanzaba; Pausar detuvo el latido. Falta confirmar el icono real de barra de menús y las acciones Abrir, Pausar agentes y Salir.
- [~] **Corte de red:** E2E activó/desactivó la simulación offline y verificó Sin conexión, pausa de decisiones y reanudación. Pendiente cortar y restaurar Wi-Fi en el sistema y observar aviso, notificación nativa y estado de la bandeja.
- [~] **Notificaciones:** E2E comprobó envío de nivel info mediante un espía de `Notification` y que el nivel alerta desactivado inhabilitaba Enviar prueba. Pendiente probar info, alerta y crítica en el Centro de notificaciones, con permiso concedido y denegado, y con preferencias activas/inactivas.
- [~] **Clave API:** E2E guardó un valor ficticio y no lo encontró en archivos JSON ni en `tradia.db`. Pendiente repetir en instalación desde DMG sin usar una clave real.
- [ ] **Teclado y límites:** recorrer aviso, navegación, preferencias y formulario de clave sin ratón; probar campos vacíos, valores largos y errores de red/permiso; verificar foco visible, mensajes y que no se guarda una clave vacía.

### Windows

Artefacto esperado desde CI: instalador NSIS (`.exe`). **Pendiente de CI o ejecución por una persona en Windows.**

- [ ] Instalar el `.exe` en perfil de usuario limpio y abrir Tradia.
- [ ] Registrar SmartScreen/aviso de app sin firmar y verificar que las instrucciones son seguras y claras.
- [ ] Confirmar aviso de riesgo bloqueante, aceptación persistente y acceso posterior desde Ajustes > Legal.
- [ ] Activar inicio con Windows, cerrar sesión e iniciar sesión; confirmar arranque único. Desactivar y repetir.
- [ ] Cerrar ventana y confirmar icono de bandeja, menú Abrir / Pausar agentes / Salir y latido; comprobar pausa explícita.
- [ ] Desconectar y reconectar Wi-Fi; observar estado en interfaz y bandeja, aviso, notificación nativa, pausa y reanudación.
- [ ] Probar Enviar prueba en info, alerta y crítica con preferencias activas/inactivas y permisos del sistema concedidos/denegados.
- [ ] Guardar una clave ficticia; confirmar que no aparece en configuración ni base SQLite legible.
- [ ] Probar teclado, campos vacíos, textos largos y errores de red/permisos; guardar capturas y logs.

### Linux

Artefactos esperados desde CI: AppImage y `.deb`. **Pendiente de CI o ejecución por una persona en Linux.**

- [ ] Instalar/ejecutar cada artefacto en una sesión limpia y registrar distribución, escritorio y arquitectura.
- [ ] Registrar avisos del escritorio por artefacto sin firma; confirmar que el usuario puede abrirlo sin debilitar la seguridad global.
- [ ] Confirmar aviso de riesgo bloqueante, aceptación persistente y acceso posterior desde Ajustes > Legal.
- [ ] Activar inicio automático de sesión y cerrar/abrir sesión; confirmar arranque único. Desactivarlo y repetir.
- [ ] Cerrar ventana y confirmar icono de bandeja, menú Abrir / Pausar agentes / Salir y latido; comprobar pausa explícita.
- [ ] Desconectar y reconectar la red; observar estado en interfaz y bandeja, aviso, notificación nativa, pausa y reanudación.
- [ ] Probar Enviar prueba en info, alerta y crítica con preferencias activas/inactivas y permisos de notificación concedidos/denegados.
- [ ] Guardar una clave ficticia; confirmar que no aparece en configuración ni base SQLite legible y que el backend soporta `safeStorage` en ese entorno.
- [ ] Probar teclado, campos vacíos, textos largos y errores de red/permisos; guardar capturas y logs.

## Sesiones por perfil

### Profesional independiente que organiza varios proyectos

**Pasos ejecutados**

1. Arrancar Electron con un directorio de datos temporal limpio y recorrer el aviso inicial, intentar continuar sin aceptarlo y luego aceptarlo.
2. Cerrar y relanzar la app con el mismo directorio; comprobar que no vuelve a bloquear y abrir el aviso desde Ajustes > Legal.
3. En Ajustes, enviar una prueba info, desactivar alerta y comprobar que no se puede enviar ese nivel.
4. Guardar una clave ficticia y revisar los archivos JSON y `tradia.db` del perfil temporal.
5. Simular desconexión y reconexión; comprobar el banner, la pausa y reanudación de decisiones.

**Esperado:** el aviso requiere aceptación, se conserva y sigue accesible; las preferencias dosifican notificaciones; no se expone la clave; la desconexión pausa decisiones y recupera el estado al volver la conexión.

**Observado:** se cumplieron esas verificaciones E2E. El envío se validó mediante un espía del proceso principal, no como notificación nativa visible. La conectividad fue simulada, no se cortó Wi-Fi. No se validaron los ajustes de inicio automático ni la bandeja nativa.

**Evidencia:** `npm run test:e2e`, 6/6; `e2e/electron.spec.ts:80-147` (aviso y notificaciones), `:184-220` (offline y clave); `npm test`, 106/106.

**Estado de sesión: incompleta (`passed: false`)** — los flujos automatizados aprobaron, pero faltan las comprobaciones de interacción con el sistema operativo requeridas para este perfil.

### Responsable de equipo que revisa entregas

**Pasos ejecutados**

1. Revisar `docs/alcance.md` contra todos los puntos de la sección 1 del plan.
2. Revisar en README instalación, scripts, empaquetado, CI, seguridad y aviso de riesgo.
3. Revisar los criterios de misión y las pruebas existentes; ejecutar las pruebas unitarias, E2E y lint.
4. Generar artefactos de macOS y verificar la integridad de los dos DMG.

**Esperado:** decisiones y texto legal comprobables; criterios con evidencia reproducible; artefactos por plataforma verificables y diferencias entre validación local y CI explícitas.

**Observado:** `docs/alcance.md` contiene decisiones cotejables para mercado, horizonte, modo, objetivos, principio rector, presupuesto y aspectos legales. README documenta los comandos y el estado sin firma. Las pruebas locales y ambos checksums DMG aprobaron. CI está configurada, pero no ejecutada remotamente; no se instalaron los DMG. El empaquetado registró el aviso de ruta con espacios indicado arriba.

**Evidencia:** `docs/alcance.md:1-213`, `README.md` (secciones Instalación, Empaquetado e instaladores, CI, Seguridad y Aviso de riesgo), `.github/workflows/ci.yml`, salidas locales de `npm test`, `npm run test:e2e`, `npm run lint`, `npm run dist:mac` y `hdiutil verify`.

**Estado de sesión: incompleta (`passed: false`)** — documentación y automatización local revisadas, pero faltan CI remota y comprobación real de instaladores en los otros sistemas y en macOS.

## Criterios de aceptación de la misión

| # | Criterio | Veredicto | Evidencia / brecha |
| --- | --- | --- | --- |
| 1 | Instalación limpia: aviso bloqueante, persistencia y acceso en Ajustes | **NO APTO (parcialmente verificado)** | E2E aprobado (`e2e/electron.spec.ts:80-95`); falta instalación y repetición desde DMG. |
| 2 | Bandeja con Abrir/Pausar/Salir, latido, inicio automático al iniciar sesión | **NO APTO (parcialmente verificado)** | E2E verificó ventana oculta, latido y pausa (`:149-182`); faltan menú/icono de bandeja y ciclo real de sesión. |
| 3 | Estado online/offline, aviso y notificación ante corte, pausa y reanudación | **NO APTO (parcialmente verificado)** | Simulación E2E verificó estado, pausa y reanudación (`:184-201`); faltan Wi-Fi físico y notificación nativa ante pérdida. |
| 4 | Enviar prueba nativa de info, alerta y crítica según preferencias | **NO APTO (parcialmente verificado)** | E2E verificó llamada de notificación info y bloqueo del nivel alerta desactivado (`:96-147`); falta entrega visible nativa de los tres niveles y prueba de permisos. |
| 5 | `npm run dev`, `npm test`, migraciones SQLite, CI e instaladores para las plataformas | **NO APTO (parcialmente verificado)** | `npm test` 106/106, E2E 6/6, lint y build pasan; DMG x64/arm64 generado y verificado. Pendientes arranque explícito con `npm run dev`, CI remota y artefactos/ejecución de NSIS, AppImage y deb. |
| 6 | Decisiones de alcance completas y claves API nunca legibles en configuración/DB | **APTO con evidencia automatizada local** | Cotejo escrito en `docs/alcance.md:193-213`; E2E comprobó que un valor secreto ficticio no aparece en JSON ni en `tradia.db` (`:203-220`). |

**Conclusión de fase:** **NO APTO para aceptación global** hasta completar las comprobaciones nativas pendientes. No se registran defectos reproducidos: las verificaciones que faltan son limitaciones de cobertura/entorno, no fallos confirmados del producto.

## Hallazgos

No se encontraron fallos reproducibles en los flujos automatizados ejecutados. El aviso de reconstrucción de `better-sqlite3` durante el empaquetado queda como observación pendiente de validar con una instalación empaquetada; no se clasifica como defecto porque el proceso terminó correctamente y ambos DMG pasaron la verificación de integridad.
