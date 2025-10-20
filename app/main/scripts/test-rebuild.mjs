#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

function getRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url));
  // this file lives at repo/app/main/scripts/test-rebuild.mjs → repoRoot = here/../../..
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

function main() {
  const repoRoot = getRepoRoot();
  const packageRoot = resolve(repoRoot, 'app', 'main');

  // Determine which store node_modules expects, if present
  let pnpmStorePath;
  try {
    const modulesYaml = resolve(packageRoot, 'node_modules', '.modules.yaml');
    if (existsSync(modulesYaml)) {
      const raw = readFileSync(modulesYaml, 'utf8');
      const m = raw.match(/\n\s*storeDir:\s*(.+)\s*\n/);
      if (m && m[1]) {
        pnpmStorePath = m[1].trim();
      }
    }
  } catch {}

  // Fallbacks: prefer the dev isolated store if available, else system store
  if (!pnpmStorePath) {
    const isolated = resolveIsolatedStore(repoRoot);
    pnpmStorePath = existsSync(isolated) ? isolated : getPnpmStorePath();
  }

  const env = { ...process.env };
  env.PNPM_STORE_PATH = pnpmStorePath;
  env.npm_config_store_dir = pnpmStorePath;
  env.PREBUILD_INSTALL_FORBID = '1';

  // Align runtime target with current Node for native rebuilds used by tests
  const nodeVer = process.version.slice(1);
  env.npm_config_runtime = 'node';
  env.npm_config_target = nodeVer;

  const result = spawnSync('pnpm', ['--filter', '@aiembodied/main', 'rebuild', 'better-sqlite3'], { stdio: 'inherit', env });
  if (result.status !== 0) {
    process.exit(result.status || 1);
  }
}

main();
