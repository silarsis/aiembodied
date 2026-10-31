// @vitest-environment node
import config from '../vite.config';
import type { ConfigEnv, UserConfig } from 'vite';
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

type Mode = 'development' | 'production';

type ConfigExport = typeof config;

type ConfigFactory = Extract<ConfigExport, (env: ConfigEnv) => UserConfig | Promise<UserConfig>>;

type ConfigValue = Extract<ConfigExport, UserConfig | Promise<UserConfig>>;

async function resolveConfig(mode: Mode): Promise<UserConfig> {
  const env: ConfigEnv = {
    mode,
    command: mode === 'development' ? 'serve' : 'build',
  };

  const result = typeof config === 'function'
    ? (config as ConfigFactory)(env)
    : (config as ConfigValue);

  return await Promise.resolve(result);
}

describe('vite configuration', () => {
  it('bundles model inspection code without a click-time dynamic chunk', async () => {
    const result = await build({
      root: fileURLToPath(new URL('../', import.meta.url)),
      configFile: fileURLToPath(new URL('../vite.config.ts', import.meta.url)),
      mode: 'production',
      logLevel: 'silent',
      build: { write: false, minify: false, reportCompressedSize: false },
    });
    const builds = Array.isArray(result) ? result : [result];
    const chunks = builds.flatMap((output) => 'output' in output ? output.output : [])
      .filter((output) => output.type === 'chunk');
    const inspector = chunks.find((chunk) =>
      Object.keys(chunk.modules).some((id) => id.replaceAll('\\', '/').endsWith('/avatar/model-review-scene.ts')),
    );
    expect(inspector).toBeDefined();
    expect(inspector?.isDynamicEntry).toBe(false);
  }, 15000);
  it('uses an absolute base path during development', async () => {
    const resolved = await resolveConfig('development');
    expect(resolved.base).toBe('/');
  });

  it('uses a relative base path for production builds', async () => {
    const resolved = await resolveConfig('production');
    expect(resolved.base).toBe('./');
  });
});
