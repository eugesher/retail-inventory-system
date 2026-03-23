/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.e2e-spec.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@retail-inventory-system/common$': '<rootDir>/libs/common',
    '^@retail-inventory-system/config$': '<rootDir>/libs/config',
    '^@retail-inventory-system/inventory$': '<rootDir>/libs/inventory',
    '^@retail-inventory-system/retail$': '<rootDir>/libs/retail',
  },
  testEnvironment: 'node',
  testTimeout: 120_000,
  setupFiles: ['<rootDir>/test/jest.setup.ts'],
};
