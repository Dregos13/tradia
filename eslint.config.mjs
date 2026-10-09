import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      'node_modules/**',
      'out/**',
      'dist/**',
      'release/**',
      'coverage/**',
      'playwright-report/**',
      'test-results/**',
      '.orquesta/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    files: ['src/main/**/*.ts', 'src/preload/**/*.ts', 'e2e/**/*.ts', '*.ts', '*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
  {
    files: ['src/renderer/**/*.{ts,tsx}', 'src/preload/**/*.ts'],
    languageOptions: {
      globals: { ...globals.browser },
    },
  },
  {
    // Motor de riesgo de solo lectura para la IA y las estrategias: ni
    // strategies ni backtest pueden importar los escritores del motor
    // (repositorio de límites/vetos/cartera, servicio IPC ni la parada).
    // Las señales entran por la pasarela (risk/engine via ctx.services.risk)
    // y los evaluadores puros (tradeRules, portfolio*, caution) sí son
    // importables.
    files: ['src/main/strategies/**/*.ts', 'src/main/backtest/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['**/risk/repository', '**/risk/service', '**/risk/killSwitch'],
              message:
                'El motor de riesgo es de solo lectura para la IA y las estrategias: ' +
                'envía señales por la pasarela (ctx.services.risk.submitSignal) en vez de ' +
                'importar los escritores de riesgo.',
            },
          ],
        },
      ],
    },
  },
  prettier,
);
