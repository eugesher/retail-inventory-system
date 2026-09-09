const { pathsToModuleNameMapper } = require('ts-jest');

const { compilerOptions } = require('./tsconfig.json');

// Derived from `compilerOptions.paths` — see the note in `jest.unit.config.js` for why the
// hand-written map is gone. The two configs now resolve aliases identically by construction;
// they used to differ (this one carried the `apps/*` AppModule aliases, that one did not),
// and nothing declared which difference was intended.
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  testEnvironment: 'node',
  testTimeout: 120_000,
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
};
