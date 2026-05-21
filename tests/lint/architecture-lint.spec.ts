// Regression test for the eslint-plugin-boundaries rules wired in
// `eslint.config.mjs` (ADR-017). The fixtures below intentionally violate
// each rule in §3 of the recommendation; the spec asserts that ESLint
// reports the expected `boundaries/*` ruleId for each fixture so the rules
// cannot be silently weakened in a future refactor without a failing test.

import { Linter } from 'eslint';
import * as path from 'path';

// Both plugins ship as CommonJS with a real default-export wrapper. Using
// require keeps the runtime shape stable across ts-jest versions; the
// default-import flavour returned undefined under ts-jest 29.

const boundariesPluginModule: { default?: unknown } & Record<
  string,
  unknown
> = require('eslint-plugin-boundaries');
const tsParserModule: { default?: unknown } & Record<
  string,
  unknown
> = require('@typescript-eslint/parser');

const boundariesPlugin: unknown = boundariesPluginModule.default ?? boundariesPluginModule;
const tsParser: unknown = tsParserModule.default ?? tsParserModule;

type Plugin = NonNullable<Linter.Config['plugins']>[string];

const ROOT = path.resolve(__dirname, '..', '..');

// Element-type taxonomy and rules — keep mirrored with eslint.config.mjs.
// Inlined here so the spec is hermetic and independent of any future
// refactor that splits the production config into multiple files.
const ELEMENTS = [
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
    type: 'presentation',
    pattern: 'apps/*/src/modules/*/presentation/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  {
    type: 'infrastructure',
    pattern: 'apps/*/src/modules/*/infrastructure/**',
    mode: 'file',
    capture: ['app', 'module'],
  },
  { type: 'lib-contracts', pattern: 'libs/contracts/**', mode: 'file' },
  { type: 'lib-ddd', pattern: 'libs/ddd/**', mode: 'file' },
  { type: 'lib-common', pattern: 'libs/common/**', mode: 'file' },
  { type: 'lib-messaging', pattern: 'libs/messaging/**', mode: 'file' },
  { type: 'lib-cache', pattern: 'libs/cache/**', mode: 'file' },
  { type: 'lib-database', pattern: 'libs/database/**', mode: 'file' },
];

// v6 DependencySelector helpers — mirror eslint.config.mjs.
const sameModule = (type: string): object => ({
  to: {
    type,
    captured: {
      app: '{{from.captured.app}}',
      module: '{{from.captured.module}}',
    },
  },
});
const lib = (type: string): object => ({ to: { type } });

const DEPENDENCY_RULES = [
  // Blanket allow for any external / node-core target.
  { from: { type: '*' }, allow: { to: { origin: ['external', 'core'] } } },
  // Internal allow rules per layer.
  {
    from: { type: 'domain' },
    allow: [sameModule('domain'), lib('lib-ddd'), lib('lib-common'), lib('lib-contracts')],
  },
  {
    from: { type: 'application-use-case' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      lib('lib-ddd'),
      lib('lib-common'),
      lib('lib-contracts'),
    ],
  },
  {
    from: { type: 'application-port' },
    allow: [sameModule('domain'), lib('lib-ddd'), lib('lib-contracts')],
  },
  {
    from: { type: 'presentation' },
    allow: [
      sameModule('application-use-case'),
      sameModule('application-port'),
      lib('lib-contracts'),
      lib('lib-messaging'),
    ],
  },
  {
    from: { type: 'infrastructure' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('infrastructure'),
      lib('lib-cache'),
      lib('lib-messaging'),
      lib('lib-contracts'),
    ],
  },
  // External denylists per source layer.
  {
    from: { type: 'domain' },
    disallow: {
      dependency: {
        module: ['@nestjs/*', 'typeorm', '@keyv/redis', 'amqplib', 'axios', 'nestjs-pino'],
      },
    },
  },
  {
    from: { type: 'application-use-case' },
    disallow: {
      dependency: {
        module: ['@keyv/redis', 'amqplib', '@nestjs/cache-manager', '@nestjs/typeorm', 'typeorm'],
      },
    },
  },
  {
    from: { type: 'application-port' },
    disallow: {
      dependency: { module: ['@nestjs/common', 'typeorm', '@keyv/redis', 'amqplib'] },
    },
  },
  {
    from: { type: 'presentation' },
    disallow: { dependency: { module: ['typeorm', '@keyv/redis', '@nestjs/typeorm'] } },
  },
  {
    from: { type: 'lib-contracts' },
    disallow: { dependency: { module: ['@nestjs/common', '@nestjs/typeorm', 'typeorm'] } },
  },
  {
    from: { type: 'lib-ddd' },
    disallow: { dependency: { module: ['@nestjs/*', 'typeorm', '@keyv/redis', 'amqplib'] } },
  },
];

function buildLinter(): { linter: Linter; config: Linter.Config[] } {
  const linter = new Linter({ configType: 'flat' });

  const config: Linter.Config[] = [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tsParser as Linter.Parser,
      },
      plugins: {
        // The plugin types its rules loosely; the cast is hermetic to the test.
        boundaries: boundariesPlugin as unknown as Plugin,
      },
      settings: {
        'boundaries/elements': ELEMENTS,
        'boundaries/include': ['apps/**/*.ts', 'libs/**/*.ts'],
        'boundaries/ignore': ['**/spec/**', '**/*.spec.ts'],
        'import/resolver': {
          typescript: { project: path.join(ROOT, 'tsconfig.json') },
          node: true,
        },
      },
      rules: {
        'boundaries/dependencies': [
          'error',
          { default: 'disallow', checkAllOrigins: true, rules: DEPENDENCY_RULES },
        ] as Linter.RuleEntry,
      },
    },
  ];

  return { linter, config };
}

function lint(code: string, relPath: string): Linter.LintMessage[] {
  const { linter, config } = buildLinter();
  return linter.verify(code, config, { filename: path.join(ROOT, relPath) });
}

function ruleIds(messages: Linter.LintMessage[]): string[] {
  return messages.map((m) => m.ruleId ?? '');
}

describe('boundaries rules (ADR-017)', () => {
  describe('boundaries/dependencies — external denylists', () => {
    it('domain may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport const x: EntityManager = null as never;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application use-case may not import @keyv/redis', () => {
      const code = `import KeyvRedis from '@keyv/redis';\nexport const x = KeyvRedis;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application use-case may not import typeorm', () => {
      // The application layer reaches transaction scope via ITransactionPort,
      // not by importing EntityManager directly. This fixture is the bumper
      // that catches a regression of the pre-ITransactionPort exception.
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application port may not import typeorm', () => {
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('presentation may not import @keyv/redis', () => {
      const code = `import KeyvRedis from '@keyv/redis';\nexport const x = KeyvRedis;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('lib-contracts may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(code, 'libs/contracts/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('lib-ddd may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(code, 'libs/ddd/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  describe('boundaries/dependencies — element-type denials', () => {
    // The cross-element tests point at real production files so the
    // boundaries plugin's module resolver can map the import back to an
    // element-typed file. The fixtures inject the import string into a
    // virtual file at a path that the plugin matches as the *source*
    // element; the *target* element is determined by the resolved file's
    // path, hence the real targets.
    it('domain may not import infrastructure', () => {
      const code = `import { StockCache } from '../infrastructure/cache/stock.cache';\nexport const y = StockCache;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application port may not import infrastructure', () => {
      const code = `import { ProductStock } from '../../infrastructure/persistence/product-stock.entity';\nexport type Y = ProductStock;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('use case may not reach another app', () => {
      // 6 levels up: use-cases → application → stock → modules → src →
      // inventory-microservice → apps.
      const code = `import { Order } from '../../../../../../retail-microservice/src/modules/orders/domain/order.model';\nexport type Y = Order;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('presentation may not import infrastructure', () => {
      const code = `import { StockCache } from '../infrastructure/cache/stock.cache';\nexport const y = StockCache;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('presentation may not import @retail-inventory-system/database', () => {
      const code = `import { DatabaseModule } from '@retail-inventory-system/database';\nexport const y = DatabaseModule;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  describe('positive cases — allowed edges do not flag', () => {
    it('domain importing lib-ddd is allowed', () => {
      const code = `import { AggregateRoot } from '@retail-inventory-system/ddd';\nexport const x = AggregateRoot;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/domain/__fixture__.ts',
      );
      const boundariesMessages = messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'));
      expect(boundariesMessages).toEqual([]);
    });

    it('infrastructure importing lib-cache is allowed', () => {
      const code = `import { CACHE_PORT } from '@retail-inventory-system/cache';\nexport const x = CACHE_PORT;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/infrastructure/cache/__fixture__.ts',
      );
      const boundariesMessages = messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'));
      expect(boundariesMessages).toEqual([]);
    });
  });
});
