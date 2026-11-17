module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/**/*.test.cjs'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/database/'],
  testTimeout: 10000,
};
