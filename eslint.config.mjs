import eslint from '@eslint/js';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import typescriptEslint from 'typescript-eslint';

export default typescriptEslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/*.config.js',
      '.husky/**',
      '.yarn/**',
      'coverage/**',
      'dist/**',
      'migrations/config/**',
    ],
  },
  eslint.configs.recommended,
  ...typescriptEslint.configs.recommended,
  {
    files: ['**/*.js', '**/*.cjs', '**/*.mjs', '**/*.ts', '**/*.tsx'],
    plugins: {
      prettier: eslintPluginPrettier,
    },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': 'error',

      '@typescript-eslint/explicit-function-return-type': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'warn',

      'no-console': 'error',
      'prettier/prettier': 'error',
      quotes: ['warn', 'single'],
      semi: ['error', 'always'],

      '@typescript-eslint/explicit-member-accessibility': [
        'error',
        { overrides: { constructors: 'off' } },
      ],

      '@typescript-eslint/naming-convention': [
        'error',
        {
          selector: 'interface',
          format: ['PascalCase'],
          custom: { regex: 'I[A-Z]', match: true },
        },
        {
          selector: 'enum',
          format: ['PascalCase'],
          custom: { regex: '[A-Za-z]Enum$', match: true },
        },
      ],
    },
  },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [
      ...typescriptEslint.configs.recommendedTypeChecked,
      ...typescriptEslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
      },
    },
    rules: {},
  },
);
