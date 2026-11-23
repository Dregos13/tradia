/**
 * Motor de texto simulado del laboratorio (modo E2E): devuelve un
 * borrador determinista según palabras clave de la idea, con el mismo
 * formato JSON que se pide a una CLI real. Así las pruebas recorren el
 * flujo completo sin depender de una suscripción.
 */
import type { LabTextEngine } from './generator';

const between = (prompt: string, tag: string): string => {
  const start = prompt.lastIndexOf(`<${tag}>`);
  const end = prompt.lastIndexOf(`</${tag}>`);
  return start === -1 || end === -1 ? '' : prompt.slice(start + tag.length + 2, end).toLowerCase();
};

export function createSimulatedLabEngine(): LabTextEngine {
  return {
    label: 'IA simulada',
    complete: async (prompt) => {
      const idea = between(prompt, 'idea');
      const changes = between(prompt, 'cambios');
      const conservative = /conservador|prudente|menos riesgo/.test(changes);
      const stopMult = conservative ? 1.5 : 2;
      if (prompt.includes('<temporalidad>1h</temporalidad>')) {
        const tokio = /jap|tokio|yen|asia/.test(idea);
        const sesion = tokio
          ? 'sesion_tokio'
          : /londres|europa/.test(idea)
            ? 'sesion_londres'
            : 'sesion_nueva_york';
        const ticker = /oro|gold/.test(idea) ? 'XAUUSD' : tokio ? 'USDJPY' : 'EURUSD';
        const nombre = tokio ? 'Tokio' : sesion === 'sesion_londres' ? 'Londres' : 'Nueva York';
        return JSON.stringify({
          name: `Ruptura en la sesión de ${nombre}`,
          hypothesis: `Al abrir ${nombre} entra volumen y el precio tiende a seguir la ruptura de las horas previas.`,
          markets: [ticker],
          rules: {
            entry: `${sesion} = 1 y cierre > maximo(horas)`,
            exit: `${sesion} = 0`,
            stop: `${stopMult} * atr(14)`,
            target: '3 * atr(14)',
            entryShort: '',
            exitShort: '',
          },
          parameters: { horas: 6 },
          parameterRanges: { horas: { min: 3, max: 12, step: 3 } },
          regime: `Días con movimiento durante la sesión de ${nombre}`,
          explanation: `Compra si, con ${nombre} abierta, el precio supera el máximo de las últimas horas, y cierra al acabar la sesión o si salta el stop.`,
          risks: [
            'Las rupturas falsas son frecuentes en días tranquilos.',
            'El coste por operación pesa en operaciones pequeñas.',
          ],
        });
      }
      if (/rsi|sobreventa|rebote|reversi/.test(idea)) {
        return JSON.stringify({
          name: 'Rebote en sobreventa',
          hypothesis:
            'Las caídas bruscas dentro de una tendencia alcista suelen corregirse en pocos días.',
          markets: ['SPY', 'QQQ'],
          rules: {
            entry: 'rsi(2) < umbral y cierre > sma(200)',
            exit: 'rsi(2) > 70',
            stop: `${stopMult} * atr(14)`,
            target: 'ninguno',
            entryShort: '',
            exitShort: '',
          },
          parameters: { umbral: 10 },
          parameterRanges: { umbral: { min: 5, max: 20, step: 5 } },
          regime: 'Tendencia alcista con volatilidad moderada',
          explanation:
            'Compra cuando el índice cae con fuerza en pocos días pero sigue por encima de su media de 200 sesiones, y vende en cuanto rebota.',
          risks: ['En un mercado bajista las caídas siguen cayendo.', 'Pocas operaciones al año.'],
        });
      }
      return JSON.stringify({
        name: 'Cruce de medias',
        hypothesis: 'Los mercados con tendencia la mantienen durante semanas.',
        markets: ['SPY', 'QQQ', 'TLT'],
        rules: {
          entry: 'cruza_arriba(sma(rapida), sma(lenta))',
          exit: 'cruza_abajo(sma(rapida), sma(lenta))',
          stop: `${stopMult} * atr(14)`,
          target: 'ninguno',
          entryShort: '',
          exitShort: '',
        },
        parameters: { rapida: 20, lenta: 100 },
        parameterRanges: {
          rapida: { min: 10, max: 50, step: 10 },
          lenta: { min: 50, max: 200, step: 50 },
        },
        regime: 'Mercados con tendencia clara',
        explanation:
          'Entra cuando la media corta supera a la larga, señal de que empieza una tendencia, y sale cuando se cruzan al revés.',
        risks: ['En mercados laterales da muchas señales falsas.', 'Entra y sale tarde.'],
      });
    },
  };
}
