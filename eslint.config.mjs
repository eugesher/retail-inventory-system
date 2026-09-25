import eslint from '@eslint/js';
import boundariesPlugin from 'eslint-plugin-boundaries';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import typescriptEslint from 'typescript-eslint';

const boundariesElements = [
  {
    type: 'domain',
    pattern: 'apps/*/src/modules/*/domain/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'application-use-case',
    pattern: 'apps/*/src/modules/*/application/use-cases/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'application-port',
    pattern: 'apps/*/src/modules/*/application/ports/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'application-dto',
    pattern: 'apps/*/src/modules/*/application/dto/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'infrastructure',
    pattern: 'apps/*/src/modules/*/infrastructure/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'presentation',
    pattern: 'apps/*/src/modules/*/presentation/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'shared-module-barrel',
    pattern: 'apps/*/src/modules/auth/index.ts',
    mode: 'file',
    capture: ['app'],
  },
  {
    type: 'nest-module',
    pattern: 'apps/*/src/modules/*/*.ts',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'app-bootstrap',
    pattern: ['apps/*/src/main.ts', 'apps/*/src/app/**'],
    mode: 'file',
    capture: ['app'],
  },
  {
    type: 'app-shared',
    pattern: 'apps/*/src/common/**',
    mode: 'file',
    capture: ['app'],
  },
  { type: 'lib-auth', pattern: 'libs/auth/**', mode: 'file' },
  { type: 'lib-cache', pattern: 'libs/cache/**', mode: 'file' },
  { type: 'lib-common', pattern: 'libs/common/**', mode: 'file' },
  { type: 'lib-config', pattern: 'libs/config/**', mode: 'file' },
  { type: 'lib-contracts', pattern: 'libs/contracts/**', mode: 'file' },
  { type: 'lib-database', pattern: 'libs/database/**', mode: 'file' },
  { type: 'lib-ddd', pattern: 'libs/ddd/**', mode: 'file' },
  { type: 'lib-messaging', pattern: 'libs/messaging/**', mode: 'file' },
  { type: 'lib-observability', pattern: 'libs/observability/**', mode: 'file' },
];

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const sameModule = (/** @type {string} */ type) => ({
  to: {
    type,
    captured: {
      app: '{{from.captured.app}}',
      module: '{{from.captured.module}}',
    },
  },
});
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const sameApp = (/** @type {string} */ type) => ({
  to: { type, captured: { app: '{{from.captured.app}}' } },
});
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
const lib = (/** @type {string} */ type) => ({ to: { type } });

const APP_MODULE_IMPORT_PATTERN = {
  group: ['@retail-inventory-system/apps/*'],
  message:
    'An AppModule import is reserved for the e2e harness under test/ (and spec/), where this rule is switched off. Elsewhere it would make one deployable depend on the composition root of another — inject a port or import a lib instead.',
};

const dependencyRules = [
  { from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } },

  {
    from: { type: 'domain' },
    allow: [sameModule('domain'), lib('lib-ddd'), lib('lib-common'), lib('lib-contracts')],
  },
  {
    from: { type: 'application-use-case' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-dto'),
      sameModule('application-use-case'),
      sameApp('app-shared'),
      sameApp('shared-module-barrel'),
      lib('lib-ddd'),
      lib('lib-common'),
      lib('lib-contracts'),
      lib('lib-auth'),
    ],
  },
  {
    from: { type: 'application-port' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      lib('lib-ddd'),
      lib('lib-contracts'),
    ],
  },
  {
    from: { type: 'application-dto' },
    allow: [sameModule('domain'), lib('lib-contracts')],
  },
  {
    from: { type: 'infrastructure' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-use-case'),
      sameModule('application-dto'),
      sameModule('infrastructure'),
      sameModule('presentation'),
      sameApp('app-shared'),
      lib('lib-auth'),
      lib('lib-cache'),
      lib('lib-common'),
      lib('lib-config'),
      lib('lib-contracts'),
      lib('lib-database'),
      lib('lib-ddd'),
      lib('lib-messaging'),
      lib('lib-observability'),
    ],
  },
  {
    from: { type: 'presentation' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-use-case'),
      sameModule('application-dto'),
      sameModule('presentation'),
      sameApp('app-shared'),
      sameApp('shared-module-barrel'),
      lib('lib-auth'),
      lib('lib-contracts'),
      lib('lib-messaging'),
      lib('lib-observability'),
    ],
  },
  {
    from: { type: 'nest-module' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-use-case'),
      sameModule('application-dto'),
      sameModule('infrastructure'),
      sameModule('presentation'),
      sameApp('shared-module-barrel'),
      sameApp('app-shared'),
      lib('lib-auth'),
      lib('lib-cache'),
      lib('lib-common'),
      lib('lib-config'),
      lib('lib-contracts'),
      lib('lib-database'),
      lib('lib-ddd'),
      lib('lib-messaging'),
      lib('lib-observability'),
    ],
  },
  {
    from: { type: 'app-bootstrap' },
    allow: [
      sameApp('domain'),
      sameApp('application-use-case'),
      sameApp('application-port'),
      sameApp('application-dto'),
      sameApp('infrastructure'),
      sameApp('presentation'),
      sameApp('nest-module'),
      sameApp('shared-module-barrel'),
      sameApp('app-shared'),
      sameApp('app-bootstrap'),
      lib('lib-auth'),
      lib('lib-cache'),
      lib('lib-common'),
      lib('lib-config'),
      lib('lib-contracts'),
      lib('lib-database'),
      lib('lib-ddd'),
      lib('lib-messaging'),
      lib('lib-observability'),
    ],
  },
  {
    from: { type: 'app-shared' },
    allow: [sameApp('app-shared'), lib('lib-contracts'), lib('lib-common')],
  },
  { from: { type: 'lib-ddd' }, allow: [lib('lib-ddd')] },
  { from: { type: 'lib-contracts' }, allow: [lib('lib-contracts')] },
  {
    from: { type: 'lib-common' },
    allow: [
      lib('lib-common'),
      lib('lib-contracts'),
      lib('lib-cache'),
      lib('lib-config'),
      lib('lib-observability'),
    ],
  },
  {
    from: { type: 'lib-config' },
    allow: [
      lib('lib-config'),
      lib('lib-contracts'),
      lib('lib-cache'),
      lib('lib-observability'),
      lib('lib-database'),
    ],
  },
  {
    from: { type: 'lib-database' },
    allow: [lib('lib-database'), lib('lib-common'), lib('lib-contracts'), lib('lib-ddd')],
  },
  {
    from: { type: 'lib-cache' },
    allow: [lib('lib-cache'), lib('lib-common'), lib('lib-contracts'), lib('lib-observability')],
  },
  {
    from: { type: 'lib-messaging' },
    allow: [
      lib('lib-messaging'),
      lib('lib-common'),
      lib('lib-contracts'),
      lib('lib-observability'),
    ],
  },
  {
    from: { type: 'lib-observability' },
    allow: [lib('lib-observability'), lib('lib-common'), lib('lib-contracts')],
  },
  {
    from: { type: 'lib-auth' },
    allow: [lib('lib-auth'), lib('lib-common'), lib('lib-contracts'), lib('lib-observability')],
  },

  {
    from: { type: 'domain' },
    disallow: {
      dependency: {
        module: [
          '@nestjs/*',
          'typeorm',
          '@keyv/redis',
          'cacheable',
          'cache-manager',
          'redis',
          'amqplib',
          'amqp-connection-manager',
          'axios',
          'nestjs-pino',
          'pino',
          'pino-http',
        ],
      },
    },
  },
  {
    from: { type: 'application-use-case' },
    disallow: {
      dependency: {
        module: [
          '@keyv/redis',
          'cacheable',
          'cache-manager',
          'redis',
          'amqplib',
          'amqp-connection-manager',
          '@nestjs/cache-manager',
          '@nestjs/typeorm',
          'typeorm',
          'axios',
        ],
      },
    },
  },
  {
    from: { type: 'application-port' },
    disallow: {
      dependency: {
        module: [
          '@nestjs/common',
          '@nestjs/core',
          '@nestjs/microservices',
          '@nestjs/typeorm',
          '@nestjs/cache-manager',
          '@keyv/redis',
          'cacheable',
          'cache-manager',
          'redis',
          'amqplib',
          'amqp-connection-manager',
          'typeorm',
          'axios',
          'nestjs-pino',
        ],
      },
    },
  },
  {
    from: { type: 'application-dto' },
    disallow: {
      dependency: {
        module: ['@nestjs/*', 'typeorm', '@keyv/redis', 'cacheable', 'redis', 'amqplib', 'axios'],
      },
    },
  },
  {
    from: { type: 'presentation' },
    disallow: {
      dependency: {
        module: [
          'typeorm',
          '@keyv/redis',
          'cacheable',
          'cache-manager',
          'redis',
          '@nestjs/typeorm',
          'amqplib',
          'amqp-connection-manager',
        ],
      },
    },
  },
  {
    from: { type: 'lib-contracts' },
    disallow: {
      dependency: {
        module: [
          '@nestjs/common',
          '@nestjs/core',
          '@nestjs/microservices',
          '@nestjs/typeorm',
          '@nestjs/jwt',
          '@nestjs/passport',
          '@nestjs/cache-manager',
          'typeorm',
          '@keyv/redis',
          'cacheable',
          'redis',
          'amqplib',
        ],
      },
    },
  },
  {
    from: { type: 'lib-ddd' },
    disallow: {
      dependency: {
        module: [
          '@nestjs/*',
          'typeorm',
          '@nestjs/typeorm',
          '@nestjs/microservices',
          '@keyv/redis',
          'cacheable',
          'cache-manager',
          'redis',
          'amqplib',
        ],
      },
    },
  },
];

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
      'spec/fixtures/**',
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

      'no-restricted-imports': [
        'error',
        {
          patterns: [APP_MODULE_IMPORT_PATTERN],
        },
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
  {
    files: ['apps/**/*.ts', 'libs/**/*.ts'],
    ignores: ['**/spec/**', '**/*.spec.ts', '**/*.d.ts', '**/index.ts'],
    plugins: {
      boundaries: boundariesPlugin,
    },
    settings: {
      'boundaries/elements': boundariesElements,
      'boundaries/include': ['apps/**/*.ts', 'libs/**/*.ts'],
      'boundaries/ignore': ['**/spec/**', '**/*.spec.ts', '**/*.d.ts'],
      'import/resolver': {
        typescript: {
          project: './tsconfig.json',
        },
        node: true,
      },
    },
    rules: {
      'boundaries/dependencies': [
        'error',
        {
          default: 'disallow',
          checkAllOrigins: true,
          rules: dependencyRules,
        },
      ],
      'boundaries/no-unknown-files': 'error',
      'boundaries/no-unknown': 'off',
      'boundaries/no-ignored': 'off',
    },
  },
  {
    files: ['apps/**/*.ts'],
    ignores: ['apps/*/src/modules/*/infrastructure/messaging/**'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@nestjs/microservices',
              importNames: ['ClientProxy', 'ClientProxyFactory', 'ClientsModule'],
              message:
                'A transport client belongs only in infrastructure/messaging/ (ADR-009). Controllers, use cases and pipes inject the port symbol instead.',
            },
          ],
          patterns: [APP_MODULE_IMPORT_PATTERN],
        },
      ],
    },
  },
  {
    files: ['apps/**/*.ts'],
    ignores: ['**/spec/**', '**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector: 'TSAsExpression[typeAnnotation.typeName.name="EntityManager"]',
          message:
            'Do not cast to EntityManager (ADR-054). Un-opaque a transaction scope with `entityManagerOf(scope)` from @retail-inventory-system/database.',
        },
      ],
    },
  },
  {
    files: ['test/**/*.ts', 'spec/**/*.ts'],
    rules: {
      'no-restricted-imports': 'off',
      quotes: 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
