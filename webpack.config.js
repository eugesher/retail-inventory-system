const path = require('path');
const webpack = require('webpack');
const TsconfigPathsPlugin = require('tsconfig-paths-webpack-plugin');
const nodeExternals = require('webpack-node-externals');

module.exports = (options, webpack) => {
  const { entry } = options;

  let projectName = 'default';

  if (entry && typeof entry === 'string') {
    const match = entry.match(/apps\/([^/]+)\/src\/main\.ts$/);
    if (match && match[1]) {
      projectName = match[1];
    }
  }

  if (projectName === 'default') {
    const cwd = process.cwd();
    const possibleName = path.basename(cwd);
    if (possibleName !== 'apps') projectName = possibleName;
  }

  return {
    ...options,
    externals: [
      nodeExternals({
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
      ...options.resolve,
      plugins: [
        ...(options.resolve?.plugins || []),
        new TsconfigPathsPlugin({
          configFile: path.resolve(__dirname, 'tsconfig.json'),
        }),
      ],
    },
    plugins: [
      ...(options.plugins || []),
      new webpack.BannerPlugin({
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
  };
};
