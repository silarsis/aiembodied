import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { buildStartCommand, describeLocalServices, ensureLocalServices, readSavedPreferences, readSelectedLocalLlm, savedPreferencesPaths, shouldStartServices } = await import(
  '../../../scripts/local-services.mjs'
);

const quiet = { info: () => undefined, warn: () => undefined };

function fakeFetch(up: string[]) {
  return vi.fn(async (url: string) => {
    if (up.some((prefix) => url.startsWith(prefix))) {
      return new Response('{}', { status: 503 });
    }
    throw new Error('ECONNREFUSED');
  });
}

function decodeCommand(args: string[]): string {
  return Buffer.from(args[args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le');
}

/** Stands in for the PowerShell launcher: writes the pid file named in the encoded command. */
function fakeLauncher(pid = 4321) {
  return vi.fn((_command: string, args: string[]) => {
    const match = /Set-Content -LiteralPath '([^']+)'/.exec(decodeCommand(args));
    if (match?.[1]) {
      writeFileSync(match[1], `${pid}\r\n`);
    }
    return { status: 0 };
  });
}

function withTempRepo(run: (repoRoot: string) => Promise<void>) {
  return async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'aiembodied-services-'));
    try {
      await run(repoRoot);
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  };
}

describe('local services', () => {
  it('describes the four servers with ports taken from their URLs', () => {
    const services = describeLocalServices('/repo', {
      KOKORO_DIR: 'C:\\kokoro',
      TEXT_ENCODERS_DIR: 'C:\\enc',
      MOTION_VENV: 'C:\\venv',
      STT_URL: 'http://127.0.0.1:1240/v1/',
    });
    expect(services.map((s: { id: string }) => s.id)).toEqual(['llm', 'asr', 'speech', 'motion', 'memory', 'searxng', 'coder', 'switchboard']);
    const byId = Object.fromEntries(services.map((s: { id: string }) => [s.id, s]));
    expect(byId.asr.probe).toBe('http://127.0.0.1:1240/v1/models');
    expect(byId.asr.args).toEqual(['-Port', '1240']);
    expect(byId.speech.args).toEqual(['-Port', '8192', '-KokoroDir', 'C:\\kokoro']);
    expect(byId.motion.args).toEqual(['-Port', '8190', '-TextEncodersDir', 'C:\\enc', '-Venv', 'C:\\venv']);
    expect(byId.llm.script).toBe(resolve('/repo', 'scripts/start-local-llm.ps1'));
    expect(byId.llm.args).toEqual(['-Port', '1234']);
    const smallContext = describeLocalServices('/repo', { LOCAL_LLM_CONTEXT: '32768' });
    expect(smallContext[0].args).toEqual(['-Port', '1234', '-Context', '32768']);

    const downloaded = describeLocalServices('/repo', { LOCAL_LLM_CONTEXT: '32768' }, {}, { path: 'C:\\m\\x.gguf', alias: 'x-q4_k_m', contextLength: 8192 });
    expect(downloaded[0].args).toEqual(['-Port', '1234', '-Model', 'C:\\m\\x.gguf', '-Alias', 'x-q4_k_m', '-Context', '8192']);
    expect(downloaded[0].label).toBe('x-q4_k_m (llama-server)');

    const onCpu = describeLocalServices('/repo', { MOTION_TEXT_ENCODER_DEVICE: 'cpu' });
    const motionOnCpu = onCpu.find((s: { id: string }) => s.id === 'motion');
    expect(motionOnCpu.args).toEqual(['-Port', '8190', '-TextEncoderDevice', 'cpu']);
  });

  it('starts SearXNG unless web search is off or uses only other providers', () => {
    const searxngOf = (env: Record<string, string>) =>
      describeLocalServices('/repo', env).find((s: { id: string }) => s.id === 'searxng');
    expect(searxngOf({}).enabled).toBe(true);
    expect(searxngOf({ WEB_SEARCH_PROVIDER: 'off' }).enabled).toBe(false);
    expect(searxngOf({ WEB_SEARCH_PROVIDER: 'brave' }).enabled).toBe(false);
    const searxng = searxngOf({ WEB_SEARCH_PROVIDER: 'SearXNG, brave', SEARXNG_URL: 'http://127.0.0.1:8890/' });
    expect(searxng.enabled).toBe(true);
    expect(searxng.probe).toBe('http://127.0.0.1:8890/healthz');
    expect(searxng.args).toEqual(['-Port', '8890']);
    expect(searxng.script).toBe(resolve('/repo', 'services/searxng/scripts/start.ps1'));
  });

  it(
    'restarts a motion service that answers but failed to load its model, and only reports others',
    withTempRepo(async (repoRoot) => {
      const launcher = fakeLauncher(777);
      const fetchFn = vi.fn(async (url: string) => {
        if (url.startsWith('http://127.0.0.1:8190') || url.startsWith('http://127.0.0.1:8192')) {
          return new Response(JSON.stringify({ status: 'error', error: 'OSError: text encoder missing', ready: false }), { status: 200 });
        }
        if (url.startsWith('http://127.0.0.1:1234') || url.startsWith('http://127.0.0.1:1235')) return new Response('{}', { status: 200 });
        throw new Error('ECONNREFUSED');
      });
      const results = await ensureLocalServices(
        repoRoot,
        { KOKORO_DIR: 'C:\\kokoro', WEB_SEARCH_PROVIDER: 'off', MEMORY_AUTOSTART: '0', CODER_AUTOSTART: '0', SWITCHBOARD_AUTOSTART: '0' },
        { fetchFn, spawnSyncFn: launcher, platform: 'win32', log: quiet },
      );
      const byId = Object.fromEntries(results.map((r: { id: string }) => [r.id, r]));
      expect(byId.motion).toMatchObject({ status: 'restarted', pid: 777 });
      // The speech service has no restart rule: it is left running, with the error reported.
      expect(byId.speech).toMatchObject({ status: 'running', error: 'OSError: text encoder missing' });
      const calls = launcher.mock.calls as unknown as Array<[string, string[]]>;
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toEqual(['-NoProfile', '-NonInteractive', '-File', join(repoRoot, 'scripts', 'stop-service.ps1'), '-Port', '8190']);
      expect(decodeCommand(calls[1][1])).toContain(resolve(repoRoot, 'services/motion/scripts/start.ps1'));
    }),
  );

  it(
    'does not start a new motion service when the failed one cannot be stopped',
    withTempRepo(async (repoRoot) => {
      const launcher = vi.fn(() => ({ status: 1 }));
      const fetchFn = vi.fn(async (url: string) => {
        if (url.startsWith('http://127.0.0.1:8190')) return new Response(JSON.stringify({ status: 'error', error: 'boom' }), { status: 200 });
        throw new Error('ECONNREFUSED');
      });
      const results = await ensureLocalServices(
        repoRoot,
        { WEB_SEARCH_PROVIDER: 'off', MEMORY_AUTOSTART: '0', CODER_AUTOSTART: '0', SWITCHBOARD_AUTOSTART: '0', LLM_PROVIDER: 'openai', STT_PROVIDER: 'openai', TTS_PROVIDER: 'openai' },
        { fetchFn, spawnSyncFn: launcher, platform: 'win32', log: quiet },
      );
      expect(results.find((r: { id: string }) => r.id === 'motion')).toMatchObject({ status: 'failed' });
      expect(launcher).toHaveBeenCalledTimes(1);
    }),
  );

  it(
    'leaves running servers alone and starts the missing ones in a hidden console, with logs',
    withTempRepo(async (repoRoot) => {
      const launcher = fakeLauncher();
      const results = await ensureLocalServices(
        repoRoot,
        { KOKORO_DIR: 'C:\\kokoro', WEB_SEARCH_PROVIDER: 'off', MEMORY_AUTOSTART: '0', CODER_AUTOSTART: '0', SWITCHBOARD_AUTOSTART: '0' },
        {
          fetchFn: fakeFetch(['http://127.0.0.1:1234', 'http://127.0.0.1:8192']),
          spawnSyncFn: launcher,
          platform: 'win32',
          log: quiet,
        },
      );

      expect(results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
        ['llm', 'running'],
        ['asr', 'started'],
        ['speech', 'running'],
        ['motion', 'started'],
        ['memory', 'skipped'],
        ['searxng', 'skipped'],
        ['coder', 'skipped'],
        ['switchboard', 'skipped'],
      ]);
      expect(launcher).toHaveBeenCalledTimes(2);
      const [command, args, options] = launcher.mock.calls[0] as unknown as [string, string[], Record<string, unknown>];
      expect(command).toBe('powershell.exe');
      // No pipes: the service would inherit them and keep the launcher from returning.
      expect(options).toMatchObject({ windowsHide: true, cwd: repoRoot, stdio: 'ignore' });
      const script = decodeCommand(args);
      expect(script).toContain(`'"${resolve(repoRoot, 'scripts/start-local-asr.ps1')}"', '"-Port"', '"1235"'`);
      expect(script).toContain('-WindowStyle Hidden');
      expect(results[1]).toMatchObject({ pid: 4321, logPath: join(repoRoot, '.dev-home', 'logs', 'asr.log') });
    }),
  );

  it('keeps this PC’s language model running for Idle thoughts, which follows Thinking until it is pointed elsewhere', () => {
    const llm = (env: Record<string, string>, saved: object = {}) =>
      describeLocalServices('/repo', env, saved).find((s: { id: string }) => s.id === 'llm');
    const saved = (routes: object) => ({ models: { routes } });
    // Nothing else uses the language model: only the idle job keeps it on.
    const onlyIdle = saved({ llm: { server: 'openai' }, stt: { server: 'openai' }, tts: { server: 'openai' }, idle: { server: 'local-llm' } });
    expect(llm({}, onlyIdle)?.enabled).toBe(true);
    const idleElsewhere = saved({ llm: { server: 'openai' }, stt: { server: 'openai' }, tts: { server: 'openai' }, idle: { server: 'openai' } });
    expect(llm({}, idleElsewhere)?.enabled).toBe(false);
    expect(llm({ LLM_PROVIDER: 'openai', STT_PROVIDER: 'openai', TTS_PROVIDER: 'openai' }, {})?.enabled).toBe(false);
    // With the OpenAI Realtime engine, an unrouted Idle thoughts does not start the local model by itself.
    expect(llm({}, { conversationBackend: 'openai' })?.enabled).toBe(false);
    expect(llm({}, { conversationBackend: 'openai', models: { routes: { idle: { server: 'local-llm' } } } })?.enabled).toBe(true);
  });

  it('never starts the vision model, and Describe the avatar on it does not keep the language model on', () => {
    const services = describeLocalServices('/repo', { LLM_PROVIDER: 'openai', STT_PROVIDER: 'openai', TTS_PROVIDER: 'openai' }, {});
    expect(services.map((s: { id: string }) => s.id)).not.toContain('vision');
    expect(services.find((s: { id: string }) => s.id === 'llm')?.enabled).toBe(false);
  });

  it('starts the coding runner with its port, and leaves a runner on another machine alone', () => {
    const coder = (env: Record<string, string>, saved: object = {}) =>
      describeLocalServices('/repo', env, saved).find((s: { id: string }) => s.id === 'coder');
    const local = coder({});
    expect(local).toMatchObject({ enabled: true, url: 'http://127.0.0.1:8195', probe: 'http://127.0.0.1:8195/v1/health', args: ['-Port', '8195'] });
    expect(local.script).toBe(resolve('/repo', 'services/coder/scripts/start.ps1'));
    expect(coder({ CODING_RUNNER_URL: 'http://127.0.0.1:8200/' })).toMatchObject({ url: 'http://127.0.0.1:8200', args: ['-Port', '8200'] });
    expect(coder({ CODER_AUTOSTART: '0' }).enabled).toBe(false);
    expect(coder({}, { coding: { runner: 'server-abc' } }).enabled).toBe(false);
  });

  it('starts the switchboard on its port unless it is turned off', () => {
    const switchboard = (env: Record<string, string>) =>
      describeLocalServices('/repo', env).find((s: { id: string }) => s.id === 'switchboard');
    const local = switchboard({});
    expect(local).toMatchObject({ enabled: true, url: 'http://127.0.0.1:8196', probe: 'http://127.0.0.1:8196/health', args: ['-Port', '8196'] });
    expect(local.script).toBe(resolve('/repo', 'services/switchboard/scripts/start.ps1'));
    expect(switchboard({ SWITCHBOARD_URL: 'http://127.0.0.1:8296' })).toMatchObject({ args: ['-Port', '8296'] });
    expect(switchboard({ SWITCHBOARD_ENABLED: '0' }).enabled).toBe(false);
    expect(switchboard({ SWITCHBOARD_AUTOSTART: '0' }).enabled).toBe(false);
  });

  it('skips what the configuration does not need or cannot start', async () => {
    const launcher = fakeLauncher();
    const results = await ensureLocalServices(
      '/repo',
      { CONVERSATION_BACKEND: 'openai', MOTION_SERVICE_URL: 'http://gpu-box:8190', WEB_SEARCH_PROVIDER: 'off', MEMORY_ENABLED: '0', CODER_ENABLED: '0', SWITCHBOARD_ENABLED: '0' },
      { fetchFn: fakeFetch([]), spawnSyncFn: launcher, platform: 'win32', log: quiet },
    );
    expect(results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ['llm', 'skipped'],
      ['asr', 'skipped'],
      ['speech', 'skipped'],
      ['motion', 'skipped'],
      ['memory', 'skipped'],
      ['searxng', 'skipped'],
      ['coder', 'skipped'],
      ['switchboard', 'skipped'],
    ]);
    expect(results[3].reason).toContain('not on this machine');
    expect(launcher).not.toHaveBeenCalled();
  });

  it('does not start the speech service without KOKORO_DIR, or ASR when whisper is chosen', async () => {
    const launcher = fakeLauncher();
    const results = await ensureLocalServices(
      '/repo',
      { STT_ENGINE: 'whisper', DEV_START_MOTION: '0', WEB_SEARCH_PROVIDER: 'off', MEMORY_AUTOSTART: '0', CODER_AUTOSTART: '0', SWITCHBOARD_AUTOSTART: '0' },
      { fetchFn: fakeFetch(['http://127.0.0.1:1234']), spawnSyncFn: launcher, platform: 'win32', log: quiet },
    );
    const byId = Object.fromEntries(results.map((r: { id: string }) => [r.id, r]));
    expect(byId.asr.status).toBe('skipped');
    expect(byId.speech).toMatchObject({ status: 'skipped' });
    expect(byId.speech.reason).toContain('KOKORO_DIR');
    expect(byId.motion.status).toBe('skipped');
    expect(launcher).not.toHaveBeenCalled();
  });

  it(
    'reports a launch that leaves no process id as failed',
    withTempRepo(async (repoRoot) => {
      const results = await ensureLocalServices(
        repoRoot,
        { CONVERSATION_BACKEND: 'openai' },
        { fetchFn: fakeFetch([]), spawnSyncFn: vi.fn(() => ({ status: 1 })), platform: 'win32', log: quiet },
      );
      const motion = results.find((r: { id: string }) => r.id === 'motion');
      expect(motion).toMatchObject({ status: 'failed' });
      expect(motion.reason).toContain('launcher exited with code 1');
    }),
  );

  it('starts the memory engine unless memory or its autostart is off', () => {
    const memoryOf = (env: Record<string, string>) =>
      describeLocalServices('/repo', env).find((s: { id: string }) => s.id === 'memory');
    expect(memoryOf({})).toMatchObject({ enabled: true, probe: 'http://127.0.0.1:8194/health', args: ['-Port', '8194'] });
    expect(memoryOf({}).script).toBe(resolve('/repo', 'services/memory/scripts/start.ps1'));
    expect(memoryOf({ MEMORY_AUTOSTART: '0' }).enabled).toBe(false);
    expect(memoryOf({ MEMORY_ENABLED: 'off' }).enabled).toBe(false);
    expect(memoryOf({ MEMORY_SERVICE_URL: 'http://127.0.0.1:9000/' }).args).toEqual(['-Port', '9000']);
  });

  it('quotes paths and arguments for Start-Process', () => {
    const command = buildStartCommand({
      script: "C:\\My Repos\\o'brien\\start.ps1",
      args: ['-Port', '8192'],
      cwd: 'C:\\My Repos',
      logPath: 'C:\\logs\\a.log',
      errPath: 'C:\\logs\\a.err.log',
      pidPath: 'C:\\logs\\a.pid',
    });
    expect(command).toContain(`'"C:\\My Repos\\o''brien\\start.ps1"', '"-Port"', '"8192"'`);
    expect(command).toContain("-RedirectStandardOutput 'C:\\logs\\a.log' -RedirectStandardError 'C:\\logs\\a.err.log'");
    expect(command).toContain("Set-Content -LiteralPath 'C:\\logs\\a.pid' -Value $p.Id");
  });

  it('follows the providers saved on the Settings page over the environment', () => {
    const enabled = (saved: object, env: Record<string, string> = {}) =>
      Object.fromEntries(
        describeLocalServices('/repo', { KOKORO_DIR: 'C:\\k', ...env }, saved)
          .filter((s: { id: string }) => s.id !== 'searxng' && s.id !== 'memory' && s.id !== 'coder' && s.id !== 'switchboard')
          .map((s: { id: string; enabled: boolean }) => [s.id, s.enabled]),
      );

    expect(enabled({})).toEqual({ llm: true, asr: true, speech: true, motion: true });
    expect(enabled({ providers: { llm: { provider: 'openai' }, stt: { provider: 'openai' } } })).toEqual({
      llm: false,
      asr: false,
      speech: true,
      motion: true,
    });
    expect(
      enabled({ providers: { stt: { provider: 'openai' }, tts: { provider: 'openai' }, motion: { provider: 'openai' } } }),
    ).toEqual({ llm: true, asr: false, speech: false, motion: false });
    // A saved choice wins over the env, as it does in the app.
    expect(enabled({ providers: { llm: { provider: 'local' } } }, { LLM_PROVIDER: 'openai' }).llm).toBe(true);
    expect(enabled({ conversationBackend: 'openai' })).toEqual({ llm: false, asr: false, speech: false, motion: true });

    const motion = describeLocalServices('/repo', {}, { providers: { motion: { localBackend: 'kimodo' } } }).find(
      (s: { id: string }) => s.id === 'motion',
    );
    expect(motion.args).toEqual(['-Port', '8190', '-Backend', 'kimodo']);
    expect(motion.label).toBe('motion service (Kimodo)');
  });

  it(
    'reads the dev app preferences file',
    withTempRepo(async (repoRoot) => {
      expect(readSavedPreferences(repoRoot)).toEqual({});
      const [file] = savedPreferencesPaths(repoRoot);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify({ providers: { tts: { provider: 'openai' } } }));
      expect(readSavedPreferences(repoRoot)).toEqual({ providers: { tts: { provider: 'openai' } } });
    }),
  );

  it('can be switched off', () => {
    expect(shouldStartServices(['node', 'run-dev.mjs'], {})).toBe(true);
    expect(shouldStartServices(['node', 'run-dev.mjs', '--no-services'], {})).toBe(false);
    expect(shouldStartServices(['node', 'run-dev.mjs'], { DEV_START_SERVICES: '0' })).toBe(false);
  });
});

describe('thinking model picked in the app', () => {
  it('reads the picked model from local-llm.json beside preferences.json', () => {
    const repoRoot = mkdtempSync(join(tmpdir(), 'local-llm-'));
    try {
      const [preferences] = savedPreferencesPaths(repoRoot);
      mkdirSync(dirname(preferences), { recursive: true });
      const model = join(repoRoot, 'm.gguf');
      writeFileSync(model, '');
      writeFileSync(
        join(dirname(preferences), 'local-llm.json'),
        JSON.stringify({ selected: 'a/b:m', models: [{ id: 'a/b:m', path: model, alias: 'b-q4', contextLength: 4096 }] }),
      );
      expect(readSelectedLocalLlm(repoRoot)).toEqual({ path: model, alias: 'b-q4', contextLength: 4096 });
      rmSync(model);
      expect(readSelectedLocalLlm(repoRoot)).toBeNull();
    } finally {
      rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
