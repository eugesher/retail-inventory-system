const webpackNodeExternals = require('webpack-node-externals');
const { RunScriptWebpackPlugin } = require('run-script-webpack-plugin');

const baseConfigFactory = require('./webpack.config');

module.exports = (options, webpack) => {
  const config = baseConfigFactory(options);

  return {
    ...config,
    entry: ['webpack/hot/poll?100', config.entry],
    externals: [
      webpackNodeExternals({
        allowlist: [/^@retail-inventory-system/, 'webpack/hot/poll?100'],
      }),
    ],
    output: {
      ...config.output,
      clean: false,
    },
    optimization: {
      ...config.optimization,
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
