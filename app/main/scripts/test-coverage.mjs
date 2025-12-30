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
  // Try to read storeDir from .modules.yaml, if present (package or root)
  try {
    const candidates = [
      resolve(packageRoot, 'node_modules', '.modules.yaml'),
      resolve(repoRoot, 'node_modules', '.modules.yaml'),
    ];
    for (const file of candidates) {
      if (!existsSync(file)) continue;
      const raw = readFileSync(file, 'utf8');
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

function runTestGroup(pattern, label, baseEnv) {
  console.log(`\nRunning ${label} tests with coverage...`);
  const env = { ...baseEnv, VITEST_PATTERN: pattern };
  run('vitest', ['run', '--coverage'], env);
}

function main() {
  const repoRoot = getRepoRoot();
  const pnpmStorePath = determineStoreEnv(repoRoot);
  const env = { ...process.env, PNPM_STORE_PATH: pnpmStorePath, npm_config_store_dir: pnpmStorePath };

  // 1) Rebuild native deps in a store-aligned environment
  run('npm', ['run', 'test:rebuild'], env);

  // 2) Run vitest with coverage in groups to avoid heap exhaustion
  // Groups are run sequentially, each in its own process
  runTestGroup('tests/config*.test.ts', 'Config', env);
  runTestGroup('tests/preferences*.test.ts', 'Preferences', env);
  runTestGroup('tests/avatar-*.test.ts', 'Avatar', env);
  runTestGroup('tests/vrm*.test.ts', 'VRMA', env);
  runTestGroup('tests/openai*.test.ts', 'OpenAI', env);
  runTestGroup('tests/memory*.test.ts', 'Memory', env);
  runTestGroup('tests/preload.test.ts', 'Preload', env);
  runTestGroup('tests/main.test.ts', 'Main', env);
  runTestGroup('tests/conversation*.test.ts', 'Conversation', env);
  runTestGroup('tests/wake-word*.test.ts', 'Wake Word', env);
  // NOTE: Porcupine tests are skipped due to heap exhaustion from vi.resetModules()
  // See AGENTS.md for manual execution instructions
  runTestGroup('tests/logger.test.ts', 'Logger', env);
  runTestGroup('tests/crash-guard.test.ts', 'Crash Guard', env);
  runTestGroup('tests/runtime-paths.test.ts', 'Runtime Paths', env);
  runTestGroup('tests/auto-launch*.test.ts', 'Auto Launch', env);
  runTestGroup('tests/app-diagnostics.test.ts', 'App Diagnostics', env);
  runTestGroup('tests/metrics/*.test.ts', 'Metrics', env);
  runTestGroup('tests/run-dev-*.test.ts', 'Run Dev', env);

  console.log('\n✅ All coverage groups completed!');
}

main();
