import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    maxWorkers: 2,
    testTimeout: 45_000,
    hookTimeout: 45_000
  }
});
