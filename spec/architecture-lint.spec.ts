// Regression test for the eslint-plugin-boundaries rules wired in
// `eslint.config.mjs` (ADR-017). The fixtures below intentionally violate
// each rule in §3 of the recommendation; the spec asserts that ESLint
// reports the expected `boundaries/*` ruleId for each fixture so the rules
// cannot be silently weakened in a future refactor without a failing test.

import { Linter } from 'eslint';
import * as fs from 'fs';
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

const ROOT = path.resolve(__dirname, '..');

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
  // ADR-041. `shared-module-barrel` MUST precede `nest-module` — the plugin
  // takes the first matching pattern, and `auth/index.ts` matches both.
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
const sameApp = (type: string): object => ({
  to: { type, captured: { app: '{{from.captured.app}}' } },
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
      sameApp('shared-module-barrel'),
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
      sameApp('shared-module-barrel'),
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
  // ADR-041 — the module composition root sees every layer of its own module
  // and the `auth` barrel, but never a sibling module's internals or barrel.
  {
    from: { type: 'nest-module' },
    allow: [
      sameModule('domain'),
      sameModule('application-port'),
      sameModule('application-use-case'),
      sameModule('infrastructure'),
      sameModule('presentation'),
      sameApp('shared-module-barrel'),
      lib('lib-cache'),
      lib('lib-database'),
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
        'boundaries/no-unknown-files': 'error' as Linter.RuleEntry,
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
      const code = `import { StockLevelEntity } from '../infrastructure/persistence/stock-level.entity';\nexport const y = StockLevelEntity;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application port may not import infrastructure', () => {
      const code = `import { StockLevelEntity } from '../../infrastructure/persistence/stock-level.entity';\nexport type Y = StockLevelEntity;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('use case may not reach another app', () => {
      // 6 levels up: use-cases → application → stock → modules → src →
      // inventory-microservice → apps. The target is the retail app's orders
      // domain (Order) — any cross-app domain reach is forbidden (a use case
      // allows only same-app domain/ports + a fixed lib set). `order.model.ts`
      // exists again after the checkout rebuild (ADR-028), so this resolves.
      const code = `import { Order } from '../../../../../../retail-microservice/src/modules/orders/domain/order.model';\nexport type Y = Order;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('infrastructure consumer may not reach another app domain (cross-app)', () => {
      // The inventory `catalog-events.consumer.ts` (infrastructure/consumers/)
      // consumes `catalog.variant.created` ONLY through the
      // ICatalogVariantCreatedEvent wire contract in lib-contracts — never the
      // catalog microservice's domain. `infrastructure` allows same-module
      // domain/ports/infrastructure + a fixed lib set, so a cross-app domain
      // import from a consumer fails the rule (no `sameApp('domain')` edge).
      // 6 levels up: consumers → infrastructure → stock → modules → src →
      // inventory-microservice → apps.
      const code = `import { Product } from '../../../../../../catalog-microservice/src/modules/catalog/domain/product.model';\nexport type Y = Product;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/infrastructure/consumers/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('presentation may not import infrastructure', () => {
      const code = `import { StockLevelEntity } from '../infrastructure/persistence/stock-level.entity';\nexport const y = StockLevelEntity;\n`;
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

  // The gateway auth + iam + customer-admin modules follow the same
  // per-layer rules as the inventory/stock module; these fixtures repeat
  // the bumper there so a future regression on the gateway side is caught.
  // `iam` and `customer-admin` are the two admin shells with no `domain/`
  // or `infrastructure/` of their own — they mutate/read the auth aggregates
  // through the use cases AuthModule re-exports, so the generic
  // `apps/*/src/modules/*/...` element patterns classify them with no new
  // boundaries entry (ADR-017).
  describe('boundaries/dependencies — gateway auth + iam + customer-admin modules', () => {
    it('auth domain (RoleAggregate, PermissionAggregate, StaffUser, Customer) may not import @retail-inventory-system/messaging', () => {
      // Domain must stay framework- and transport-free. With default-disallow
      // + checkAllOrigins, lib-messaging is not in the domain allow list, so
      // this import fails the rule even before the external denylist runs.
      const code = `import { ROUTING_KEYS } from '@retail-inventory-system/messaging';\nexport const y = ROUTING_KEYS;\n`;
      const messages = lint(code, 'apps/api-gateway/src/modules/auth/domain/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('auth domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(code, 'apps/api-gateway/src/modules/auth/domain/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('auth application use-case may not import typeorm', () => {
      // Login/RefreshToken/RegisterStaffUser/RegisterCustomer reach the DB via
      // repository ports — never via EntityManager.
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/auth/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('auth application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/auth/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('iam application use-case may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/iam/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('iam application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/iam/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('iam presentation may not import auth infrastructure (cross-element + cross-module)', () => {
      // The IAM module has no `infrastructure/` of its own — it reuses the
      // auth module's repository adapters via the DI tokens AuthModule
      // re-exports. A direct file-level import into auth's persistence
      // tree from iam/presentation is the regression this fixture catches.
      // 4 levels up: presentation → iam → modules → src → modules/auth/...
      const code = `import { StaffUserEntity } from '../../auth/infrastructure/persistence/staff-user.entity';\nexport type Y = StaffUserEntity;\n`;
      const messages = lint(code, 'apps/api-gateway/src/modules/iam/presentation/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('customer-admin presentation may not import auth infrastructure (cross-element + cross-module)', () => {
      // `customer-admin` is the second admin shell with no `infrastructure/`
      // of its own — it reads/erases the `Customer` aggregate through the
      // ReadConsent / EraseCustomer use cases AuthModule re-exports. A direct
      // file-level import into auth's persistence tree from
      // customer-admin/presentation is the regression this fixture catches.
      // 4 levels up: presentation → customer-admin → modules → src → modules/auth/...
      const code = `import { CustomerEntity } from '../../auth/infrastructure/persistence/customer.entity';\nexport type Y = CustomerEntity;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/customer-admin/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  // The catalog microservice's single `catalog` module follows the same
  // per-layer rules as the inventory/stock module and the gateway auth/iam
  // modules. These fixtures repeat the bumpers there — pointed at the real
  // catalog paths (the generic `apps/*/src/modules/*/...` element patterns
  // classify them automatically) — so a future refactor cannot silently
  // exempt the catalog tree from the boundaries.
  describe('boundaries/dependencies — catalog microservice', () => {
    it('catalog domain (Product, ProductVariant, the VOs + events) may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('catalog domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('catalog application use-case may not import typeorm', () => {
      // Register/AddVariant/Publish/Archive + the read use cases reach the DB
      // via ICatalogRepositoryPort — never via EntityManager.
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('catalog application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('catalog application port may not import typeorm', () => {
      // ICatalogRepositoryPort returns domain types only; it declares its own
      // local pagination shapes rather than leaking a TypeORM Repository.
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('catalog presentation may not import @retail-inventory-system/database', () => {
      const code = `import { DatabaseModule } from '@retail-inventory-system/database';\nexport const y = DatabaseModule;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('catalog presentation may not import typeorm', () => {
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/catalog/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  // The pricing module is the catalog microservice's second bounded context. It
  // obeys the same generic per-layer rules with no `eslint.config.mjs` change —
  // the `apps/*/src/modules/*/...` element patterns classify its layers
  // automatically. These fixtures repeat the bumpers there, and add the
  // pricing↔catalog domain cross-module bumper: pricing communicates with
  // catalog via the opaque `variantId`, never a cross-module domain import.
  describe('boundaries/dependencies — pricing module', () => {
    it('pricing domain may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('pricing domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('pricing application use-case may not import typeorm', () => {
      // Pricing use cases reach the DB via a repository port — never via
      // EntityManager (the same ITransactionPort/repository-port seam as catalog).
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('pricing application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('pricing application port may not import typeorm', () => {
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('pricing presentation may not import @retail-inventory-system/database', () => {
      const code = `import { DatabaseModule } from '@retail-inventory-system/database';\nexport const y = DatabaseModule;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('pricing domain may not import the catalog module domain (cross-module)', () => {
      // Resolves to a real catalog file, so the boundaries resolver types the
      // target as catalog's `domain`. `sameModule('domain')` requires the same
      // app *and* module, so a pricing→catalog domain edge is cross-module and
      // disallowed — locking in the pricing↔catalog domain isolation (the two
      // contexts communicate via the opaque `variantId`, never a domain import).
      const code = `import { Product } from '../../catalog/domain/product.model';\nexport type Y = Product;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  // The retail microservice's rebuilt checkout splits into two bounded contexts:
  // the mutable `cart` and the immutable `orders` (the latter also home to the
  // `Payment` aggregate + the `PAYMENT_GATEWAY` port and its
  // `infrastructure/payment-gateway/` adapter). Both obey the same generic
  // per-layer rules with no `eslint.config.mjs` change — the
  // `apps/*/src/modules/*/...` element patterns classify their layers
  // automatically. These fixtures repeat the bumpers there, pointed at the real
  // retail paths.
  describe('boundaries/dependencies — retail cart module', () => {
    it('cart domain (Cart, CartLine, events, CartDomainException) may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('cart domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('cart application use-case may not import typeorm', () => {
      // Create/Get/AddToCart/Change/Remove/Claim reach the DB via
      // ICartRepositoryPort — never via EntityManager.
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('cart application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('cart application port may not import typeorm', () => {
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('cart presentation may not import @retail-inventory-system/database', () => {
      const code = `import { DatabaseModule } from '@retail-inventory-system/database';\nexport const y = DatabaseModule;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('cart domain may not import the orders module domain (cross-module)', () => {
      // Resolves to a real orders file, so the boundaries resolver types the
      // target as the orders `domain`. `sameModule('domain')` requires the same
      // app *and* module, so a cart→orders domain edge is cross-module and
      // disallowed — locking in the cart↔orders isolation (a cart converts into
      // an order through the place use case + the raw-SQL cart reader, never a
      // cross-module domain import).
      const code = `import { Order } from '../../orders/domain/order.model';\nexport type Y = Order;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  describe('boundaries/dependencies — retail orders module', () => {
    it('orders domain (Order, OrderLine, Address, Payment, OrderDomainException) may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('orders domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('orders application use-case may not import typeorm', () => {
      // PlaceOrder/AuthorizePayment/CapturePayment/GetOrder/ListMyOrders reach
      // the DB via the repository ports + ITransactionPort — never EntityManager.
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('orders application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('orders application port may not import typeorm', () => {
      // The repository + gateway ports (including IPaymentGatewayPort) return
      // domain/contract types only — no TypeORM Repository leak.
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/application/ports/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('orders presentation may not import @retail-inventory-system/database', () => {
      const code = `import { DatabaseModule } from '@retail-inventory-system/database';\nexport const y = DatabaseModule;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('orders presentation may not import the payment-gateway infrastructure adapter (cross-element)', () => {
      // Proves `infrastructure/payment-gateway/` is classified as `infrastructure`
      // (the generic pattern matches any subfolder of `infrastructure/`, not just
      // `persistence/` or `messaging/`). Presentation allows only same-module
      // application layers + a fixed lib set, so importing the FakePaymentGateway-
      // Adapter directly from a controller is a cross-element denial — the gateway
      // is reached through the PAYMENT_GATEWAY port, never the adapter class.
      // 1 level up: presentation → orders, then infrastructure/payment-gateway/.
      const code = `import { FakePaymentGatewayAdapter } from '../infrastructure/payment-gateway/fake-payment-gateway.adapter';\nexport const y = FakePaymentGatewayAdapter;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

  // The event-store microservice (the sixth deployable, ADR-034/035) is ONE module —
  // `modules/audit-and-events/` — holding both append-only logs as two aggregates
  // (ADR-042), so the generic `apps/*/src/modules/*/...` element patterns classify its layers
  // with no `eslint.config.mjs` special case. These fixtures repeat the per-layer bumpers
  // there, pointed at the real event-store paths. The append-only repository shape is locked
  // by the separate structural assertion that follows this block.
  describe('boundaries/dependencies — event-store microservice', () => {
    const M = 'apps/event-store-microservice/src/modules/audit-and-events';

    it('domain (DomainEvent, AuditLogEntry frozen value objects) may not import @nestjs/common', () => {
      const code = `import { Injectable } from '@nestjs/common';\nexport const x = Injectable;\n`;
      const messages = lint(code, `${M}/domain/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('domain may not import typeorm', () => {
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(code, `${M}/domain/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application use-case (IngestDomainEvent, IngestAuditLog) may not import typeorm', () => {
      // The ingest use cases reach the append-only logs via the repository ports
      // (DOMAIN_EVENT_REPOSITORY / AUDIT_LOG_REPOSITORY) — never via EntityManager.
      const code = `import { EntityManager } from 'typeorm';\nexport type X = EntityManager;\n`;
      const messages = lint(code, `${M}/application/use-cases/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application use-case may not import @nestjs/typeorm', () => {
      const code = `import { InjectRepository } from '@nestjs/typeorm';\nexport const x = InjectRepository;\n`;
      const messages = lint(code, `${M}/application/use-cases/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('application port may not import typeorm', () => {
      // IDomainEventRepositoryPort / IAuditLogRepositoryPort return the DomainEvent /
      // AuditLogEntry value objects only — no TypeORM Repository leak across the seam.
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(code, `${M}/application/ports/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('presentation (FirehoseConsumer, AuditQueryController) may not import typeorm', () => {
      // The event store gained a `presentation/` layer with ADR-042: both controllers inject
      // use cases of this module, so neither needs a home outside the hexagon any more.
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(code, `${M}/presentation/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('the trace use case may inject BOTH repository ports — they are one module (ADR-042)', () => {
      // The read that motivated ADR-042. Under the old two-module split this edge was
      // cross-module and illegal, which is what forced a raw-SQL reader port over the
      // sibling's table. Both logs now live here, so the port import is an ordinary
      // `sameModule` edge.
      const code = `import { AUDIT_LOG_REPOSITORY, DOMAIN_EVENT_REPOSITORY } from '../ports';\nexport const x = [AUDIT_LOG_REPOSITORY, DOMAIN_EVENT_REPOSITORY];\n`;
      const messages = lint(code, `${M}/application/use-cases/__fixture__.ts`);
      expect(messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'))).toEqual([]);
    });
  });

  // The event store's two repositories are append-only by construction (ADR-035; the
  // docs/implementation/11-event-store-and-audit-log/06-append-only-enforcement.md §2.4
  // forward note promised this guard would land with the documentation/lint pass). The
  // boundaries plugin governs *import edges*, not method surfaces, so this structural
  // assertion reads the real adapter sources and pins the shape: each implements its port
  // DIRECTLY (never `extends BaseTypeormRepository`, whose public `save`/`softDelete` would
  // contradict append-only) and exposes no UPDATE/DELETE mutator — the sole write verb is
  // `append`, via TypeORM `insert`.
  describe('event-store repositories are append-only (structural)', () => {
    const repoFiles = [
      'apps/event-store-microservice/src/modules/audit-and-events/infrastructure/persistence/domain-event-typeorm.repository.ts',
      'apps/event-store-microservice/src/modules/audit-and-events/infrastructure/persistence/audit-log-entry-typeorm.repository.ts',
    ];

    it.each(repoFiles)(
      '%s implements its port directly, never extends BaseTypeormRepository',
      (relPath) => {
        const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
        // Implements the repository port directly (the append-only seam)...
        expect(source).toMatch(
          /export class \w+TypeormRepository\s+implements\s+I\w+RepositoryPort/,
        );
        // ...and deliberately does NOT inherit BaseTypeormRepository's save/softDelete surface.
        expect(source).not.toMatch(/extends\s+BaseTypeormRepository/);
      },
    );

    it.each(repoFiles)(
      '%s exposes append() but declares/calls no save/update/delete mutator',
      (relPath) => {
        const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
        // The append verb is present...
        expect(source).toMatch(/public\s+async\s+append\s*\(/);
        // ...and no mutating method is declared or reached. The repos call `.insert(...)` and
        // `.find(...)` only — never `.save`/`.update`/`.delete`/`.softDelete`/`.remove`. (The
        // prose comments write ``save`:`` and uppercase "UPDATE or DELETE", neither matching
        // `<verb>(`.)
        expect(source).not.toMatch(/\b(save|update|delete|softDelete|remove)\s*\(/);
      },
    );
  });

  // ADR-041. Before this taxonomy existed, `modules/<m>/<m>.module.ts` and the module-root
  // `index.ts` barrel matched no element pattern, so `boundaries/dependencies` skipped them
  // entirely — cross-module isolation held for a deep path (`../orders/application/ports`)
  // but not for the barrel (`../orders`). These fixtures pin the closed hole: the sole
  // cross-module seam is the `auth` barrel (ADR-024), and everything else stays shut.
  describe('boundaries/dependencies — module composition root (ADR-041)', () => {
    it('nest-module may not reach a sibling module through a deep path', () => {
      const code = `import { ORDER_REPOSITORY } from '../orders/application/ports';\nexport const x = ORDER_REPOSITORY;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/__fixture__.module.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('nest-module may not reach a sibling module through its barrel', () => {
      const code = `import { orderEntities } from '../orders';\nexport const x = orderEntities;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/__fixture__.module.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('a use case may not reach a sibling module through its barrel', () => {
      const code = `import { orderEntities } from '../../../orders';\nexport const x = orderEntities;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/cart/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('nest-module may wire its own module’s use cases', () => {
      const code = `import { ReserveStockUseCase } from './application/use-cases';\nexport const x = ReserveStockUseCase;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/__fixture__.module.ts',
      );
      expect(messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'))).toEqual([]);
    });

    it('the gateway auth barrel is the one sanctioned cross-module seam (ADR-024)', () => {
      const code = `import { ROLE_REPOSITORY } from '../../../auth';\nexport const x = ROLE_REPOSITORY;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/iam/application/use-cases/__fixture__.ts',
      );
      expect(messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'))).toEqual([]);
    });

    // `no-unknown-files` only became enforceable once the composition roots and barrels were
    // typed. It is the bumper against the drift returning: a file that belongs to no element
    // is a file no other rule can govern.
    it('a file matching no element pattern is rejected outright', () => {
      const code = `export const orphan = 1;\n`;
      const messages = lint(code, 'apps/api-gateway/src/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/no-unknown-files');
    });

    it('the module composition root itself matches an element pattern', () => {
      const code = `export const x = 1;\n`;
      const messages = lint(code, 'apps/retail-microservice/src/modules/cart/cart.module.ts');
      expect(ruleIds(messages)).not.toContain('boundaries/no-unknown-files');
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
        'apps/inventory-microservice/src/modules/stock/infrastructure/persistence/__fixture__.ts',
      );
      const boundariesMessages = messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'));
      expect(boundariesMessages).toEqual([]);
    });

    it('auth infrastructure/audit may import @retail-inventory-system/contracts (for the IAuditLogPublisher port)', () => {
      // RmqAuditLogPublisher (the real AUDIT_LOG_PUBLISHER adapter, ADR-035)
      // implements the IAuditLogPublisher interface re-exported from contracts.
      // The boundaries config treats audit as in-element-type `infrastructure`,
      // which is already allowed to import lib-contracts.
      const code = `import type { IAuditLogPublisher } from '@retail-inventory-system/contracts';\nexport type X = IAuditLogPublisher;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/auth/infrastructure/audit/__fixture__.ts',
      );
      const boundariesMessages = messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'));
      expect(boundariesMessages).toEqual([]);
    });
  });
});
