import { defineConfig } from 'vitest/config';
import { type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';

const reactPlugin = react() as PluginOption | PluginOption[];
const plugins: PluginOption[] = Array.isArray(reactPlugin)
  ? [...reactPlugin]
  : [reactPlugin];

export default defineConfig(({ mode }) => ({
  base: mode === 'development' ? '/' : './',
  plugins,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.ts',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environmentMatchGlobs: [['tests/vite-config.test.ts', 'node']],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/**/*.d.ts',
        'node_modules/**'
      ]
    },
  },
}));
