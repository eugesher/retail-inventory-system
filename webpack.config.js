const path = require('path');
const TerserWebpackPlugin = require('terser-webpack-plugin');
const tsconfigPathsWebpackPlugin = require('tsconfig-paths-webpack-plugin');
const webpack = require('webpack');
const webpackNodeExternals = require('webpack-node-externals');

module.exports = (options) => {
  const { entry, plugins, resolve } = options;

  let projectName = 'default';

  if (entry && typeof entry === 'string') {
    const match = entry.match(/apps\/([^/]+)\/src\/main\.ts$/);

    if (match && match[1]) {
      projectName = match[1];
    }
  }

  console.log(`[Webpack] Building project: ${projectName}\n`);

  return {
    ...options,
    externals: [
      webpackNodeExternals({
        allowlist: [/^@retail-system/],
      }),
    ],
    output: {
      path: path.resolve(process.cwd(), 'dist/apps', projectName),
      filename: 'main.js',
      libraryTarget: 'commonjs2',
      clean: true,
    },
    resolve: {
      ...resolve,
      plugins: [
        ...(resolve?.plugins || []),
        new tsconfigPathsWebpackPlugin({
          configFile: path.resolve(__dirname, 'tsconfig.json'),
        }),
      ],
    },
    plugins: [
      ...(plugins || []),
      new webpack['BannerPlugin']({
        banner: 'require("source-map-support").install();',
        raw: true,
        entryOnly: true,
      }),
    ],
    target: 'node',
    node: {
      __dirname: false,
      __filename: false,
    },
    optimization: {
      minimize: true,
      minimizer: [
        new TerserWebpackPlugin({
          terserOptions: {
            format: {
              comments: false,
              beautify: true,
              indent_level: 2,
              indent_start: 0,
              keep_numbers: true,
            },
            compress: false,
            mangle: false,
          },
          extractComments: false,
        }),
      ],
    },
  };
};
