import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/setup/jsdom-storage.ts'],
    include: ['tests/**/*.test.{ts,js}', 'packages/lingxi-provider/tests/**/*.test.ts'],
    env: { LINGXI_LANGUAGE: 'zh' },
    testTimeout: 20000,
    // a busy Windows runner takes longer than the 1 s default to reach what a poll waits for
    expect: { poll: { timeout: 10_000 } },
    pool: 'forks',
  },
});
