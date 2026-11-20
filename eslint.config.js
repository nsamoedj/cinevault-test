import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/generated/**',
      'apps/mobile/android/**',
      'apps/mobile/ios/**',
      'apps/mobile/.expo/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['apps/web/**/*.{ts,tsx}', 'apps/mobile/**/*.{ts,tsx}'],
    ...reactHooks.configs.flat.recommended,
  },
  {
    // Expo config plugins are CommonJS, loaded by the Expo CLI.
    files: ['apps/mobile/plugins/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { require: 'readonly', module: 'writable' },
    },
    rules: { '@typescript-eslint/no-require-imports': 'off' },
  },
  {
    // The web push service worker runs in the browser's worker scope.
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { self: 'readonly', URL: 'readonly' } },
  },
  {
    rules: {
      // `_name` marks a value that is unpacked on purpose but not used.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  prettier,
);
