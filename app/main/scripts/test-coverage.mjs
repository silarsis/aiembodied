#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

function getRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, '../../..');
}

function ensureDir(dir) {
  try { mkdirSync(dir, { recursive: true }); } catch {}
}

function resolveIsolatedStore(repoRoot) {
  const store = resolve(repoRoot, '.dev-home', 'AppData', 'Local', 'pnpm', 'store', 'v3');
  ensureDir(store);
  return store;
}

function getPnpmStorePath(env = process.env) {
  const out = spawnSync('pnpm', ['store', 'path'], { env, encoding: 'utf8' });
  if (out.status !== 0) {
    throw new Error(`Failed to resolve pnpm store path: ${out.stderr || out.stdout || out.status}`);
  }
  const lines = `${out.stdout || ''}${out.stderr || ''}`.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines.at(-1);
}

function determineStoreEnv(repoRoot) {
  const packageRoot = resolve(repoRoot, 'app', 'main');
  // Try to read storeDir from .modules.yaml, if present
  try {
    const modulesYaml = resolve(packageRoot, 'node_modules', '.modules.yaml');
    if (existsSync(modulesYaml)) {
      const raw = readFileSync(modulesYaml, 'utf8');
      const m = raw.match(/\n\s*storeDir:\s*(.+)\s*\n/);
      if (m && m[1]) {
        return m[1].trim();
      }
    }
  } catch {}
  // Fallback to isolated dev store, else system store
  const isolated = resolveIsolatedStore(repoRoot);
  return existsSync(isolated) ? isolated : getPnpmStorePath();
}

function run(cmd, args, env) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', env, shell: true });
  if (res.status !== 0) process.exit(res.status || 1);
}

function main() {
  const repoRoot = getRepoRoot();
  const pnpmStorePath = determineStoreEnv(repoRoot);
  const env = { ...process.env, PNPM_STORE_PATH: pnpmStorePath, npm_config_store_dir: pnpmStorePath };

  // 1) Rebuild native deps in a store-aligned environment
  run('npm', ['run', 'test:rebuild'], env);

  // 2) Run vitest with coverage using the same environment
  run('vitest', ['run', '--coverage'], env);
}

main();
