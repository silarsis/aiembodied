/**
 * Make sure the local model servers the app talks to are running before the dev app starts:
 * the LLM (llama-server, Qwen Flash-Next), speech-to-text (llama-server, Qwen3-ASR), the speech
 * service (Kokoro TTS) and the motion service (ARDY). A server that already answers is left
 * alone, so one slopcore or another terminal started is reused. A missing one is started with
 * its own start script in a hidden console of its own, logging to .dev-home/logs/<id>.log
 * (and <id>.err.log), and keeps running after the app and the terminal close. Nothing waits for models to finish loading: the app polls each service and
 * picks it up once it reports ready.
 *
 * Settings come from the environment or .env: the same URLs the app uses (LOCAL_LLM_BASE_URL,
 * STT_URL, SPEECH_SERVICE_URL, MOTION_SERVICE_URL) plus the paths the start scripts need
 * (KOKORO_DIR, MOTION_VENV, TEXT_ENCODERS_DIR, ...). Skip it all with --no-services or
 * DEV_START_SERVICES=0.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

function isOn(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

function trimSlash(url) {
  return url.replace(/\/+$/, '');
}

/** The services to ensure, with how to tell each is up and how to start it. */
export function describeLocalServices(repoRoot, env) {
  const local = (env.CONVERSATION_BACKEND ?? 'local').trim().toLowerCase() !== 'openai';
  const sttServer = (env.STT_ENGINE ?? 'server').trim().toLowerCase() === 'server';
  const llmUrl = trimSlash(env.LOCAL_LLM_BASE_URL || 'http://127.0.0.1:1234/v1');
  const sttUrl = trimSlash(env.STT_URL || 'http://127.0.0.1:1235/v1');
  const speechUrl = trimSlash(env.SPEECH_SERVICE_URL || 'http://127.0.0.1:8192');
  const motionUrl = trimSlash(env.MOTION_SERVICE_URL || 'http://127.0.0.1:8190');

  const services = [
    {
      id: 'llm',
      label: 'Qwen LLM (llama-server)',
      enabled: local,
      url: llmUrl,
      probe: `${llmUrl}/models`,
      script: 'scripts/start-local-llm.ps1',
      args: portArgs(llmUrl),
    },
    {
      id: 'asr',
      label: 'Qwen3-ASR speech-to-text (llama-server)',
      enabled: local && sttServer,
      url: sttUrl,
      probe: `${sttUrl}/models`,
      script: 'scripts/start-local-asr.ps1',
      args: portArgs(sttUrl),
    },
    {
      id: 'speech',
      label: 'speech service (Kokoro TTS)',
      enabled: local,
      url: speechUrl,
      probe: `${speechUrl}/health`,
      script: 'services/speech/scripts/start.ps1',
      args: [...portArgs(speechUrl), ...(env.KOKORO_DIR ? ['-KokoroDir', env.KOKORO_DIR] : [])],
      missing: env.KOKORO_DIR ? null : 'KOKORO_DIR (folder with kokoro-v1.0.onnx and voices-v1.0.bin)',
    },
    {
      id: 'motion',
      label: 'motion service (ARDY)',
      enabled: isOn(env.DEV_START_MOTION, true),
      url: motionUrl,
      probe: `${motionUrl}/health`,
      script: 'services/motion/scripts/start.ps1',
      // The text encoder (~16.5 GB) runs on the GPU by default. MOTION_TEXT_ENCODER_DEVICE=cpu
      // saves that GPU memory but needs the same in system RAM, which a unified-memory machine
      // with most of its RAM carved out for the GPU (bija: 31.6 GB visible) may not have.
      args: [
        ...portArgs(motionUrl),
        ...(env.MOTION_TEXT_ENCODER_DEVICE ? ['-TextEncoderDevice', env.MOTION_TEXT_ENCODER_DEVICE] : []),
        ...(env.TEXT_ENCODERS_DIR ? ['-TextEncodersDir', env.TEXT_ENCODERS_DIR] : []),
        ...(env.MOTION_VENV ? ['-Venv', env.MOTION_VENV] : []),
      ],
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
