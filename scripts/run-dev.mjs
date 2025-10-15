#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';

function run(cmd, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { stdio: 'inherit', shell: false, ...options });
    child.on('exit', (code) => {
      if (code === 0) return resolvePromise();
      reject(new Error(`${cmd} ${args.join(' ')} exited with code ${code}`));
    });
    child.on('error', reject);
  });
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

  // Build a true CommonJS preload to avoid dynamic import issues
  try {
    await run('node', [join('scripts', 'build-preload-cjs.mjs')]);
  } catch (err) {
    console.warn('[warn] Failed to build CJS preload via tsc; falling back to shim:', err?.message || String(err));
    // Fallback: write a dynamic-import shim if CJS build fails
    const distDir = resolve(repoRoot, 'app/main/dist');
    const cjsShimPath = join(distDir, 'preload.cjs');
    const shim = `// Auto-generated CommonJS shim to load the ESM preload build
const { pathToFileURL } = require('url');
const path = require('path');
let ipcRenderer; try { ({ ipcRenderer } = require('electron')); } catch {}
const forward = (level, message, meta) => { try { if (ipcRenderer) ipcRenderer.send('diagnostics:preload-log', { level, message, meta, ts: Date.now() }); } catch {} };
console.info('[preload shim] Starting preload shim');
forward('info', 'preload-shim:starting');
(async () => { try { const href = pathToFileURL(path.join(__dirname, 'preload.js')).href; forward('info', 'preload-shim:importing', { href }); await import(href); forward('info', 'preload-shim:imported'); } catch (e) { forward('error', 'preload-shim:import-failed', { message: e && (e.message || e) }); throw e; } })();
`;
    writeFileSync(cjsShimPath, shim, { encoding: 'utf8' });
    console.log('[info] Wrote CommonJS preload shim at:', cjsShimPath);
  }

  // Verify renderer dist exists
  const rendererIndexPath = resolve(repoRoot, 'app/renderer/dist/index.html');
  if (!existsSync(rendererIndexPath)) {
    throw new Error(`Renderer build not found at ${rendererIndexPath}. Ensure renderer build completed successfully.`);
  }
  console.log('[info] Renderer build verified at:', rendererIndexPath);

  // Rebuild native deps for Electron runtime (ensures better-sqlite3/keytar ABI matches Electron)
  console.log('[info] Rebuilding native dependencies for Electron...');
  // Isolate HOME/APPDATA to avoid EPERM scandir on Windows junctions like "Application Data"
  const envIsolated = prepareDevHomeEnv(repoRoot);
  await run('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron-builder', 'install-app-deps'], { env: envIsolated });

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

