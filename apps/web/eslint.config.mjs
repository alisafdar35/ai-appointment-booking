import { FlatCompat } from '@eslint/eslintrc';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const config = [
  { ignores: ['.next/**', 'node_modules/**', 'playwright-report/**', 'test-results/**', 'next-env.d.ts'] },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Leftover debugging output is the most common review nit; warn/error stay
      // available for the few places that genuinely report a failure.
      'no-console': ['error', { allow: ['warn', 'error'] }],
      // A no-op escape like '\\;' once shipped as a real escaping bug; make it a lint error.
      'no-useless-escape': 'error',
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
    },
  },
];

export default config;
