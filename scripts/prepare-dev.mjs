import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { prepareDevHomeEnv, rebuildNativeDependenciesForElectron } from './run-dev.mjs';

function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: true, ...options });
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

function parseDotEnv(envPath) {
  const envVars = {};
  if (!existsSync(envPath)) return envVars;

  const content = readFileSync(envPath, 'utf8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || !trimmed) continue;
    const [key, ...valueParts] = trimmed.split('=');
    if (key && valueParts.length > 0) {
      const value = valueParts.join('=').replace(/^["']|["']$/g, '').trim();
      envVars[key.trim()] = value;
    }
  }
  return envVars;
}

async function main() {
  const repoRoot = resolve(process.cwd());
  const envPath = resolve(repoRoot, '.env');
  if (!existsSync(envPath)) {
    console.warn('[warn] .env not found at repo root. Dev run expects REALTIME_API_KEY and PORCUPINE_ACCESS_KEY.');
  }

  // Parse environment variables
  const envFromFile = parseDotEnv(envPath);
  const hasRealtimeKey = process.env.REALTIME_API_KEY || envFromFile.REALTIME_API_KEY;
  const hasPorcupineKey = process.env.PORCUPINE_ACCESS_KEY || envFromFile.PORCUPINE_ACCESS_KEY;

  if (!hasPorcupineKey) {
    console.error('Missing PORCUPINE_ACCESS_KEY. Add it to .env or export it in the environment.');
    console.error('Example .env entries:');
    console.error('  PORCUPINE_ACCESS_KEY=your_porcupine_key_here');
    console.error('  REALTIME_API_KEY=your_openai_key_here');
    process.exit(1);
  }

  if (!hasRealtimeKey) {
    console.warn('[warn] REALTIME_API_KEY not found. Some features may not work properly.');
  }

  // Verify pnpm is available
  await run('pnpm', ['-v']).catch((e) => {
    console.error('pnpm is required. Run the setup script first.');
    throw e;
  });

  // Force pnpm store to live inside the isolated dev HOME to avoid mismatches
  const devHome = resolve(repoRoot, '.dev-home');
  const isolatedStore = resolve(devHome, 'AppData', 'Local', 'pnpm', 'store', 'v3');
  try {
    mkdirSync(isolatedStore, { recursive: true });
  } catch {}
  const pnpmStorePath = isolatedStore;
  console.log(`[info] Isolated pnpm store set to ${pnpmStorePath}`);

  // Prepare an isolated environment for all pnpm operations
  const envIsolated = prepareDevHomeEnv(repoRoot, process.env, process.platform, { pnpmStorePath });

  // Align workspace deps & build packages (same as run-dev, but stop before launch)
  console.log('[info] Aligning workspace deps to isolated store...');
  await run('pnpm', ['--filter', '@aiembodied/main', 'install', '--force'], { env: { ...envIsolated, CI: '1' } });
  await run('pnpm', ['--filter', '@aiembodied/renderer', 'install', '--force'], { env: { ...envIsolated, CI: '1' } });

  console.log('[info] Building renderer...');
  await run('pnpm', ['--filter', '@aiembodied/renderer', 'build'], { env: envIsolated });

  console.log('[info] Building main process...');
  await run('pnpm', ['--filter', '@aiembodied/main', 'build'], { env: envIsolated });

  // Verify artifacts
  const preloadPath = resolve(repoRoot, 'app/main/dist/preload.js');
  if (!existsSync(preloadPath)) {
    throw new Error(`Preload script not found at ${preloadPath}. Ensure main process build completed successfully.`);
  }
  console.log('[info] Preload script verified at:', preloadPath);

  const rendererIndexPath = resolve(repoRoot, 'app/renderer/dist/index.html');
  if (!existsSync(rendererIndexPath)) {
    throw new Error(`Renderer build not found at ${rendererIndexPath}. Ensure renderer build completed successfully.`);
  }
  console.log('[info] Renderer build verified at:', rendererIndexPath);

  console.log('[info] Rebuilding native dependencies for Electron...');
  await rebuildNativeDependenciesForElectron(repoRoot, { pnpmStorePath });

  console.log('[success] Dev build prepared. Electron launch skipped.');
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
