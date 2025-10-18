#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

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

export function prepareDevHomeEnv(repoRoot, baseEnv = process.env, platform = process.platform) {
  const devHome = resolve(repoRoot, '.dev-home');
  const roamingAppData = join(devHome, 'AppData', 'Roaming');
  const localAppData = join(devHome, 'AppData', 'Local');
  const npmCache = join(devHome, '.npm-cache');
  const electronBuilderCache = join(devHome, 'electron-builder-cache');

  for (const dir of [devHome, roamingAppData, localAppData, npmCache, electronBuilderCache]) {
    mkdirSync(dir, { recursive: true });
  }

  const envIsolated = {
    ...baseEnv,
    HOME: devHome,
    USERPROFILE: devHome,
    APPDATA: roamingAppData,
    LOCALAPPDATA: localAppData,
    npm_config_cache: npmCache,
    ELECTRON_BUILDER_CACHE: electronBuilderCache,
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
  };

  if (platform === 'win32') {
    const { root } = parse(devHome);
    if (root && root !== '/') {
      envIsolated.HOMEDRIVE = root.replace(/\\$/, '');
      envIsolated.HOMEPATH = devHome.slice(root.length) || '\\';
    } else {
      envIsolated.HOMEDRIVE = devHome;
      envIsolated.HOMEPATH = devHome;
    }
  }

  return envIsolated;
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

  // Build renderer and main
  console.log('[info] Building renderer...');
  await run('pnpm', ['--filter', '@aiembodied/renderer', 'build']);
  
  console.log('[info] Building main process...');
  await run('pnpm', ['--filter', '@aiembodied/main', 'build']);

  // Verify preload script exists
  const preloadPath = resolve(repoRoot, 'app/main/dist/preload.js');
  if (!existsSync(preloadPath)) {
    throw new Error(`Preload script not found at ${preloadPath}. Ensure main process build completed successfully.`);
  }
  console.log('[info] Preload script verified at:', preloadPath);

  // Verify renderer dist exists
  const rendererIndexPath = resolve(repoRoot, 'app/renderer/dist/index.html');
  if (!existsSync(rendererIndexPath)) {
    throw new Error(`Renderer build not found at ${rendererIndexPath}. Ensure renderer build completed successfully.`);
  }
  console.log('[info] Renderer build verified at:', rendererIndexPath);

  // Rebuild native deps for Electron runtime (ensures better-sqlite3/keytar ABI matches Electron)
  console.log('[info] Rebuilding native dependencies for Electron...');
  try {
    // Isolate HOME/APPDATA to avoid EPERM scandir on Windows junctions like "Application Data"
    const envIsolated = prepareDevHomeEnv(repoRoot);
    // Force source compilation for better-sqlite3 to avoid Node version mismatch issues
    envIsolated.PREBUILD_INSTALL_FORBID = '1';
    await run('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron-builder', 'install-app-deps'], { env: envIsolated });
  } catch (error) {
    console.warn('[warn] Native dependency rebuild failed, continuing anyway:', error.message);
  }

  // Launch Electron with compiled main
  console.log('[info] Launching Electron...');
  const env = { ...process.env, AIEMBODIED_ENABLE_DIAGNOSTICS: '1' };
  await run('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron', 'dist/main.js'], { env });
}

const invokedDirectly = Boolean(
  process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url,
);

if (invokedDirectly) {
  main().catch((err) => {
    console.error(err?.stack || String(err));
    process.exit(1);
  });
}

