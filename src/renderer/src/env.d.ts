import type { TradiaApi } from '../../shared/ipc';

declare global {
  interface Window {
    /** API tipada expuesta por el preload vía contextBridge. */
    tradia: TradiaApi;
  }
}

export {};
