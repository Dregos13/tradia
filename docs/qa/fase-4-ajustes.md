# Fase 4 · Ajustes de canales, rutina, copias y registros

## Implementación

`SettingsPage` incorpora secciones pequeñas en `components/settings/` y conserva las preferencias existentes. Telegram y correo usan `delivery.getConfig/setConfig/test`; los secretos se escriben exclusivamente con `secrets.setKey` y las claves de `DELIVERY_SECRET_KEYS`. La lectura solo muestra «Guardado» y permite reemplazar con un campo vacío. No se representan credenciales ni mensajes de error sin filtrar.

Cada canal permite activar, elegir los cuatro eventos del contrato, guardar y probar. Activar y probar requieren configuración válida. Enviar prueba guarda primero el formulario; los controles quedan bloqueados durante el envío. Los cambios pendientes del otro canal se conservan. SMTP incluye seguridad TLS, STARTTLS o sin cifrado y valida puerto, host, usuario y destino.

La rutina usa las tres horas del contrato y muestra `America/New_York`; la zona no es editable. Copias muestra fecha local, tamaño, esquema e integridad; la creación recarga la lista para reflejar la retención del backend. Las copias sin integridad verificada no se pueden restaurar.

Restaurar abre un `alertdialog` con aviso de sustitución y reinicio. El foco inicial es «Cancelar», se contiene la navegación con Tab y se devuelve el foco al disparador al cancelar o pulsar Escape. El resto de la aplicación queda `inert`. Solo la acción explícita envía `{fileName, confirm: true}`. Mientras restaura, no puede cancelarse; al aceptar permanece bloqueado hasta el reinicio. Un fallo mantiene la confirmación abierta y permite cancelar.

Registros abre la carpeta y, cuando el sistema devuelve `ok: false`, ofrece la ruta seleccionable y «Copiar ruta».

## Verificación

- 18 pruebas nuevas en `OperationalSettings.test.tsx`; junto con las 8 existentes de `SettingsPage.test.tsx`, 26 pruebas superadas.
- Cobertura: validación Telegram y SMTP; guardar eventos; éxito y fallo de pruebas en ambos canales; secretos guardados, reemplazo y fallo de escritura; controles pendientes; reintento de carga; validación y guardado de horarios; restauración cancelada, confirmada y rechazada; creación y conservación de copias ante fallo de recarga; integridad; ruta de registros; integración en Ajustes.
- `npm run lint`, Prettier de esta tarea y `git diff --check`: correctos.
- Último `npm run typecheck`: errores externos en `src/main/signals/probe.ts` (identificador `positions` duplicado e incompatible con `StrategyContext`); sin errores en los archivos de Ajustes.
- `npm test`: 104 archivos y 1307 pruebas superadas; cuatro fallos externos en `src/main/backup/index.test.ts` y `src/main/backup/service.test.ts`, durante la integración paralela del servicio de copias.
- `node scripts/qa-settings.mjs`: vista real del renderer con adaptador simulado, a 1440 y 700 px, sin desbordamientos ni errores de navegador. Confirma foco inicial y retorno al cancelar. No envía avisos ni restaura una base real.
- Capturas inspeccionadas visualmente: `capturas/fase-4-ajustes-1440.png`, `capturas/fase-4-ajustes-700.png`, `capturas/fase-4-ajustes-restaurar-1440.png`, `capturas/fase-4-ajustes-restaurar-700.png`.

## Pendiente de integración

El servicio de rutina y los módulos de copias/señales siguen evolucionando en tareas independientes. No se ha cambiado su implementación. La recepción real de Telegram/SMTP, la restauración con reinicio real y los horarios de un día de mercado corresponden a las pruebas de integración y comprobaciones del usuario. El código del renderer nunca importa ni lee `.orquesta/`.
