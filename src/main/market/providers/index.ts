/**
 * Proveedores de datos de mercado: contrato (`MarketDataProvider`, `Bar`,
 * errores tipados), cuota local (`createRateLimiter`) y los adaptadores
 * `simulated` (pruebas/desarrollo) y `tiingo` (producción).
 */
export * from './types';
export * from './rateLimiter';
export * from './simulated';
export * from './suggestions';
export * from './tiingo';
