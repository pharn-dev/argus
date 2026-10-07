import eslint from '@eslint/js';
import eslintConfigPrettier from 'eslint-config-prettier';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '.claude/**',
      'pharn/**',
      '.pharn/**',
      '.pharn-backup/**',
      'pharn.config.json',
      'pharn.records.json',
      'node_modules/**',
      '**/dist/**',
      'coverage/**',
      'runs/**',
      'package-lock.json',
      '*.tsbuildinfo',
      '.tsbuildinfo',
    ],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    files: ['**/*.{js,mjs,ts,mts,tsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.cjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...tseslint.configs.disableTypeChecked,
  },
  {
    // The agent is the zero-dependency core: Node core and its own files only. Nothing else in the
    // package may be imported from it, and nothing may be imported from node_modules.
    files: ['src/agent/**/*.ts'],
    ignores: ['src/agent/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!node:|\\.)',
              message: 'agent code may import only node: builtins and its own files.',
            },
            {
              regex: '(^|/)(collector|analyzer|dashboard|plugin-runner|otel)(/|$)',
              message: 'The agent must not import from other modules of this package.',
            },
          ],
        },
      ],
    },
  },
  {
    // The OTel adapter is opt-in and dependency-free: Node core and this package's own files only.
    files: ['src/otel/**/*.ts'],
    ignores: ['src/otel/**/*.test.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!node:|\\.)',
              message: "otel code may import only node: builtins and this package's own files.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.{test,spec}.ts'],
    ...tseslint.configs.disableTypeChecked,
  },
  eslintConfigPrettier,
);
