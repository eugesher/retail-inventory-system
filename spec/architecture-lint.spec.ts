// Fixture suite for the eslint-plugin-boundaries rules of ADR-017. Each fixture below
// intentionally violates one rule, and the spec asserts ESLint reports the expected
// `boundaries/*` ruleId for it.
//
// **It lints against the REAL `eslint.config.mjs` — the one CI runs.** `beforeAll` asks the ESLint
// binary, through `--print-config`, *"what configuration do you actually apply to this source file?"*
// and the fixtures are then linted with the answer: the resolved `boundaries/elements`, the resolved
// `boundaries/dependencies` rules, and the resolved severities. **Weaken a rule in the production
// config and these tests go red** — demonstrated both ways round when this was fixed:
//
//   'boundaries/no-unknown-files': 'error' → 'off'      →  1 test red
//   drop 'typeorm' from the domain denylist             →  5 tests red
//
// **It used to do the opposite, and that is why this comment is long.** The suite built its `Linter`
// from its own hand-mirrored copies of the taxonomy, so it proved only *"the plugin, given THIS
// taxonomy, reports these ruleIds"* — and nothing at all about the config CI runs. Setting
// `'boundaries/no-unknown-files': 'off'` in `eslint.config.mjs` left **all 74 tests green**, and
// `yarn lint` green with it. `CLAUDE.md` calls `yarn lint` *"the source of truth for where a file
// belongs"* and says *"never weaken a `boundaries/*` rule"* — and the thing everyone believed was
// the backstop for that instruction was **a false green light** (ISSUE-10). At 1029 lines and 74
// passing tests, nobody re-derives it.
//
// **There is no second copy of the taxonomy any more.** Not a mirrored one, not a shared one —
// `eslint.config.mjs` is the single source, and this file reads it through the ESLint API rather
// than restating it. Drift is not *detected*; it is **impossible**.
//
// What the fixtures still buy, and it is real: they pin **the plugin's own behaviour** — the v6
// `DependencySelector` shape, the `{{from.captured.module}}` templating, the first-match element
// ordering — against a plugin upgrade changing semantics under us. They are the independent
// expectation. That is why they are hand-written and stay hand-written.

import { execFileSync } from 'child_process';
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

// **The taxonomy is NOT restated here.** It is read from the production config at run time — see
// `beforeAll`. What lives in this file is the thing the production config cannot supply: an
// independent expectation of what its rules ought to reject.

// The file whose RESOLVED configuration is the one under test. It has to be a real source file the
// boundaries block actually applies to — ESLint resolves a config per path, and a path that matched
// nothing would hand back an empty rule set and quietly turn every assertion below into a tautology.
const PROBE_FILE =
  'apps/api-gateway/src/modules/cart/application/use-cases/create-cart.use-case.ts';

// Populated in `beforeAll` from `eslint.config.mjs`, via ESLint's own resolver — so it carries every
// merged config block, every override and every severity exactly as CI sees them.
let resolved: Linter.Config;

// Ask ESLint what it ACTUALLY applies to `PROBE_FILE`. This is the whole fix: not a second copy of
// the taxonomy kept in step by discipline, and not a shared module both sides import — **the resolved
// production configuration itself**, merged from every matching block in `eslint.config.mjs`, with
// every override and every severity already folded in.
//
// It matters that this is the *resolved* config and not the source of one config object. A rule can
// be weakened three ways — change the severity, weaken a `disallow`, or add a later block that
// overrides an earlier one — and only the resolved answer catches all three. A shared-taxonomy module
// would have caught the first two and missed the third, which is the one that looks most like a
// harmless refactor.
//
// **It runs ESLint as a CHILD PROCESS, and that is not a detour — it is the only way.** The in-process
// `ESLint#calculateConfigForFile` does exactly this job and **cannot be used from here**:
// `eslint.config.mjs` is ESM, ESLint loads it with a dynamic `import()`, and **Jest's VM sandbox
// rejects that outright** — *"A dynamic import callback was invoked without
// --experimental-vm-modules"*. A real Node process has no such restriction, and `eslint
// --print-config` is the CLI surface of the very same resolver.
//
// So the spec asks the **same ESLint binary CI runs**, on the same config file, and parses its answer.
// It costs one process spawn, once, in `beforeAll`.
beforeAll(() => {
  const json = execFileSync('npx', ['eslint', '--print-config', PROBE_FILE], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  });
  resolved = JSON.parse(json) as Linter.Config;

  // **Fail loudly if the probe resolved to nothing.** A `PROBE_FILE` that matched no config block
  // would hand back an empty rule set, every fixture below would report no violation, and the suite
  // would go green while guarding nothing — which is precisely the failure mode this whole task
  // exists to remove. Do not let it come back through the side door.
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
        // The plugin types its rules loosely; the cast is hermetic to the test.
        boundaries: boundariesPlugin as unknown as Plugin,
      },
      // Straight from the production config — `boundaries/elements` (in its ORDER, which is
      // load-bearing: the plugin takes the FIRST matching pattern), `include`, `ignore`.
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

// Direct assertions on the RESOLVED production config. The fixtures below prove *"this taxonomy
// rejects this import"*; these prove *"the production config still carries that taxonomy, at that
// severity, in that order."* They catch what a fixture structurally cannot:
//
//   * a severity dropped to `warn` — every fixture still reports its ruleId, so every fixture stays
//     green, and CI stops failing. **A warning is not a guard.**
//   * the element ORDER reshuffled — `boundaries` takes the FIRST matching pattern, so `nest-module`
//     (`modules/*/*.ts`) drifting ahead of `shared-module-barrel` (`modules/auth/index.ts`) silently
//     retypes the gateway `auth` barrel and quietly kills `ARCH-LINT-EX-02`. An `Object.entries`
//     round-trip or a tidy-up sort would do it, and nothing else in this file would notice.
describe('the production config itself (eslint.config.mjs, as ESLint resolves it)', () => {
  const severityOf = (entry: unknown): unknown =>
    Array.isArray(entry) ? (entry as unknown[])[0] : entry;

  // 2 = error. A `warn` here would let every violation through CI while this suite stayed green.
  it('enforces boundaries/no-unknown-files at ERROR, not warn', () => {
    expect(severityOf(resolved.rules?.['boundaries/no-unknown-files'])).toBe(2);
  });

  it('enforces boundaries/dependencies at ERROR, and denies by default', () => {
    const entry = resolved.rules?.['boundaries/dependencies'] as [number, { default: string }];
    expect(severityOf(entry)).toBe(2);
    // `default: 'allow'` would invert the entire model — everything permitted unless named — and not
    // one fixture below would change its answer, because each names its own violation.
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
    // Both patterns match `modules/auth/index.ts`. Whichever comes first wins, and the gateway `auth`
    // barrel — the repo's ONE sanctioned cross-module-consumable barrel — depends on it being this
    // one.
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

  // ADR-043. The transaction seam is the one thing `libs/database` knows about the domain
  // kernel. The edge is one-way by construction, and these two fixtures are what keep it so —
  // widen `lib-ddd`'s allow list and the second one fails.
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
