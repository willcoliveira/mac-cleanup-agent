import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['tests/**/*.test.ts'],
    // The e2e suite builds a synthetic HOME per test; keep them isolated.
    pool: 'forks',
    testTimeout: 30_000,
    // Building that HOME takes over 10 s on the Intel CI runners.
    hookTimeout: 60_000,
  },
});
