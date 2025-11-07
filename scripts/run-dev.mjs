import { spawn, spawnSync } from 'node:child_process';
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

export function resolvePnpmStorePath(env = process.env) {
  const result = spawnSync('pnpm', ['store', 'path'], {
    env,
    encoding: 'utf8',
  });

  if (result.error) {
    throw result.error;
  }

  if (result.status !== 0) {
    const stderr = result.stderr?.trim();
    throw new Error(`Failed to determine pnpm store path${stderr ? `: ${stderr}` : ''}`);
  }

  const combinedOutput = `${result.stdout ?? ''}${result.stderr ?? ''}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const storePath = combinedOutput.at(-1);
  if (!storePath) {
    throw new Error('pnpm store path command did not return a path.');
  }

  return storePath;
}

export function prepareDevHomeEnv(
  repoRoot,
  baseEnv = process.env,
  platform = process.platform,
  { pnpmStorePath } = {},
) {
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

  if (pnpmStorePath) {
    envIsolated.PNPM_STORE_PATH = pnpmStorePath;
    envIsolated.npm_config_store_dir = pnpmStorePath;
  }

  return envIsolated;
}

export function resolveElectronCli(repoRoot) {
  const candidates = [
    resolve(repoRoot, 'app/main/node_modules/electron/cli.js'),
    resolve(repoRoot, 'node_modules/electron/cli.js'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error(
    'Electron CLI not found. Run "pnpm install" to ensure @aiembodied/main dependencies are installed before launching.',
  );
}

export function readElectronVersion(repoRoot) {
  const electronPackagePath = resolve(repoRoot, 'app/main/node_modules/electron/package.json');
  if (!existsSync(electronPackagePath)) {
    throw new Error(
      `Electron package.json not found at ${electronPackagePath}. Run "pnpm install" for @aiembodied/main before launching dev mode.`,
    );
  }

  let electronPkg;
  try {
    electronPkg = JSON.parse(readFileSync(electronPackagePath, 'utf8'));
  } catch (error) {
    throw new Error(`Failed to parse Electron package.json at ${electronPackagePath}: ${error.message}`);
  }

  if (!electronPkg?.version) {
    throw new Error(`Electron package.json at ${electronPackagePath} is missing a version field.`);
  }

  return electronPkg.version;
}

export async function rebuildNativeDependenciesForElectron(
  repoRoot,
  { runImpl = run, baseEnv = process.env, platform = process.platform, pnpmStorePath } = {},
) {
  const envIsolated = prepareDevHomeEnv(repoRoot, baseEnv, platform, { pnpmStorePath });
  const envNoPrebuilds = { ...envIsolated, PREBUILD_INSTALL_FORBID: '1' };
  const envAllowPrebuilds = { ...envIsolated };
  if (platform === 'win32') {
    envNoPrebuilds.GYP_MSVS_VERSION = envNoPrebuilds.GYP_MSVS_VERSION || '2022';
    envNoPrebuilds.npm_config_msvs_version = envNoPrebuilds.npm_config_msvs_version || '2022';
    envAllowPrebuilds.GYP_MSVS_VERSION = envAllowPrebuilds.GYP_MSVS_VERSION || '2022';
    envAllowPrebuilds.npm_config_msvs_version = envAllowPrebuilds.npm_config_msvs_version || '2022';
  }

  let installAppDepsSucceeded = false;
  try {
    await runImpl('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron-builder', 'install-app-deps'], {
      env: envNoPrebuilds,
    });
    installAppDepsSucceeded = true;
  } catch (err) {
    console.warn('[warn] install-app-deps with source build failed, retrying with prebuilt binaries allowed...');
    await runImpl('pnpm', ['--filter', '@aiembodied/main', 'exec', 'electron-builder', 'install-app-deps'], {
      env: envAllowPrebuilds,
    });
    installAppDepsSucceeded = true;
  }

  // Optional targeted rebuild. If it fails, continue — install-app-deps already handled deps.
  try {
    const electronVersion = readElectronVersion(repoRoot);
    const rebuildEnv = {
      ...envAllowPrebuilds,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion,
      npm_config_disturl: 'https://electronjs.org/headers',
    };
    await runImpl('pnpm', ['--filter', '@aiembodied/main', 'rebuild', 'better-sqlite3', 'keytar'], {
      env: rebuildEnv,
    });
  } catch (err) {
    console.warn('[warn] pnpm rebuild of native deps failed, continuing since install-app-deps succeeded:', err.message);
  }
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

  // Build renderer and main
  console.log('[info] Aligning workspace deps to isolated store...');
  await run('pnpm', ['--filter', '@aiembodied/main', 'install', '--force'], { env: { ...envIsolated, CI: '1' } });
  await run('pnpm', ['--filter', '@aiembodied/renderer', 'install', '--force'], { env: { ...envIsolated, CI: '1' } });

  console.log('[info] Building renderer...');
  await run('pnpm', ['--filter', '@aiembodied/renderer', 'build'], { env: envIsolated });
  
  console.log('[info] Building main process...');
  await run('pnpm', ['--filter', '@aiembodied/main', 'build'], { env: envIsolated });

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
    await rebuildNativeDependenciesForElectron(repoRoot, { pnpmStorePath });
  } catch (error) {
    console.warn('[warn] Native dependency rebuild failed, continuing anyway:', error.message);
  }

  // Launch Electron with compiled main
  console.log('[info] Launching Electron...');
  const env = { ...envIsolated, AIEMBODIED_ENABLE_DIAGNOSTICS: '1' };
  const electronCli = resolveElectronCli(repoRoot);
  const electronEntrypoint = resolve(repoRoot, 'app/main/dist/main.js');
  await run(process.execPath, [electronCli, electronEntrypoint], {
    env,
    shell: false,
  });
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

