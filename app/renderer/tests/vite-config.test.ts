import config from '../vite.config';
import type { ConfigEnv, UserConfig } from 'vite';
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
  it('uses an absolute base path during development', async () => {
    const resolved = await resolveConfig('development');
    expect(resolved.base).toBe('/');
  });

  it('uses a relative base path for production builds', async () => {
    const resolved = await resolveConfig('production');
    expect(resolved.base).toBe('./');
  });
});
