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
  prettier,
);
