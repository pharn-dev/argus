import { defineConfig } from 'vitest/config';

// PHARN's gate runner sets PHARN_TEST_RESULTS to the path where it expects a
// machine-readable per-test report (pharn.config.json `testResults.test`).
const resultsFile = process.env['PHARN_TEST_RESULTS'];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    ...(resultsFile ? { reporters: ['default', 'json'], outputFile: { json: resultsFile } } : {}),
  },
});
