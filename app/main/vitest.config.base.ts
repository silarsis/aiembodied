import { defineConfig } from 'vitest/config';

export const createVitestConfig = (testPattern?: string) =>
  defineConfig({
    test: {
      environment: 'node',
      include: testPattern ? [testPattern] : ['tests/**/*.test.ts'],
      exclude: ['tests/run-dev-env.test.ts'],
      setupFiles: ['tests/setup.ts'],
      // Tests are run via test-electron.mjs which uses Electron as the runtime,
      // so the forks pool workers will inherit Electron's process.execPath
      pool: 'forks',
      poolOptions: {
        forks: {
          singleFork: false,
          isolate: true,
        },
      },
      testTimeout: 30000,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'json', 'html'],
        include: ['src/**/*.ts'],
        exclude: [
          'src/**/*.test.ts',
          'src/**/*.d.ts',
          'node_modules/**'
        ]
      },
    },
  });

