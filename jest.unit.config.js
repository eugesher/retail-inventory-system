/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/**/*.spec.ts'],
  modulePathIgnorePatterns: ['<rootDir>/docs/baseline/'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@retail-inventory-system/common$': '<rootDir>/libs/common',
    '^@retail-inventory-system/config$': '<rootDir>/libs/config',
    '^@retail-inventory-system/contracts$': '<rootDir>/libs/contracts',
    '^@retail-inventory-system/database$': '<rootDir>/libs/database',
    '^@retail-inventory-system/inventory$': '<rootDir>/libs/inventory',
    '^@retail-inventory-system/retail$': '<rootDir>/libs/retail',
  },
  testEnvironment: 'node',
};
