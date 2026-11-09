/**
 * Make sure the local model servers the app talks to are running before the dev app starts:
 * the LLM (llama-server, Qwen Flash-Next), speech-to-text (llama-server, Qwen3-ASR), the speech
 * service (Kokoro TTS), the motion service (ARDY), the memory engine (with PostgreSQL in a container), the coding
 * runner (services/coder) and, when web search uses it, SearXNG (a container). The coder's own
 * llama-server (Qwen3-Coder-Next) is not started here: the app starts it when a coding task needs it. A server that already
 * answers is left alone, so one slopcore or another terminal started is reused. A missing one is started with
 * its own start script in a hidden console of its own, logging to .dev-home/logs/<id>.log
 * (and <id>.err.log), and keeps running after the app and the terminal close. Nothing waits for models to finish loading: the app polls each service and
 * picks it up once it reports ready.
 *
 * Settings come from the environment or .env: the same URLs the app uses (LOCAL_LLM_BASE_URL,
 * STT_URL, SPEECH_SERVICE_URL, MOTION_SERVICE_URL, MEMORY_SERVICE_URL, SEARXNG_URL, CODING_RUNNER_URL) plus the paths the start scripts need
 * (KOKORO_DIR, MOTION_VENV, TEXT_ENCODERS_DIR, LOCAL_LLM_CONTEXT, ...). What the user saved on the
 * app's Settings page wins over the environment, as it does in the app: a part switched to OpenAI
 * needs no local server, and the motion model picked there is the one services/motion starts with.
 * Skip it all with --no-services or DEV_START_SERVICES=0.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isOn(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

/**
 * Where the dev app (run by run-dev.mjs with HOME in .dev-home) keeps its preferences.json. On
 * bija Electron names the userData folder "Electron"; the package name is the fallback.
 */
export function savedPreferencesPaths(repoRoot) {
  const roaming = join(repoRoot, '.dev-home', 'AppData', 'Roaming');
  return [join(roaming, 'Electron', 'preferences.json'), join(roaming, '@aiembodied', 'main', 'preferences.json')];
}

/** The app's saved preferences ({} when there are none yet or the file is unreadable). */
export function readSavedPreferences(repoRoot) {
  for (const file of savedPreferencesPaths(repoRoot)) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {
      // Missing or unreadable; try the next one.
    }
  }
  return {};
}

/**
 * The thinking model picked in the app (Models and servers → Thinking → Download a thinking model),
 * from local-llm.json beside preferences.json, or null for the start script's default.
 */
export function readSelectedLocalLlm(repoRoot, exists = existsSync) {
  for (const preferences of savedPreferencesPaths(repoRoot)) {
    try {
      const library = JSON.parse(readFileSync(join(dirname(preferences), 'local-llm.json'), 'utf8'));
      const model = Array.isArray(library?.models) ? library.models.find((entry) => entry?.id === library.selected) : undefined;
      if (model && typeof model.path === 'string' && typeof model.alias === 'string' && exists(model.path)) {
        return { path: model.path, alias: model.alias, ...(Number(model.contextLength) > 0 ? { contextLength: Number(model.contextLength) } : {}) };
      }
    } catch {
      // Missing or unreadable; try the next one.
    }
  }
  return null;
}

function lower(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : undefined;
}

/** The services to ensure, with how to tell each is up and how to start it. */
export function describeLocalServices(repoRoot, env, saved = readSavedPreferences(repoRoot), localLlm = readSelectedLocalLlm(repoRoot)) {
  const providers = saved.providers ?? {};
  const pipeline = (lower(saved.conversationBackend) ?? lower(env.CONVERSATION_BACKEND) ?? 'local') !== 'openai';
  const llmLocal = (lower(providers.llm?.provider) ?? lower(env.LLM_PROVIDER) ?? 'local') !== 'openai';
  const sttLocal = (lower(providers.stt?.provider) ?? lower(env.STT_PROVIDER) ?? 'local') !== 'openai';
  const ttsLocal = (lower(providers.tts?.provider) ?? lower(env.TTS_PROVIDER) ?? 'kokoro') !== 'openai';
  const motionLocal = (lower(providers.motion?.provider) ?? lower(env.MOTION_PROVIDER) ?? 'local') !== 'openai';
  const sttServer = (env.STT_ENGINE ?? 'server').trim().toLowerCase() === 'server';
  const searchProviders = (env.WEB_SEARCH_PROVIDER?.trim() || 'searxng').split(',').map((name) => name.trim().toLowerCase());

  // Models and servers (saved.models) says which server each use runs on; a use it doesn't
  // mention keeps the default the provider settings give. Mirrors app/main/src/config/model-routing.ts.
  const routes = saved.models?.routes ?? {};
  const defaults = {
    llm: [llmLocal ? 'local-llm' : 'openai'],
    stt: [sttLocal ? 'local-speech' : 'openai'],
    tts: [ttsLocal ? 'local-speech' : 'openai'],
    motion: [motionLocal ? 'local-motion' : 'openai'],
    search: searchProviders.map((name) => (name === 'searxng' ? 'local-searxng' : name)),
    describe: ['openai'],
    posegen: ['openai'],
    posecheck: ['openai'],
    clips: ['openai'],
    // Idle thoughts follow Thinking until routed elsewhere; with the OpenAI Realtime engine they do not
    // keep this PC's model running by themselves.
    idle: pipeline ? [llmLocal ? 'local-llm' : 'openai'] : [],
  };
  const serversFor = (use) => {
    const route = routes[use];
    if (route && typeof route.server === 'string') {
      return [route.server, ...(Array.isArray(route.backups) ? route.backups.map((backup) => backup?.server) : [])];
    }
    // Idle thoughts follow a saved Thinking route too.
    return use === 'idle' && pipeline && routes.llm ? serversFor('llm') : defaults[use];
  };
  const usedBy = (id, uses) => uses.some((use) => serversFor(use).includes(id));
  const voiceUses = pipeline ? ['llm', 'stt', 'tts'] : [];
  const builtInUrl = (id) => {
    const entry = (saved.models?.servers ?? []).find((server) => server?.id === id);
    return typeof entry?.url === 'string' && entry.url.trim() ? entry.url.trim() : undefined;
  };
  const motionRoute = routes.motion;
  const motionBackend =
    (motionRoute?.server === 'local-motion' ? lower(motionRoute.model) : undefined) ??
    lower(providers.motion?.localBackend) ??
    lower(env.MOTION_BACKEND) ??
    'ardy';
  const llmUrl = trimSlash(builtInUrl('local-llm') || providers.llm?.localBaseUrl || env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:1234/v1');
  const sttUrl = trimSlash(env.STT_URL || 'http://127.0.0.1:1235/v1');
  const speechUrl = trimSlash(builtInUrl('local-speech') || providers.speechServiceUrl || env.SPEECH_SERVICE_URL || 'http://127.0.0.1:8192');
  const motionUrl = trimSlash(builtInUrl('local-motion') || providers.motion?.localServiceUrl || env.MOTION_SERVICE_URL || 'http://127.0.0.1:8190');
  const searxngUrl = trimSlash(builtInUrl('local-searxng') || env.SEARXNG_URL || 'http://127.0.0.1:8888');
  const memoryUrl = trimSlash(env.MEMORY_SERVICE_URL || 'http://127.0.0.1:8194');
  // The coding runner: the built-in server, unless the app points coding at a runner on another machine.
  const coderServer = typeof saved.coding?.runner === 'string' && saved.coding.runner ? saved.coding.runner : 'local-coder-runner';
  const coderUrl = trimSlash(builtInUrl('local-coder-runner') || env.CODING_RUNNER_URL || 'http://127.0.0.1:8195');
  const speechForStt = pipeline && usedBy('local-speech', ['stt']);
  // A model downloaded in the app runs with its own name, and no more context than it was made for.
  const contextCap = Number.parseInt(env.LOCAL_LLM_CONTEXT ?? '', 10) > 0 ? Number.parseInt(env.LOCAL_LLM_CONTEXT, 10) : 65536;
  const llmContext = localLlm?.contextLength ? String(Math.min(localLlm.contextLength, contextCap)) : env.LOCAL_LLM_CONTEXT;

  const services = [
    {
      id: 'llm',
      label: localLlm ? `${localLlm.alias} (llama-server)` : 'Qwen LLM (llama-server)',
      enabled: usedBy('local-llm', [...voiceUses, 'describe', 'posegen', 'posecheck', 'clips', 'idle']),
      url: llmUrl,
      probe: `${llmUrl}/models`,
      script: 'scripts/start-local-llm.ps1',
      args: [
        ...portArgs(llmUrl),
        ...(localLlm ? ['-Model', localLlm.path, '-Alias', localLlm.alias] : []),
        ...(llmContext ? ['-Context', llmContext] : []),
      ],
    },
    {
      id: 'asr',
      label: 'Qwen3-ASR speech-to-text (llama-server)',
      enabled: speechForStt && sttServer,
      url: sttUrl,
      probe: `${sttUrl}/models`,
      script: 'scripts/start-local-asr.ps1',
      args: portArgs(sttUrl),
    },
    {
      id: 'speech',
      label: 'speech service (Kokoro TTS)',
      enabled: pipeline && usedBy('local-speech', ['stt', 'tts']),
      url: speechUrl,
      probe: `${speechUrl}/health`,
      script: 'services/speech/scripts/start.ps1',
      args: [...portArgs(speechUrl), ...(env.KOKORO_DIR ? ['-KokoroDir', env.KOKORO_DIR] : [])],
      missing: env.KOKORO_DIR ? null : 'KOKORO_DIR (folder with kokoro-v1.0.onnx and voices-v1.0.bin)',
    },
    {
      id: 'motion',
      label: `motion service (${motionBackend === 'kimodo' ? 'Kimodo' : 'ARDY'})`,
      enabled: usedBy('local-motion', ['motion']) && isOn(env.DEV_START_MOTION, true),
      url: motionUrl,
      probe: `${motionUrl}/health`,
      script: 'services/motion/scripts/start.ps1',
      // The text encoder (~16.5 GB) runs on the GPU by default. MOTION_TEXT_ENCODER_DEVICE=cpu
      // saves that GPU memory but needs the same in system RAM, which a unified-memory machine
      // with most of its RAM carved out for the GPU (bija: 31.6 GB visible) may not have.
      args: [
        ...portArgs(motionUrl),
        ...(motionBackend === 'kimodo' ? ['-Backend', 'kimodo'] : []),
        ...(env.MOTION_TEXT_ENCODER_DEVICE ? ['-TextEncoderDevice', env.MOTION_TEXT_ENCODER_DEVICE] : []),
        ...(env.TEXT_ENCODERS_DIR ? ['-TextEncodersDir', env.TEXT_ENCODERS_DIR] : []),
        ...(env.MOTION_VENV ? ['-Venv', env.MOTION_VENV] : []),
      ],
    },
    {
      id: 'memory',
      label: 'memory engine (PostgreSQL in a wslc or Docker container)',
      enabled: isOn(env.MEMORY_ENABLED, true) && isOn(env.MEMORY_AUTOSTART, true),
      url: memoryUrl,
      probe: `${memoryUrl}/health`,
      script: 'services/memory/scripts/start.ps1',
      args: portArgs(memoryUrl),
    },
    {
      id: 'searxng',
      label: 'SearXNG web search (wslc or Docker container)',
      enabled: usedBy('local-searxng', ['search']),
      url: searxngUrl,
      probe: `${searxngUrl}/healthz`,
      script: 'services/searxng/scripts/start.ps1',
      args: portArgs(searxngUrl),
    },
    {
      id: 'coder',
      label: 'Coding runner (services/coder)',
      enabled: isOn(env.CODER_ENABLED, true) && isOn(env.CODER_AUTOSTART, true) && coderServer === 'local-coder-runner',
      url: coderUrl,
      probe: `${coderUrl}/v1/health`,
      script: 'services/coder/scripts/start.ps1',
      args: portArgs(coderUrl),
    },
  ];

  return services.map((service) => ({ ...service, script: resolve(repoRoot, service.script) }));
}

function portArgs(url) {
  const port = new URL(url).port;
  return port ? ['-Port', port] : [];
}

function isLocalUrl(url) {
  return LOCAL_HOSTS.has(new URL(url).hostname);
}

/** True when the server answers at all: llama-server returns 503 while a model loads. */
async function responds(probeUrl, fetchFn, timeoutMs) {
  try {
    await fetchFn(probeUrl, { signal: AbortSignal.timeout(timeoutMs) });
    return true;
  } catch {
    return false;
  }
}

function psQuote(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * PowerShell that starts `script` in its own hidden console and writes its process id to
 * `pidPath`.
 * Node's `detached` uses DETACHED_PROCESS, which leaves PowerShell (and a venv's python.exe
 * launcher) with no console at all: they exit or hang without output. Without `detached` the
 * service would share this terminal's console and die when it closes. Start-Process gives it
 * a console of its own, as slopcore does with CREATE_NO_WINDOW.
 */
export function buildStartCommand({ script, args, cwd, logPath, errPath, pidPath }) {
  // Windows PowerShell 5.1 joins -ArgumentList without quoting, so quote each item ourselves.
  const argumentList = ['-NoProfile', '-NonInteractive', '-File', script, ...args]
    .map((arg) => psQuote(`"${arg}"`))
    .join(', ');
  return [
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @(${argumentList})`,
    `-WorkingDirectory ${psQuote(cwd)} -WindowStyle Hidden`,
    `-RedirectStandardOutput ${psQuote(logPath)} -RedirectStandardError ${psQuote(errPath)} -PassThru;`,
    `Set-Content -LiteralPath ${psQuote(pidPath)} -Value $p.Id`,
  ].join(' ');
}

/**
 * Check each service and start the ones that are down. Returns one line per service:
 * running | started | skipped (with the reason).
 */
export async function ensureLocalServices(repoRoot, env, {
  fetchFn = fetch,
  spawnSyncFn = spawnSync,
  platform = process.platform,
  logDir = join(repoRoot, '.dev-home', 'logs'),
  probeTimeoutMs = 1500,
  log = console,
} = {}) {
  const results = [];
  for (const service of describeLocalServices(repoRoot, env)) {
    if (!service.enabled) {
      results.push({ id: service.id, status: 'skipped', reason: 'not needed with this configuration' });
      continue;
    }
    if (await responds(service.probe, fetchFn, probeTimeoutMs)) {
      results.push({ id: service.id, status: 'running', url: service.url });
      log.info?.(`[info] ${service.label} is already running at ${service.url}`);
      continue;
    }
    if (!isLocalUrl(service.url)) {
      results.push({ id: service.id, status: 'skipped', reason: `${service.url} is not on this machine` });
      log.warn?.(`[warn] ${service.label} is not answering at ${service.url}, which is not on this machine; start it there.`);
      continue;
    }
    if (platform !== 'win32') {
      results.push({ id: service.id, status: 'skipped', reason: 'start scripts are PowerShell (Windows)' });
      log.warn?.(`[warn] ${service.label} is not running; start it with ${service.script}.`);
      continue;
    }
    if (service.missing) {
      results.push({ id: service.id, status: 'skipped', reason: `set ${service.missing}` });
      log.warn?.(`[warn] ${service.label} is not running and cannot be started: set ${service.missing} in .env.`);
      continue;
    }

    mkdirSync(logDir, { recursive: true });
    const logPath = join(logDir, `${service.id}.log`);
    const errPath = join(logDir, `${service.id}.err.log`);
    const pidPath = join(logDir, `${service.id}.pid`);
    rmSync(pidPath, { force: true });
    const command = buildStartCommand({ script: service.script, args: service.args, cwd: repoRoot, logPath, errPath, pidPath });
    // No pipes: the started service inherits the launcher's handles, and an inherited stdout
    // pipe would keep spawnSync waiting for as long as the service runs.
    const launched = spawnSyncFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')],
      { cwd: repoRoot, env, stdio: 'ignore', windowsHide: true, timeout: 30_000 },
    );
    let pid = Number.NaN;
    try {
      pid = Number.parseInt(readFileSync(pidPath, 'utf8').trim(), 10);
    } catch {
      // No pid file: the launch failed.
    }
    if (launched.status !== 0 || !Number.isFinite(pid)) {
      const reason = launched.error?.message ?? `launcher exited with code ${launched.status} (see ${errPath})`;
      results.push({ id: service.id, status: 'failed', reason });
      log.warn?.(`[warn] Could not start ${service.label}: ${reason}`);
      continue;
    }
    results.push({ id: service.id, status: 'started', url: service.url, logPath, pid });
    log.info?.(`[info] Started ${service.label} at ${service.url} (pid ${pid}, log: ${logPath})`);
  }
  return results;
}

export function shouldStartServices(argv, env) {
  return !argv.includes('--no-services') && isOn(env.DEV_START_SERVICES, true);
}

/**
 * Check if a server is running by probing its health endpoint
 */
export async function isServerRunning(service, fetchFn = fetch, timeoutMs = 1000) {
  return await responds(service.probe, fetchFn, timeoutMs);
}

/**
 * Stop a server by port using PowerShell
 * Returns true if the server was running and stopped
 */
export async function stopServerByPort(port, { spawnSyncFn = spawnSync, platform = process.platform, log = console } = {}) {
  if (platform !== 'win32') {
    log.warn(`[warn] Server stop is Windows-only (port ${port})`);
    return false;
  }

  const script = resolve(process.cwd(), 'scripts', 'stop-service.ps1');
  if (!existsSync(script)) {
    log.warn(`[warn] Stop script not found: ${script}`);
    return false;
  }

  try {
    const result = spawnSyncFn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-File', script, '-Port', String(port)],
      { cwd: process.cwd(), stdio: 'pipe', windowsHide: true, timeout: 5000 }
    );

    if (result.status === 0) {
      log.info(`[info] Stopped server on port ${port}`);
      return true;
    } else {
      log.warn(`[warn] Failed to stop server on port ${port}: ${result.stderr?.toString().trim() || 'unknown error'}`);
      return false;
    }
  } catch (error) {
    log.warn(`[warn] Error stopping server on port ${port}: ${error.message}`);
    return false;
  }
}

/**
 * Get the PID of a server listening on a port
 */
export async function getServerPid(port, { platform = process.platform } = {}) {
  if (platform !== 'win32') return null;

  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      'powershell.exe',
      [`-Command "Get-NetTCPConnection -LocalPort ${port} -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess"`],
      { cwd: process.cwd(), stdio: 'pipe', windowsHide: true, timeout: 3000 }
    );

    if (result.status === 0) {
      const pid = parseInt(result.stdout?.toString().trim(), 10);
      return Number.isFinite(pid) ? pid : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the process name for a PID
 */
export async function getProcessName(pid, { platform = process.platform } = {}) {
  if (platform !== 'win32' || !pid) return null;

  try {
    const { spawnSync } = await import('node:child_process');
    const result = spawnSync(
      'powershell.exe',
      [`-Command "(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName"`],
      { cwd: process.cwd(), stdio: 'pipe', windowsHide: true, timeout: 3000 }
    );

    if (result.status === 0) {
      return result.stdout?.toString().trim() || null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Get the port from a service URL
 */
export function getServicePort(service) {
  try {
    return new URL(service.url).port;
  } catch {
    return null;
  }
}

/**
 * Stop all services that are currently running
 */
export async function stopRunningServices(services, options = {}) {
  const stopped = [];
  for (const service of services) {
    if (await isServerRunning(service, options.fetchFn, options.probeTimeoutMs || 1000)) {
      const port = getServicePort(service);
      if (port) {
        const wasRunning = await stopServerByPort(Number(port), options);
        if (wasRunning) {
          stopped.push({ id: service.id, port, label: service.label });
        }
      }
    }
  }
  return stopped;
}