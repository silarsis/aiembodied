import { defineConfig } from 'vitest/config';
import { type PluginOption } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Serves the MediaPipe tasks-vision WASM files from this app instead of a CDN: in `vite dev` under
 * /mediapipe/wasm/, and in `vite build` as files in dist/mediapipe/wasm/. The face detector for camera presence
 * (src/camera) loads them from there, so nothing is fetched from the internet when the app runs.
 */
function mediapipeWasm(): PluginOption {
  const folder = join(dirname(fileURLToPath(import.meta.url)), 'node_modules', '@mediapipe', 'tasks-vision', 'wasm');
  const files = () => (existsSync(folder) ? readdirSync(folder).filter((name) => /^vision_wasm.*\.(js|wasm)$/.test(name)) : []);
  return {
    name: 'aiembodied-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use('/mediapipe/wasm', (request, response, next) => {
        const name = decodeURIComponent((request.url ?? '').split('?')[0]).replace(/^\//, '');
        if (!files().includes(name)) return next();
        response.setHeader('Content-Type', name.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        response.end(readFileSync(join(folder, name)));
      });
    },
    generateBundle() {
      for (const name of files()) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/wasm/${name}`, source: readFileSync(join(folder, name)) });
      }
    },
  };
}

const reactPlugin = react() as PluginOption | PluginOption[];
const plugins: PluginOption[] = Array.isArray(reactPlugin)
  ? [...reactPlugin]
  : [reactPlugin];
plugins.push(mediapipeWasm());

export default defineConfig(({ mode }) => ({
  base: mode === 'development' ? '/' : './',
  plugins,
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: './vitest.setup.ts',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
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
