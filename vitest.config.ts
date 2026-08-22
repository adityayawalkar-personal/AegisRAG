import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    pool: 'forks',
    forks: {
      singleFork: true,
    },
    fileParallelism: false,
    maxWorkers: 1,
    isolate: true,
    testTimeout: 30000,
    hookTimeout: 30000,
    env: {
      NODE_ENV: 'test',
      API_AUTH_SECRET: 'ci-secret-auth-token-test-2026',
      LOG_LEVEL: 'silent',
      DOTENV_CONFIG_QUIET: 'true',
    },
  },
});
