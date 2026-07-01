// eslint.config.mjs
// ESLint 9+ flat config for a TypeScript project.
// Docs: https://typescript-eslint.io/getting-started

import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  // Ignore build output and dependencies
  {
    ignores: ['dist/**', 'build/**', 'node_modules/**', 'coverage/**'],
  },

  // Base recommended rules
  js.configs.recommended,
  ...tseslint.configs.recommended,

  // Project-specific rule tweaks
  {
    rules: {
      // Catch bugs, not just style
      'no-unused-vars': 'off', // handled by @typescript-eslint version below
      '@typescript-eslint/no-unused-vars': [
        'warn',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      'no-console': 'off', // set to 'warn' later if you want to enforce a logger
      eqeqeq: ['error', 'always'], // require === instead of ==
      'no-var': 'error',
      'prefer-const': 'error',
    },
  },
);
