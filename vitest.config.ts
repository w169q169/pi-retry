import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    // Retry tests advance fake timers across the full backoff schedule, and the
    // loop polls for aborts every 100ms. Advancing 60s therefore drives ~600
    // real microtask ticks, which lands close to Vitest's 5s default and makes
    // those tests flaky. The extra headroom keeps them deterministic.
    testTimeout: 20_000,
    include: ['__tests__/**/*.test.ts'],
    exclude: ['node_modules', 'dist', '.idea', '.git', '.cache'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', '**/*.d.ts', '**/*.test.ts'],
    },
  },
});
