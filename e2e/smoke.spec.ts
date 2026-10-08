import { test } from '@playwright/test';

// Punto de entrada de las pruebas de extremo a extremo.
// La tarea «e2e-tests» las implementa con el _electron de Playwright sobre la
// build (out/), usando un userData temporal por prueba. Escenarios previstos:
// aviso de riesgo en instalación limpia, Enviar prueba, cierre a la bandeja,
// simulación sin conexión, claves sin texto plano y webPreferences seguras.
test.skip('pendiente de la tarea e2e-tests', async () => {
  // Sin implementación todavía: queda el arnés para que npm run test:e2e pase en verde.
});
