#!/usr/bin/env node
/**
 * Run tests with coverage using Electron as the runtime.
 * This ensures native modules built for Electron work correctly.
 */
import { spawnSync, execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../../..');
const mainRoot = resolve(__dirname, '..');

// Find the actual Electron executable (same logic as test-electron.mjs)
function findElectronExe() {
  // First, try reading electron/path.txt which contains the platform-specific path
  const pathTxt = resolve(mainRoot, 'node_modules/electron/path.txt');
  if (existsSync(pathTxt)) {
    const relativePath = readFileSync(pathTxt, 'utf8').trim();
    const fullPath = resolve(mainRoot, 'node_modules/electron', relativePath);
    if (existsSync(fullPath)) {
      return fullPath;
    }
  }

  // Fallback: try platform-specific default locations
  const platform = process.platform;
  let candidates = [];

  if (platform === 'win32') {
    candidates = [
      resolve(mainRoot, 'node_modules/electron/dist/electron.exe'),
    ];
  } else if (platform === 'darwin') {
    candidates = [
      resolve(mainRoot, 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),
    ];
  } else {
    // Linux
    candidates = [
      resolve(mainRoot, 'node_modules/electron/dist/electron'),
    ];
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  return null;
}

// Find vitest entry point
function findVitestEntry() {
  const vitestBin = resolve(repoRoot, 'node_modules/vitest/vitest.mjs');
  if (existsSync(vitestBin)) {
    return vitestBin;
  }

  // Try to find it via pnpm
  try {
    const result = execSync('pnpm exec which vitest', {
      cwd: mainRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    }).trim();
    // The result is a Unix-style path, convert to Windows if needed
    return result.replace(/^\/([a-z])\//, '$1:/').replace(/\//g, '\\');
  } catch {
    return null;
  }
}

function runTestGroup(pattern, label, electronExe, vitestEntry) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`Running ${label} tests with coverage...`);
  console.log(`${'='.repeat(70)}\n`);

  const env = {
    ...process.env,
    VITEST_PATTERN: pattern,
    ELECTRON_RUN_AS_NODE: '1',
  };

  // Run vitest with coverage using Electron
  const result = spawnSync(electronExe, [vitestEntry, 'run', '--coverage'], {
    stdio: 'inherit',
    env,
    cwd: mainRoot,
  });

  if (result.status !== 0) {
    console.error(`\n❌ ${label} tests failed`);
    process.exit(result.status || 1);
  }

  console.log(`✓ ${label} tests passed\n`);
}

function main() {
  const electronExe = findElectronExe();
  if (!electronExe) {
    console.error('Electron executable not found.');
    console.error('Run "pnpm install" in app/main first.');
    process.exit(1);
  }

  const vitestEntry = findVitestEntry();
  if (!vitestEntry) {
    console.error('Could not find vitest.');
    process.exit(1);
  }

  console.log('[test-coverage] Electron executable:', electronExe);
  console.log('[test-coverage] Vitest entry:', vitestEntry);
  console.log('[test-coverage] Running with ELECTRON_RUN_AS_NODE=1\n');

  // Run vitest with coverage in groups to avoid heap exhaustion
  // Groups are run sequentially, each in its own process
  runTestGroup('tests/config*.test.ts', 'Config', electronExe, vitestEntry);
  runTestGroup('tests/preferences*.test.ts', 'Preferences', electronExe, vitestEntry);
  runTestGroup('tests/avatar-*.test.ts', 'Avatar', electronExe, vitestEntry);
  runTestGroup('tests/vrm*.test.ts', 'VRMA', electronExe, vitestEntry);
  runTestGroup('tests/openai*.test.ts', 'OpenAI', electronExe, vitestEntry);
  runTestGroup('tests/memory*.test.ts', 'Memory', electronExe, vitestEntry);
  runTestGroup('tests/preload.test.ts', 'Preload', electronExe, vitestEntry);
  runTestGroup('tests/main.test.ts', 'Main', electronExe, vitestEntry);
  runTestGroup('tests/conversation*.test.ts', 'Conversation', electronExe, vitestEntry);
  runTestGroup('tests/wake-word*.test.ts', 'Wake Word', electronExe, vitestEntry);
  // NOTE: Porcupine tests are skipped due to heap exhaustion from vi.resetModules()
  // See AGENTS.md for manual execution instructions
  runTestGroup('tests/logger.test.ts', 'Logger', electronExe, vitestEntry);
  runTestGroup('tests/crash-guard.test.ts', 'Crash Guard', electronExe, vitestEntry);
  runTestGroup('tests/runtime-paths.test.ts', 'Runtime Paths', electronExe, vitestEntry);
  runTestGroup('tests/auto-launch*.test.ts', 'Auto Launch', electronExe, vitestEntry);
  runTestGroup('tests/app-diagnostics.test.ts', 'App Diagnostics', electronExe, vitestEntry);
  runTestGroup('tests/metrics/*.test.ts', 'Metrics', electronExe, vitestEntry);
  runTestGroup('tests/run-dev-*.test.ts', 'Run Dev', electronExe, vitestEntry);

  console.log('\n' + '='.repeat(70));
  console.log('✅ All coverage groups completed!');
  console.log('='.repeat(70) + '\n');
}

main();
