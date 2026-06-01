const webpackNodeExternals = require('webpack-node-externals');
const { RunScriptWebpackPlugin } = require('run-script-webpack-plugin');

const baseConfigFactory = require('./webpack.config');

// Dev-only config selected via `nest build <app> --webpackPath webpack-hmr.config.js --watch`.
// It wraps the production base config and layers in webpack Hot Module Replacement so a
// rebuild hot-swaps modules inside ONE long-lived process (RunScriptWebpackPlugin) instead
// of killing and respawning the app — which is what caused the EADDRINUSE port race.
//
// `webpack` MUST be the instance the Nest CLI passes in (second argument), not a top-level
// `require('webpack')` — HotModuleReplacementPlugin does a strict `instanceof Compilation`
// check, and the CLI drives the build with its own bundled webpack copy.
module.exports = (options, webpack) => {
  const config = baseConfigFactory(options);

  return {
    ...config,
    // Prepend the HMR poll runtime so `module.hot` is defined at runtime and the bundle
    // polls the compiler for hot updates.
    entry: ['webpack/hot/poll?100', config.entry],
    externals: [
      webpackNodeExternals({
        // The poll runtime must be bundled (not externalized) for HMR to work.
        allowlist: [/^@retail-inventory-system/, 'webpack/hot/poll?100'],
      }),
    ],
    output: {
      ...config.output,
      // HMR needs prior hot-update assets to remain on disk between rebuilds.
      clean: false,
    },
    optimization: {
      ...config.optimization,
      // Skip minification in watch mode — faster rebuilds and no terser interference
      // with the HMR runtime.
      minimize: false,
    },
    plugins: [
      ...config.plugins,
      new webpack.HotModuleReplacementPlugin(),
      new webpack.WatchIgnorePlugin({ paths: [/\.js$/, /\.d\.ts$/] }),
      new RunScriptWebpackPlugin({ name: 'main.js', autoRestart: false }),
    ],
  };
};
