# Build and CI

This file covers how a deployable is built: the two webpack configurations the Nest CLI runs, one
for the production bundle and one for watch mode. The monorepo layout and the per-app
`dist/apps/<service>/` output are decided in
[ADR-018](../adr/018-nestjs-monorepo-apps-and-libs.md). Why the bundle leaves npm packages
external, so that the image ships a production `node_modules`, is in
[ADR-061](../adr/061-one-parameterized-dockerfile.md) and
[ADR-062](../adr/062-pruning-dev-dependencies.md).

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
