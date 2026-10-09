/**
 * Verifica la regla `no-restricted-imports` de `eslint.config.mjs`: la IA,
 * las estrategias y el backtest solo pueden LEER el motor de riesgo —no
 * importar sus escritores (repositorio, servicio ni parada)—; las señales
 * entran por la pasarela. Usa la configuración real del proyecto, no una
 * copia, para que la prueba rompa si la regla se quita o se relaja.
 */
import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const eslint = new ESLint();

const lintFile = async (code: string, filePath: string) => {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages ?? [];
};

const restrictedErrors = (messages: { ruleId: string | null; message: string }[]) =>
  messages.filter((m) => m.ruleId === 'no-restricted-imports');

describe('motor de riesgo de solo lectura (eslint no-restricted-imports)', () => {
  it('strategies no puede importar el repositorio, el servicio ni la parada', async () => {
    const messages = await lintFile(
      `import { createRiskRepository } from '../risk/repository';
       import { registerRisk } from '../risk/service';
       import { createKillSwitchStore } from '../risk/killSwitch';
       export const x = [createRiskRepository, registerRisk, createKillSwitchStore];`,
      'src/main/strategies/fake-guard.ts',
    );
    expect(restrictedErrors(messages)).toHaveLength(3);
    expect(restrictedErrors(messages)[0]?.message).toContain('solo lectura');
  });

  it('backtest tampoco puede, a cualquier profundidad de ruta', async () => {
    const messages = await lintFile(
      `import { createRiskRepository } from '../../risk/repository';
       export const x = createRiskRepository;`,
      'src/main/backtest/deep/fake-guard.ts',
    );
    expect(restrictedErrors(messages)).toHaveLength(1);
  });

  it('los evaluadores puros y la pasarela sí son importables', async () => {
    const messages = await lintFile(
      `import { createRiskEngine } from '../risk/engine';
       import { evaluateTradeRules } from '../risk/tradeRules';
       import { checkPortfolioLimits } from '../risk/portfolioLimits';
       export const x = [createRiskEngine, evaluateTradeRules, checkPortfolioLimits];`,
      'src/main/strategies/fake-guard.ts',
    );
    expect(restrictedErrors(messages)).toHaveLength(0);
  });

  it('la regla solo aplica a strategies y backtest, no al resto de main', async () => {
    const messages = await lintFile(
      `import { createRiskRepository } from '../risk/repository';
       export const x = createRiskRepository;`,
      'src/main/market/fake-guard.ts',
    );
    expect(restrictedErrors(messages)).toHaveLength(0);
  });
});
