import { execFileSync } from 'child_process';
import { Linter } from 'eslint';
import * as fs from 'fs';
import * as path from 'path';

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

const PROBE_FILE =
  'apps/api-gateway/src/modules/cart/application/use-cases/create-cart.use-case.ts';

let resolved: Linter.Config;

beforeAll(() => {
  const json = execFileSync('npx', ['eslint', '--print-config', PROBE_FILE], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  resolved = JSON.parse(json) as Linter.Config;

  if (resolved.settings?.['boundaries/elements'] === undefined) {
    throw new Error(
      `PROBE_FILE (${PROBE_FILE}) resolved to a config with no boundaries/elements — the suite would ` +
        'prove nothing. Point it at a source file the boundaries block actually applies to.',
    );
  }
}, 120_000);

function buildLinter(): { linter: Linter; config: Linter.Config[] } {
  const linter = new Linter({ configType: 'flat' });

  const config: Linter.Config[] = [
    {
      files: ['**/*.ts'],
      languageOptions: {
        parser: tsParser as Linter.Parser,
      },
      plugins: {
        boundaries: boundariesPlugin as unknown as Plugin,
      },
      settings: resolved.settings,
      rules: {
        'boundaries/dependencies': resolved.rules?.['boundaries/dependencies'] as Linter.RuleEntry,
        'boundaries/no-unknown-files': resolved.rules?.[
          'boundaries/no-unknown-files'
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

describe('the production config itself (eslint.config.mjs, as ESLint resolves it)', () => {
  const severityOf = (entry: unknown): unknown =>
    Array.isArray(entry) ? (entry as unknown[])[0] : entry;

  it('enforces boundaries/no-unknown-files at ERROR, not warn', () => {
    expect(severityOf(resolved.rules?.['boundaries/no-unknown-files'])).toBe(2);
  });

  it('enforces boundaries/dependencies at ERROR, and denies by default', () => {
    const entry = resolved.rules?.['boundaries/dependencies'] as [number, { default: string }];
    expect(severityOf(entry)).toBe(2);
    expect(entry[1].default).toBe('disallow');
  });

  it('keeps shared-module-barrel AHEAD of nest-module — first match wins (ARCH-LINT-EX-02)', () => {
    const types = (resolved.settings?.['boundaries/elements'] as { type: string }[]).map(
      (e) => e.type,
    );
    const barrel = types.indexOf('shared-module-barrel');
    const nestModule = types.indexOf('nest-module');

    expect(barrel).toBeGreaterThanOrEqual(0);
    expect(nestModule).toBeGreaterThanOrEqual(0);
    expect(barrel).toBeLessThan(nestModule);
  });
});

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
      const code = `import { Order } from '../../../../../../retail-microservice/src/modules/orders/domain/order.model';\nexport type Y = Order;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('infrastructure consumer may not reach another app domain (cross-app)', () => {
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

  describe('boundaries/dependencies — gateway auth + iam + customer-admin modules', () => {
    it('auth domain (RoleAggregate, PermissionAggregate, StaffUser, Customer) may not import @retail-inventory-system/messaging', () => {
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
      const code = `import { StaffUserEntity } from '../../auth/infrastructure/persistence/staff-user.entity';\nexport type Y = StaffUserEntity;\n`;
      const messages = lint(code, 'apps/api-gateway/src/modules/iam/presentation/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('customer-admin presentation may not import auth infrastructure (cross-element + cross-module)', () => {
      const code = `import { CustomerEntity } from '../../auth/infrastructure/persistence/customer.entity';\nexport type Y = CustomerEntity;\n`;
      const messages = lint(
        code,
        'apps/api-gateway/src/modules/customer-admin/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

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
      const code = `import { Product } from '../../catalog/domain/product.model';\nexport type Y = Product;\n`;
      const messages = lint(
        code,
        'apps/catalog-microservice/src/modules/pricing/domain/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

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
      const code = `import { FakePaymentGatewayAdapter } from '../infrastructure/payment-gateway/fake-payment-gateway.adapter';\nexport const y = FakePaymentGatewayAdapter;\n`;
      const messages = lint(
        code,
        'apps/retail-microservice/src/modules/orders/presentation/__fixture__.ts',
      );
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });
  });

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
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(code, `${M}/application/ports/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('presentation (FirehoseConsumer, AuditQueryController) may not import typeorm', () => {
      const code = `import { Repository } from 'typeorm';\nexport type X = Repository<unknown>;\n`;
      const messages = lint(code, `${M}/presentation/__fixture__.ts`);
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('the trace use case may inject BOTH repository ports — they are one module (ADR-042)', () => {
      const code = `import { AUDIT_LOG_REPOSITORY, DOMAIN_EVENT_REPOSITORY } from '../ports';\nexport const x = [AUDIT_LOG_REPOSITORY, DOMAIN_EVENT_REPOSITORY];\n`;
      const messages = lint(code, `${M}/application/use-cases/__fixture__.ts`);
      expect(messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'))).toEqual([]);
    });
  });

  describe('event-store repositories are append-only (structural)', () => {
    const repoFiles = [
      'apps/event-store-microservice/src/modules/audit-and-events/infrastructure/persistence/domain-event-typeorm.repository.ts',
      'apps/event-store-microservice/src/modules/audit-and-events/infrastructure/persistence/audit-log-entry-typeorm.repository.ts',
    ];

    it.each(repoFiles)(
      '%s implements its port directly, never extends BaseTypeormRepository',
      (relPath) => {
        const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
        expect(source).toMatch(
          /export class \w+TypeormRepository\s+implements\s+I\w+RepositoryPort/,
        );
        expect(source).not.toMatch(/extends\s+BaseTypeormRepository/);
      },
    );

    it.each(repoFiles)(
      '%s exposes append() but declares/calls no save/update/delete mutator',
      (relPath) => {
        const source = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
        expect(source).toMatch(/public\s+async\s+append\s*\(/);
        expect(source).not.toMatch(/\b(save|update|delete|softDelete|remove)\s*\(/);
      },
    );
  });

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

  describe('boundaries/dependencies — the transaction seam (ADR-043)', () => {
    it('lib-database MAY import lib-ddd (the adapter implements ITransactionPort)', () => {
      const code = `import { ITransactionPort } from '@retail-inventory-system/ddd';\nexport type X = ITransactionPort;\n`;
      const messages = lint(code, 'libs/database/__fixture__.ts');
      expect(messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'))).toEqual([]);
    });

    it('lib-ddd may NOT import lib-database — the reverse edge stays shut', () => {
      const code = `import { BaseEntity } from '@retail-inventory-system/database';\nexport const x = BaseEntity;\n`;
      const messages = lint(code, 'libs/ddd/__fixture__.ts');
      expect(ruleIds(messages)).toContain('boundaries/dependencies');
    });

    it('an application use case may reach the seam through lib-ddd, not lib-database', () => {
      const code = `import { TRANSACTION_PORT } from '@retail-inventory-system/ddd';\nexport const x = TRANSACTION_PORT;\n`;
      const messages = lint(
        code,
        'apps/inventory-microservice/src/modules/stock/application/use-cases/__fixture__.ts',
      );
      expect(messages.filter((m) => (m.ruleId ?? '').startsWith('boundaries/'))).toEqual([]);
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
