# Build and CI

This file covers how the code is built, checked and run outside a test:

- the Node and Yarn versions;
- the two webpack configurations the Nest CLI runs;
- the `Dockerfile`;
- the CI workflow and the pre-commit hook;
- the compose files;
- `yarn start:dev`.

The monorepo layout and the per-app `dist/apps/<service>/` output are decided in
[ADR-018](../adr/018-nestjs-monorepo-apps-and-libs.md). The single parameterized `Dockerfile` is
[ADR-061](../adr/061-one-parameterized-dockerfile.md). Why the bundle leaves npm packages external,
so that the image ships a production `node_modules`, is
[ADR-062](../adr/062-pruning-dev-dependencies.md). Why the build copies every workspace manifest is
[ADR-058](../adr/058-workspace-membership-and-the-list-that-could-not-fail.md). The environment
variables are in [`README.md` §8](../../README.md#8-configuration); the databases and the migration
pipelines are in [`persistence.md`](persistence.md).

## Node and Yarn

- **`.nvmrc` is the one declaration of the Node version.** CI reads it through
  `actions/setup-node`'s `node-version-file` (`.github/actions/setup/action.yml`), and a developer
  reads it with `nvm use`.
- **The `Dockerfile` cannot read it.** Its `FROM node:24-alpine` follows the major version, so an
  image runs the latest 24.x at build time, which need not be the version CI tested. The `Dockerfile`
  does not repeat the version, on purpose: a copy that nobody updates is worse than a known gap.
- **Yarn is the release checked in under `.yarn/releases/`.** `.yarnrc.yml` points `yarnPath` at it,
  and `package.json` names the same version in `packageManager`. `yarn set version` rewrites all three
  together. CI runs `corepack enable`. Whichever Yarn binary starts first then defers to `yarnPath`.
- **The `Dockerfile` runs `node <yarnPath>` directly and does not use corepack**, because corepack
  would reach the registry in the middle of a build. Each `RUN` that needs Yarn reads the path from
  `.yarnrc.yml` with `sed`, so a Yarn upgrade cannot leave a stale path in the `Dockerfile`. The same
  `RUN` fails with `test -n` if the key is missing or renamed, instead of handing `node` an empty
  path.

## Path aliases

Every tool reads the `@retail-inventory-system/*` aliases from the `paths` in the root
`tsconfig.json`, so an alias is declared there and nowhere else:

- the webpack build, through `tsconfig-paths-webpack-plugin` (`webpack.config.js`);
- both Jest configurations, through `pathsToModuleNameMapper` ([`testing.md`](testing.md#running));
- ESLint's import resolver (`eslint.config.mjs`, `import/resolver.typescript.project`);
- the `ts-node` scripts, through `-r tsconfig-paths/register` (`typeorm:migration-cli*`,
  `test:seed`).

## The production bundle (`webpack.config.js`)

- **`nest build` always goes through it.** `nest-cli.json` sets `builder: "webpack"` and
  `webpackConfigPath: "webpack.config.js"`. The factory takes the app name from the entry
  `apps/<app>/src/main.ts`. An entry of any other shape prints `App build failed` and exits with
  status 1.
- **One file per app.** The output is `dist/apps/<app>/main.js` in `commonjs2`, and the folder is
  emptied before each build (`output.clean`). `yarn start:prod:<app>` runs that file with `node`.
- **Only this repository's code is bundled.** `webpack-node-externals` leaves every npm package to
  a run-time `require` from `node_modules`. Only `@retail-inventory-system/*` imports go into the
  bundle, and they are resolved through `tsconfig.json`.
- **The bundle is readable, and it has no source map.** Terser runs with `compress: false`,
  `mangle: false`, `beautify: true` and `comments: false`, so a stack trace names the real functions
  and points at readable code. The Nest CLI's webpack defaults set `devtool: false` outside debug
  mode (`@nestjs/cli` 11.0.21, `webpack-defaults.js`), and a built `main.js` carries no
  `sourceMappingURL`. So the `require("source-map-support").install()` banner that `BannerPlugin`
  puts at the top of every bundle has no map to apply.

## Watch mode (`webpack-hmr.config.js`)

- **`yarn start:dev:<app>`** is `nest build <app> --webpackPath webpack-hmr.config.js --watch`.
  `yarn start:dev` runs all six through `concurrently` (`scripts/bash/start-dev.sh`).
- **A rebuild is applied in the running process.** The config wraps the production one and prepends
  the `webpack/hot/poll?100` runtime, which checks for an update every 100 ms. The runtime has to be
  bundled, so it is on the externals allowlist. `RunScriptWebpackPlugin` starts `main.js` once, with
  `autoRestart: false`. Every `main.ts` calls `module.hot.accept()` and closes the app in
  `module.hot.dispose`, so an update re-runs the bootstrap inside the same process instead of
  starting a second one.
- **The hot-update files stay on disk** (`output.clean: false`), and minification is off.
  `WatchIgnorePlugin` leaves every `.js` and `.d.ts` file out of the watch.
- **The plugins come from the webpack the CLI passes in.** The factory's second argument is the
  Nest CLI's own webpack. It resolves its own copy (`node_modules/@nestjs/cli/node_modules/webpack`,
  5.106.0 against the root's 5.105.4), and `HotModuleReplacementPlugin` goes through webpack hooks
  that check `compilation instanceof Compilation`. A `HotModuleReplacementPlugin` from a top-level
  `require('webpack')` would come from the other copy and fail that check.

## The image (`Dockerfile`)

Four stages. Their reasons are in ADR-061 and ADR-062; this is what each one holds.

| Stage       | From             | What it does                                                                                                                                                        |
| ----------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `base`      | `node:24-alpine` | copies `.yarnrc.yml`, `package.json`, `yarn.lock`, `.yarn/releases/` and the whole `apps/` tree, then runs `yarn install --immutable`                               |
| `builder`   | `base`           | requires `ARG APP_NAME` (an empty value fails the build), adds `tsconfig.json`, `nest-cli.json`, `webpack.config.js` and `libs/`, and runs `yarn build:${APP_NAME}` |
| `prod-deps` | `base`           | runs `yarn workspaces focus --all --production`. It does not depend on `APP_NAME`, so the six images share one pruned `node_modules` layer                          |
| runtime     | `node:24-alpine` | sets `NODE_ENV=production`, copies `node_modules` from `prod-deps` and `dist/apps/${APP_NAME}/` into `./dist/`, and runs `node dist/main.js`                        |

- **`apps/` is copied whole before the install.** `yarn install --immutable` needs the `package.json`
  of every workspace in `yarn.lock` (`workspaces: ["apps/*"]`). The cost is that any change under
  `apps/` invalidates the install layer (ADR-058). `.dockerignore` keeps `node_modules`, `dist`,
  `.git`, `.yarn/cache`, `.yarn/install-state.gz`, `.husky`, `test` and `coverage` out of the
  context, so the copy stays small.
- **The runtime image needs `NODE_ENV=production`.** `pino-pretty`, which `LoggerModuleConfig`
  loads on every non-production boot, is a devDependency and is not in the image (ADR-062 §3).
- **The runtime image holds only the bundle and `node_modules`.** It has no `package.json`, no
  `.yarnrc.yml` and no sources, so `yarn start:*` cannot run in it without a bind mount of the
  repository.

## CI (`.github/workflows/ci-cd.yml`)

- **Every push runs four jobs in a chain:** `lint` → `build` → `unit` → `e2e`, each gated by
  `needs:`. Each job runs on a fresh runner. It checks the repository out and runs
  `.github/actions/setup`, which does `setup-node` with the `.nvmrc` version and the Yarn cache,
  `corepack enable` and `yarn install --immutable`. The `checkout` step stays in every job because a
  local composite action is loaded from the working tree, so the repository must already be on disk.
  No job passes files to the next.
- **`lint` is the architecture gate.** `eslint-plugin-boundaries` is part of `eslint.config.mjs`, so a
  layer violation fails `yarn lint` like any other rule. There is no separate architecture script
  ([`architecture-lint.md`](architecture-lint.md)). `spec/architecture-lint.spec.ts` in the `unit` job
  checks the config itself ([`testing.md`](testing.md#architecture-lintspects)).
- **Formatting is checked by `yarn lint`, not by `yarn format:check`.** `eslint.config.mjs` turns on
  `prettier/prettier` as an error for every `.js`, `.cjs`, `.mjs`, `.ts` and `.tsx` file ESLint lints.
  Files ESLint ignores (`**/*.config.js`, `migrations/config/**`) and non-code files are not
  format-checked in CI.
- **The `e2e` job reads no env file.** The repository has no `.env.local`, so every key the Joi schema
  requires is set inline in the job's `env:`. The values are the throwaway ones from `.env.example`, with `LOG_LEVEL=warn`.
  `NODE_ENV` is the exception: `test/jest.setup.ts` sets it to `test`. `EVENTSTORE_DATABASE_URL` is
  there too, because the one shared schema requires it in every service. `OTEL_SERVICE_NAME` and
  `OTEL_EXPORTER_OTLP_ENDPOINT` only satisfy the schema: the e2e suites boot the apps without
  `main.ts`, so the tracer is never loaded.
- **The `e2e` job's services** are `mysql:8.4.8`, `rabbitmq:4.2.3-management` and
  `redis:8.6.0-alpine`, the same images as `docker-compose.yml`, each with a health check. The steps:
  - pipe `scripts/mysql-init/01-create-eventstore-db.sql` to `mysql` as root, because the service
    container cannot mount it ([`persistence.md`](persistence.md#two-databases-two-migration-pipelines));
  - `yarn migration:run`;
  - `yarn migration:run:eventstore`;
  - `yarn test:seed`;
  - `yarn test:e2e:run`.

## The pre-commit hook

`.husky/pre-commit` runs `yarn lint-staged`. For staged `*.{ts,tsx}` files, `.lintstagedrc.json` runs
`yarn lint:fix --no-warn-ignored`, then `yarn format`. lint-staged appends the staged paths to each
command. Both scripts already carry their own paths: `eslint . --fix --max-warnings 0` and
`prettier --write "apps/**/*.ts" "libs/**/*.ts"`. So the hook lints the whole repository and rewrites
every TypeScript file under `apps/` and `libs/`, not only the staged ones. `--no-warn-ignored` keeps
ESLint quiet about a staged file its `ignores` list skips.

## Local infrastructure (`docker-compose.yml`)

- **Three infrastructure services, each with a health check:**
  - `mysql` (`8.4.8`) on `:3306`, with root password `root` and user `retail` / `retailpass`, its
    data on the `mysql-data` volume, and `scripts/mysql-init/` as its init folder;
  - `redis` (`8.6.0-alpine`) on `:6379`;
  - `rabbitmq` (`4.2.3-management`) on `:5672`, with the management UI on `:15672` (`guest` /
    `guest`).

  `yarn test:infra:up` is `docker compose up mysql redis rabbitmq --wait`, which returns once the
  health checks pass. `yarn test:infra:down` is `docker compose down -v --remove-orphans`, which
  deletes `mysql-data`.

- **Six app services build the `Dockerfile` with their `APP_NAME`**, wait for the three
  infrastructure services to be healthy, and replace the image's command:
  - `NODE_ENV` is `development`;
  - the repository is bind-mounted over `/app`, with an anonymous volume on `/app/node_modules`;
  - the command is `yarn start:dev:<app>`.

  Each service sets only some variables in `environment:`. The rest come from the bind-mounted
  `.env.local`, which `ConfigModule` resolves against the working directory `/app`. A variable in
  `environment:` is in the process environment, so the tracer sees `OTEL_SERVICE_NAME` and
  `OTEL_EXPORTER_OTLP_ENDPOINT` (`http://otel-collector:4318/v1/traces`). A host run gets them only
  from the shell ([`README.md` §8](../../README.md#8-configuration)).

- **`DEFAULT_CURRENCY` is set on `api-gateway`, `retail-microservice` and `catalog-microservice`, and
  the three values must match.** Retail opens a cart in it, the catalog's publish gate resolves prices
  in it, and the gateway scopes a price read without `?currency` to it. The variable has a Joi
  default (`USD`), so a service that lacks it boots on `USD` without a warning.
- **The observability overlay is `docker-compose.observability.yml`.** It adds `jaeger`
  (`all-in-one:1.62.0`, UI on `:16686`) and `otel-collector` (`contrib:0.114.0`, OTLP on `:4317` gRPC
  and `:4318` HTTP). The collector config, `infrastructure/otel-collector-config.yaml`, batches spans
  (1 s or 512 spans) and exports them to `jaeger:4317` and to the `debug` exporter. The overlay uses
  the `backend` network that only `docker-compose.yml` defines. On its own, `docker compose -f
docker-compose.observability.yml` fails with _refers to undefined network backend_. Run it with
  both `-f` flags, as [`README.md` §1](../../README.md#1-quick-start) shows.

## `yarn start:dev`

`scripts/bash/start-dev.sh` starts the six `yarn start:dev:<app>` processes under `concurrently`, with
the prefixes `API`, `INV`, `RET`, `NOT`, `CAT` and `EVT`. With `--reload` (or `-r`) it first runs
`yarn test:infra:reload`, which deletes the database volume, applies both migration pipelines and
seeds. It ignores any other argument without a message.
