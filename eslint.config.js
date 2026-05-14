// eslint.config.js
import js from '@eslint/js';

export default [
  js.configs.recommended,
  {
    files: ['api/**/*.js', 'src/**/*.jsx'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        Date: 'readonly',
        Math: 'readonly',
        JSON: 'readonly',
        Promise: 'readonly',
        globalThis: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-constant-condition': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      // Catch duplicate catch blocks
      'no-dupe-else-if': 'error',
      // Catch scoping issues
      'no-shadow': ['error', { builtinGlobals: false, hoist: 'all' }],
      // Require const for variables that are never reassigned
      'prefer-const': 'error',
      // No var
      'no-var': 'error',
    },
  },
];
