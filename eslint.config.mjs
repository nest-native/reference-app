import tsParser from '@typescript-eslint/parser';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/*.d.ts',
      '**/*.js',
      '**/*.mjs',
      'src/@generated/**',
      'src/database/migrations/**',
    ],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': 'off',
      'prefer-const': 'error',
      eqeqeq: ['error', 'always'],
    },
  },
];
