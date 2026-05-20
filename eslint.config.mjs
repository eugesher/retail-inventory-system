import eslint from '@eslint/js';
import boundariesPlugin from 'eslint-plugin-boundaries';
import eslintPluginPrettier from 'eslint-plugin-prettier';
import typescriptEslint from 'typescript-eslint';

// Element-type taxonomy for eslint-plugin-boundaries (ADR-017).
// `capture: ['app', 'module']` lets cross-service / cross-module isolation
// be expressed as `app: '${from.app}'` / `module: '${from.module}'` matchers.
const boundariesElements = [
  // App layer elements (per-module hexagonal).
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
  // App-level bootstrap (composition root). Lives outside any single module.
  {
    type: 'app-bootstrap',
    pattern: ['apps/*/src/main.ts', 'apps/*/src/app/**'],
    mode: 'file',
    capture: ['app'],
  },
  // App-shared utilities (e.g. apps/*/src/common/**).
  {
    type: 'app-shared',
    pattern: 'apps/*/src/common/**',
    mode: 'file',
    capture: ['app'],
  },
  // Shared libs — one element type per lib (ADR-017 §2).
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

// Per-element-type "same module" / "same app" target selectors. The
// `{{from.captured.x}}` template expands at lint time to the source
// element's captured `app` / `module` values, encoding the per-app and
// per-module isolation lines from ADR-017 §3.
//
// v6 policy entries must be one of: a bare type string, a legacy
// `[type, captured]` tuple, or a `DependencySelector` object with
// `from` / `to` / `dependency`. Captured-value matching at the policy
// level lives inside `to`, not at the top of the entry.
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

// Unified `boundaries/dependencies` rules (v6). With
// `default: 'disallow'` + `checkAllOrigins: true` every dependency edge
// — internal or external — must match an explicit allow rule. The
// catch-all "allow any external module" rule at index 0 gives us that
// blanket allow for npm packages; per-source disallow rules later in
// the array layer specific denylists on top (last match wins).
const dependencyRules = [
  // 0. Blanket allow for any non-local target — npm packages (`origin:
  //    external`) and node-core modules like `crypto` (`origin: core`).
  //    The per-source disallow rules later in the array layer specific
  //    denylists on top — last match wins, so this stays out of the way
  //    of the architectural rules.
  { from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } },

  // Domain — only ddd, common, contracts (enums/types), and own-module domain.
  {
    from: { type: 'domain' },
    allow: [sameModule('domain'), lib('lib-ddd'), lib('lib-common'), lib('lib-contracts')],
  },
  // Application use-cases — own module's domain / ports / dto + ddd / common /
  // contracts + lib-auth (port interfaces such as IAuthUserValidator).
  {
    from: { type: 'application-use-case' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-dto'),
      sameModule('application-use-case'),
      sameApp('app-shared'),
      lib('lib-ddd'),
      lib('lib-common'),
      lib('lib-contracts'),
      lib('lib-auth'),
    ],
  },
  // Application ports — domain types only.
  {
    from: { type: 'application-port' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      lib('lib-ddd'),
      lib('lib-contracts'),
    ],
  },
  // Application DTOs — own-module domain + contracts.
  {
    from: { type: 'application-dto' },
    allow: [sameModule('domain'), lib('lib-contracts')],
  },
  // Infrastructure — anything inside its own module + any shared lib.
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
  // Presentation — application layer + contracts + auth + observability +
  // messaging (ROUTING_KEYS only — adapter packages such as @keyv/redis or
  // typeorm are kept out by the external disallow rule below).
  {
    from: { type: 'presentation' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-use-case'),
      sameModule('application-dto'),
      sameModule('presentation'),
      sameApp('app-shared'),
      lib('lib-auth'),
      lib('lib-contracts'),
      lib('lib-messaging'),
      lib('lib-observability'),
    ],
  },
  // App bootstrap (composition root) — anything inside its app + any lib.
  {
    from: { type: 'app-bootstrap' },
    allow: [
      sameApp('domain'),
      sameApp('application-use-case'),
      sameApp('application-port'),
      sameApp('application-dto'),
      sameApp('infrastructure'),
      sameApp('presentation'),
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
  // App-shared utilities — contracts + common only.
  {
    from: { type: 'app-shared' },
    allow: [sameApp('app-shared'), lib('lib-contracts'), lib('lib-common')],
  },
  // Lib edges — kept narrow on purpose (ADR-017 §3).
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
    allow: [lib('lib-database'), lib('lib-common'), lib('lib-contracts')],
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
  // External-package denylists per source layer (ADR-017 §4). Each entry
  // overrides the catch-all "allow any external module" rule at index 0.
  // class-validator / class-transformer / @nestjs/swagger remain allowed
  // in lib-contracts — the documented exception (contracts double as the
  // HTTP/RPC wire-format DTOs that drive the Scalar OpenAPI viewer).

  // Domain — no framework, no I/O, no logging.
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
  // Application use-cases — no concrete adapters / Redis / Rabbit clients.
  // `@nestjs/common` is intentionally allowed (use cases are Nest providers).
  // `@nestjs/typeorm` is forbidden — repository ports are the seam. Note:
  // `reserve-stock-for-order.use-case.ts` currently injects EntityManager via
  // `@nestjs/typeorm`; that ONE file carries an inline disable + TODO
  // pending the transaction-port refactor (task-14).
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
          'axios',
        ],
      },
    },
  },
  // Application ports — domain types only. `stock.repository.port.ts`
  // imports `EntityManager` from typeorm for transaction scoping; the
  // matching inline disable carries the ARCH-LINT-EX-01 tracking code.
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
  // Application DTOs — plain TypeScript + class-validator/class-transformer.
  {
    from: { type: 'application-dto' },
    disallow: {
      dependency: {
        module: ['@nestjs/*', 'typeorm', '@keyv/redis', 'cacheable', 'redis', 'amqplib', 'axios'],
      },
    },
  },
  // Presentation — no direct TypeORM repositories or Redis clients.
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
  // lib-contracts — plain TypeScript. class-validator / class-transformer /
  // @nestjs/swagger are the documented exceptions (ADR-017 §4). TypeORM,
  // Nest DI/runtime decorators, and microservice transports stay forbidden.
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
  // lib-ddd — framework-free per recommendation §3.
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
      // Lint-fixture files are intentionally non-compliant — see tests/lint.
      'tests/lint/fixtures/**',
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
          patterns: [
            {
              group: ['@retail-inventory-system/apps/*'],
              message:
                'AppModule imports are reserved for the E2E test entry point (test/system-api.e2e-spec.ts).',
            },
          ],
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
  // Architecture lint (eslint-plugin-boundaries, ADR-017).
  // The dependencies rule below is the source of truth for the per-module
  // hexagonal layout — when in doubt about where a file should live, run
  // `yarn lint` and let the boundaries plugin answer.
  {
    files: ['apps/**/*.ts', 'libs/**/*.ts'],
    ignores: [
      '**/spec/**',
      '**/*.spec.ts',
      '**/*.d.ts',
      // Barrel files are pure re-exports and aren't useful targets for the
      // dependency graph. The files they re-export are still linted.
      '**/index.ts',
    ],
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
      'boundaries/no-unknown': 'off',
      'boundaries/no-unknown-files': 'off',
      'boundaries/no-ignored': 'off',
    },
  },
  // Relax strict typing rules for test files: supertest's `body` is
  // inherently `any`, asserting raw DB rows doesn't warrant full typings,
  // and lint-fixture sources (tests/lint/) intentionally hand-craft import
  // strings the production rules then reject. Template literals are also
  // permitted so fixture source code can embed single quotes without
  // backslash escapes.
  {
    files: ['test/**/*.ts', 'tests/**/*.ts'],
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
  // Allow console in utility scripts that run outside the NestJS context.
  {
    files: ['scripts/**/*.ts'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/explicit-module-boundary-types': 'off',
    },
  },
);
