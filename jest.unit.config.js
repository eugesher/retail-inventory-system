const { pathsToModuleNameMapper } = require('ts-jest');

const { compilerOptions } = require('./tsconfig.json');

// `moduleNameMapper` is DERIVED from `compilerOptions.paths`; the alias list is not written
// out here. tsconfig.json is the one place an alias is declared, and the two hand-written
// copies this replaces had drifted from it — both still mapped
// `@retail-inventory-system/{inventory,retail}`, libs deleted in `2c0e137` (2026-05-15).
//
// Those entries were harmless in themselves: a mapping onto a directory that does not exist
// can never be exercised, because ts-jest type-checks the import against tsconfig first and
// tsconfig has no such path. What they prove is that nobody reads this list — and the cost
// of that lands on the opposite case. Adding a lib meant editing THREE files (tsconfig plus
// both jest configs); forgetting the jest half type-checks clean and then fails at run time
// with `Cannot find module`, one edit away from where the mistake was made. Deriving removes
// the copies instead of correcting them.
/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/**/*.spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: pathsToModuleNameMapper(compilerOptions.paths, { prefix: '<rootDir>/' }),
  testEnvironment: 'node',
};
