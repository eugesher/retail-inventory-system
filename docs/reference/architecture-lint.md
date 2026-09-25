# Architecture lint

This file covers what `eslint.config.mjs` does as ESLint applies it today: which files it reaches,
how `eslint-plugin-boundaries` types a file and decides an import, and the three rules that live
outside the plugin. [`README.md` §3](../../README.md#architecture-lint) gives the overview of the
layer rules. The taxonomy, the allow lists and the denylists, with their reasons, are in
[ADR-017](../adr/017-architecture-lint-via-eslint-boundaries.md). The composition root and the
barrels are in [ADR-041](../adr/041-nest-module-as-the-module-composition-root.md), the
`lib-database` → `lib-ddd` edge in
[ADR-043](../adr/043-lifting-forced-duplicates-into-shared-libs.md), the `EntityManager` rule in
[ADR-054](../adr/054-the-entity-manager-downcast-is-an-idiom.md), and `ClientProxy` containment in
[ADR-009](../adr/009-port-adapter-at-the-gateway.md). What guards this config against being
weakened is in [`testing.md`](testing.md#architecture-lintspects).

## What is linted

- **A warning fails the build.** `yarn lint` is `eslint . --max-warnings 0` (`package.json`), and it
  is what the CI `lint` job and the pre-commit `lint-staged` hook (`yarn lint:fix`, same flag) run. So
  `@typescript-eslint/explicit-function-return-type` and `quotes`, both `warn`, block a change just
  as an `error` does.
- **The JS configs next to it are not linted.** `**/*.config.js` is ignored, which covers
  `jest.unit.config.js`, `jest.e2e.config.js`, `webpack.config.js` and `webpack-hmr.config.js`.
  `migrations/config/**` is ignored as well. `eslint.config.mjs` itself is linted.
- **Type-aware rules apply to `.ts` only.** `recommendedTypeChecked` and `stylisticTypeChecked` run
  through `projectService`. `stylisticTypeChecked` brings `consistent-type-assertions`, so an
  angle-bracket assertion (`<T>x`) is rejected everywhere and `as` is the only cast syntax.
- **House rules on every file:** an interface is named `I` + PascalCase and an enum ends in `Enum`
  (`@typescript-eslint/naming-convention`); every class member states its accessibility, except a
  constructor (`explicit-member-accessibility`); `no-console` is an error.
- **Two relaxations.** Under `test/**` and `spec/**`, `no-restricted-imports`, `quotes`,
  `no-explicit-any`, the five `no-unsafe-*` rules, `no-unnecessary-type-assertion`, the two
  explicit-type rules and `no-require-imports` are off. Under `scripts/**`, `no-console` and the two
  explicit-type rules are off. Neither folder is inside the `boundaries` block.

## How a file gets its element type

- **Barrels are targets, never sources.** The `boundaries` block covers every `.ts` file under
  `apps/` and `libs/` except specs, `*.d.ts` files and every `index.ts`. No rule of the block
  applies to an `index.ts`, so a barrel cannot violate an edge and `no-unknown-files` never reports
  it. It is still a target: a module-root `index.ts` is typed `nest-module` (or
  `shared-module-barrel` for `auth`), which is why an import that goes through a sibling's barrel is
  caught just like a deep path ([ADR-041](../adr/041-nest-module-as-the-module-composition-root.md)).
  The other side of this is that a barrel may re-export what its folder could not import itself:
  the `application/ports/index.ts` of `stock`, `cart`, `orders` and `returns` re-exports
  `OCC_RETRY_ATTEMPTS` from `lib-common`, which is not on the `application-port` allow list.
- **The first element pattern that matches decides the type.** `@boundaries/elements` 2.0.1 stops at
  the first descriptor in `boundariesElements` that matches. The gateway's
  `modules/auth/index.ts` matches both `shared-module-barrel` and `nest-module`, so the barrel entry
  has to stay first.
- **Where a file may sit.** Under `apps/<app>/src/` a file is typed only if it is `main.ts`, under
  `app/` or `common/`, directly in `modules/<m>/`, or under one of `modules/<m>/domain/`,
  `application/use-cases/`, `application/ports/`, `application/dto/`, `infrastructure/` or
  `presentation/` (any depth below those). Anything else fails `boundaries/no-unknown-files`: a
  `modules/<m>/utils/` folder, a fourth `application/` subfolder, a file in the root of `src/`, a new
  folder under `libs/` that has no `lib-*` entry.

## How an import is decided

- **Everything is denied unless a rule allows it.** `boundaries/dependencies` runs with
  `default: 'disallow'` and `checkAllOrigins: true`, so npm and node-core imports are judged too.
  Rule 0 of `dependencyRules` allows every `external` and `core` target.
- **The last rule that matches wins** (`eslint-plugin-boundaries` 6.0.2, `evaluateRules`). Within one
  rule, a matching `disallow` wins over its `allow`. The per-layer package denylists at the end of
  the array override rule 0 only because they come after it.
- **An import into a file with no element type is not checked.** `checkUnknownLocals` is left at its
  default, `false`. An import from `apps/` or `libs/` of a file under `test/`, `scripts/` or
  `migrations/` passes, and so does an import of a path that resolves to no file.
- **Aliases resolve through `tsconfig.json`** (`import/resolver.typescript.project`), so an
  `@retail-inventory-system/*` import is judged by the file it points at.
- **A few edges go beyond what ADR-017 §3 lists.** A use case may import another use case of its own
  module. A presentation file may import its own module's `domain`. The `auth` barrel is open to
  `application-use-case`, `presentation`, `nest-module` and `app-bootstrap`, and closed to
  `infrastructure`. `presentation` may import all of `lib-messaging`; the code uses only
  `ROUTING_KEYS` from it.

## The rules outside the plugin

- **`AppModule` imports.** The `@retail-inventory-system/apps/<app>` aliases point at each
  `apps/<app>/src/app/app.module` (`tsconfig.json`), so the e2e suites can boot whole apps in
  process. `no-restricted-imports` rejects them everywhere else, with the pattern held once in
  `APP_MODULE_IMPORT_PATTERN`.
- **`ClientProxy` containment.** A second block for `apps/**/*.ts`, except
  `apps/*/src/modules/*/infrastructure/messaging/**`, forbids importing `ClientProxy`,
  `ClientProxyFactory` and `ClientsModule` from `@nestjs/microservices`. It uses `importNames`
  because it has to name a symbol rather than a module: every other export of the package stays
  importable. `ClientProxyFactory` and `ClientsModule` have no import anywhere in `apps/`; the
  clients are built in `libs/messaging/clients/`, which the rule does not cover.
- **A later block's options replace the earlier ones.** In a flat config, a rule entry with options
  in a later matching block replaces the earlier options instead of merging with them (checked
  against ESLint 10.1.0). The `ClientProxy` block therefore repeats
  `patterns: [APP_MODULE_IMPORT_PATTERN]`. Without it, `AppModule` imports would be allowed under
  `apps/`.
- **`as EntityManager`.** `no-restricted-syntax` with the selector
  `TSAsExpression[typeAnnotation.typeName.name="EntityManager"]` rejects the cast in `apps/**/*.ts`
  outside specs; the one sanctioned downcast is `entityManagerOf` in
  `libs/database/typeorm-transaction.adapter.ts`, which the rule does not cover. The selector
  matches the type's bare name, so `x as EntityManager` and `x as unknown as EntityManager` are
  caught. A qualified name (`x as typeorm.EntityManager`), an `import('typeorm').EntityManager` type
  and a local alias of the type are not.

## Failure modes

| What breaks                                                             | How it shows                                                                              | What recovers it                                                                                                              |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| A new file sits outside the typed folders                               | `boundaries/no-unknown-files` on that file                                                | Move it to the layer it belongs in, or give a new lib its `lib-*` entry and edges (ADR-017)                                   |
| `nest-module` is moved ahead of `shared-module-barrel`                  | The `auth` barrel becomes an ordinary `nest-module`; `iam` and `customer-admin` fail lint | Restore the order; `spec/architecture-lint.spec.ts` asserts it                                                                |
| A denylist entry is moved above rule 0                                  | Rule 0 re-allows the package and `yarn lint` stays green                                  | Keep the denylists after rule 0; the denylist fixtures in `spec/architecture-lint.spec.ts` go red for the packages they cover |
| A block adds `no-restricted-imports` options without the shared pattern | `AppModule` imports stop being rejected for the files it covers                           | Repeat `patterns: [APP_MODULE_IMPORT_PATTERN]` in that block                                                                  |
| Production code imports from `test/` or `scripts/`                      | Nothing; the import is not checked                                                        | Review; move the shared code into a lib                                                                                       |
