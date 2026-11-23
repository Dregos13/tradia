# Incidencia funcional separada: registro IPC del buscador de Mercado

**Estado: resuelta.** `registerMarketSearch(ipcMain)` vuelve a registrarse en `registerMarket` (`src/main/market/ingestion.ts`), con prueba de regresión en `src/main/market/registro-busqueda.test.ts`. El texto siguiente es el historial de la incidencia.

- La misión de identidad había añadido a `src/main/market/ingestion.ts` la importación y la llamada `registerMarketSearch(ipcMain)` (commit `ac07a2f9`). Es un cambio de proceso principal, ajeno a una renovación visual, y se ha retirado.
- No se ha tocado `src/main/market/search.ts` ni `search.test.ts`: la implementación previa del buscador sigue en el repositorio, sin registrar en `registerMarket`.
- No se ha modificado ningún otro manejador IPC.
- Consecuencia posible: cualquier prueba (p. ej. e2e de búsqueda en Mercado, hallazgo IDV-E2E-1) que dependa de ese registro puede fallar. Se informa, no se oculta ni se reintroduce el cambio aquí.
- Acción para una misión posterior: decidir si el buscador debe cablearse y hacerlo con su propia prueba.
