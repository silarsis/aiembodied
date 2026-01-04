import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, parse } from 'node:path';
import { pathToFileURL } from 'node:url';
import { homedir } from 'node:os';

function getPnpmExecutable() {
  try {
    const check = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['pnpm'], { stdio: 'ignore' });
    if (check.status === 0) return 'pnpm';
  } catch { }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    const candidate = join(localAppData, 'pnpm', 'pnpm.exe');
    if (existsSync(candidate)) return candidate;
  }
  return 'pnpm';
}

const pnpmExe = getPnpmExecutable();


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
  const result = spawnSync(pnpmExe, ['store', 'path'], {
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

function hashFile(filePath) {
  if (!existsSync(filePath)) return null;
  const stat = statSync(filePath);
  if (stat.isDirectory()) {
    return hashDirectory(filePath);
  }
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function hashDirectory(dirPath) {
  const hash = createHash('sha256');

  function hashDirRecursive(currentPath) {
    const entries = readdirSync(currentPath).sort();
    for (const entry of entries) {
      // Skip node_modules and build artifacts
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) {
        continue;
      }
      const fullPath = join(currentPath, entry);
      const stat = statSync(fullPath);
      hash.update(entry);
      if (stat.isDirectory()) {
        hashDirRecursive(fullPath);
      } else {
        hash.update(readFileSync(fullPath));
      }
    }
  }

  hashDirRecursive(dirPath);
  return hash.digest('hex');
}

function readStamp(stampPath) {
  if (!existsSync(stampPath)) return null;
  try {
    return JSON.parse(readFileSync(stampPath, 'utf8'));
  } catch {
    return null;
  }
}

function writeStamp(stampPath, data) {
  writeFileSync(stampPath, JSON.stringify(data, null, 2));
}

function stampMatches(oldStamp, newStamp) {
  if (!oldStamp) return false;
  return JSON.stringify(oldStamp) === JSON.stringify(newStamp);
}

function findPnpmModulePath(repoRoot, packageName) {
  const pnpmDir = resolve(repoRoot, 'node_modules', '.pnpm');

  if (existsSync(pnpmDir)) {
    try {
      const entries = readdirSync(pnpmDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(`${packageName}@`)) {
          const modulePath = resolve(pnpmDir, entry.name, 'node_modules', packageName);
          if (existsSync(modulePath)) {
            return modulePath;
          }
        }
      }
    } catch {
      // Ignore read errors
    }
  }

  // Fallback to app/main/node_modules
  const fallback = resolve(repoRoot, 'app', 'main', 'node_modules', packageName);
  if (existsSync(fallback)) {
    return fallback;
  }

  return null;
}

export async function rebuildNativeDependenciesForElectron(
  repoRoot,
  { runImpl = run, baseEnv = process.env, platform = process.platform, arch = process.arch, pnpmStorePath } = {},
) {
  const electronVersion = readElectronVersion(repoRoot);

  // For native rebuilds, use the original environment (not the isolated .dev-home)
  // to ensure Python, VS Build Tools, and other native build dependencies are found
  const rebuildEnv = { ...baseEnv };
  if (platform === 'win32') {
    rebuildEnv.GYP_MSVS_VERSION = rebuildEnv.GYP_MSVS_VERSION || '2022';
    rebuildEnv.npm_config_msvs_version = rebuildEnv.npm_config_msvs_version || '2022';
  }

  // Native modules to rebuild for Electron
  const nativeModules = ['better-sqlite3', 'keytar', '@picovoice/porcupine-node', '@picovoice/pvrecorder-node'];

  for (const moduleName of nativeModules) {
    const modulePath = findPnpmModulePath(repoRoot, moduleName);
    if (!modulePath) {
      console.warn(`[warn] Could not find ${moduleName} in node_modules, skipping rebuild.`);
      continue;
    }

    console.log(`[info] Rebuilding ${moduleName} at ${modulePath} for Electron ${electronVersion} (${arch})...`);

    try {
      // Use node-gyp directly with Electron headers - this bypasses the buggy
      // @electron/rebuild which incorrectly tries to stat platform-specific
      // optional dependencies that don't exist (e.g., @esbuild/aix-ppc64 on Windows)
      await runImpl(
        'npx',
        [
          'node-gyp',
          'rebuild',
          `--target=${electronVersion}`,
          `--arch=${arch}`,
          '--dist-url=https://electronjs.org/headers',
          '--runtime=electron',
          '--yes',
        ],
        { cwd: modulePath, env: rebuildEnv },
      );
      console.log(`[info] Successfully rebuilt ${moduleName} for Electron ${electronVersion}.`);
    } catch (err) {
      console.warn(`[warn] Failed to rebuild ${moduleName}: ${err.message}`);
    }
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
  await run(pnpmExe, ['-v']).catch((e) => {
    console.error('pnpm is required. Run the setup script first.');
    throw e;
  });

  // Force pnpm store to live inside the isolated dev HOME to avoid mismatches
  const devHome = resolve(repoRoot, '.dev-home');
  const isolatedStore = resolve(devHome, 'AppData', 'Local', 'pnpm', 'store', 'v3');
  try {
    mkdirSync(isolatedStore, { recursive: true });
  } catch { }
  const pnpmStorePath = isolatedStore;
  console.log(`[info] Isolated pnpm store set to ${pnpmStorePath}`);

  // Prepare an isolated environment for all pnpm operations
  const envIsolated = prepareDevHomeEnv(repoRoot, process.env, process.platform, { pnpmStorePath });

  // Clean up stale Electron process if it exists
  const pidFile = resolve(repoRoot, '.electron-app.pid');
  if (existsSync(pidFile)) {
    try {
      const pid = parseInt(readFileSync(pidFile, 'utf8').trim(), 10);
      if (!isNaN(pid)) {
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
        } else {
          process.kill(pid, 'SIGTERM');
        }
        console.log(`[info] Cleaned up stale process (PID ${pid}).`);
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  // Check if dependencies or source have changed using a stamp file
  const stampPath = resolve(devHome, 'dev-deps-stamp.json');
  const lockHash = hashFile(resolve(repoRoot, 'pnpm-lock.yaml'));
  const mainSourceHash = hashFile(resolve(repoRoot, 'app/main/src'));
  const rendererSourceHash = hashFile(resolve(repoRoot, 'app/renderer/src'));
  const forceRebuild = process.argv.includes('--force-deps');

  // Read Electron version if available (may not exist on first run)
  let electronVersion = null;
  try {
    electronVersion = readElectronVersion(repoRoot);
  } catch {
    // Electron not installed yet - will need full install
  }

  const newStamp = {
    lockHash,
    mainSourceHash,
    rendererSourceHash,
    electronVersion,
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.version,
  };

  const oldStamp = readStamp(stampPath);
  const depsChanged = forceRebuild || !stampMatches(oldStamp, newStamp);

  if (depsChanged) {
    if (forceRebuild) {
      console.log('[info] --force-deps specified, running full install/build/rebuild...');
    } else if (!oldStamp) {
      console.log('[info] No stamp file found, running full install/build/rebuild...');
    } else {
      console.log('[info] Dependencies changed, running install/build/rebuild...');
      if (oldStamp.lockHash !== newStamp.lockHash) console.log('  - pnpm-lock.yaml changed');
      if (oldStamp.electronVersion !== newStamp.electronVersion) console.log('  - Electron version changed');
      if (oldStamp.nodeVersion !== newStamp.nodeVersion) console.log('  - Node version changed');
    }

    // Install both workspaces in a single pnpm command to avoid Windows race conditions
    // (parallel pnpm processes can race on .pnpm directory creation causing ENOENT errors)
    console.log('[info] Installing workspace dependencies...');
    await run(pnpmExe, ['--filter', '@aiembodied/main', '--filter', '@aiembodied/renderer', 'install'], { env: { ...envIsolated, CI: '1' } });

    // Build renderer and main in parallel
    console.log('[info] Building renderer and main process...');
    await Promise.all([
      run(pnpmExe, ['--filter', '@aiembodied/renderer', 'build'], { env: envIsolated }),
      run(pnpmExe, ['--filter', '@aiembodied/main', 'build'], { env: envIsolated }),
    ]);

    // Rebuild native deps for Electron runtime (ensures better-sqlite3/keytar ABI matches Electron)
    console.log('[info] Rebuilding native dependencies for Electron...');
    try {
      await rebuildNativeDependenciesForElectron(repoRoot, { pnpmStorePath });
    } catch (error) {
      console.warn('[warn] Native dependency rebuild failed, continuing anyway:', error.message);
    }

    // Update stamp after successful install/build/rebuild
    const finalElectronVersion = readElectronVersion(repoRoot);
    writeStamp(stampPath, { ...newStamp, electronVersion: finalElectronVersion });
    console.log('[info] Stamp file updated.');
  } else {
    console.log('[info] Dependencies unchanged, skipping install/build/rebuild (use --force-deps to override)');
  }

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

