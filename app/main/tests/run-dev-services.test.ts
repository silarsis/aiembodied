import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const { buildStartCommand, describeLocalServices, ensureLocalServices, readSavedPreferences, savedPreferencesPath, shouldStartServices } = await import(
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
    expect(services.map((s: { id: string }) => s.id)).toEqual(['llm', 'asr', 'speech', 'motion']);
    const byId = Object.fromEntries(services.map((s: { id: string }) => [s.id, s]));
    expect(byId.asr.probe).toBe('http://127.0.0.1:1240/v1/models');
    expect(byId.asr.args).toEqual(['-Port', '1240']);
    expect(byId.speech.args).toEqual(['-Port', '8192', '-KokoroDir', 'C:\\kokoro']);
    expect(byId.motion.args).toEqual(['-Port', '8190', '-TextEncodersDir', 'C:\\enc', '-Venv', 'C:\\venv']);
    expect(byId.llm.script).toBe(resolve('/repo', 'scripts/start-local-llm.ps1'));
    expect(byId.llm.args).toEqual(['-Port', '1234']);
    const smallContext = describeLocalServices('/repo', { LOCAL_LLM_CONTEXT: '32768' });
    expect(smallContext[0].args).toEqual(['-Port', '1234', '-Context', '32768']);

    const onCpu = describeLocalServices('/repo', { MOTION_TEXT_ENCODER_DEVICE: 'cpu' });
    expect(onCpu.at(-1).args).toEqual(['-Port', '8190', '-TextEncoderDevice', 'cpu']);
  });

  it(
    'leaves running servers alone and starts the missing ones in a hidden console, with logs',
    withTempRepo(async (repoRoot) => {
      const launcher = fakeLauncher();
      const results = await ensureLocalServices(
        repoRoot,
        { KOKORO_DIR: 'C:\\kokoro' },
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

  it('skips what the configuration does not need or cannot start', async () => {
    const launcher = fakeLauncher();
    const results = await ensureLocalServices(
      '/repo',
      { CONVERSATION_BACKEND: 'openai', MOTION_SERVICE_URL: 'http://gpu-box:8190' },
      { fetchFn: fakeFetch([]), spawnSyncFn: launcher, platform: 'win32', log: quiet },
    );
    expect(results.map((r: { id: string; status: string }) => [r.id, r.status])).toEqual([
      ['llm', 'skipped'],
      ['asr', 'skipped'],
      ['speech', 'skipped'],
      ['motion', 'skipped'],
    ]);
    expect(results[3].reason).toContain('not on this machine');
    expect(launcher).not.toHaveBeenCalled();
  });

  it('does not start the speech service without KOKORO_DIR, or ASR when whisper is chosen', async () => {
    const launcher = fakeLauncher();
    const results = await ensureLocalServices(
      '/repo',
      { STT_ENGINE: 'whisper', DEV_START_MOTION: '0' },
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
      expect(results.at(-1)).toMatchObject({ id: 'motion', status: 'failed' });
      expect(results.at(-1).reason).toContain('launcher exited with code 1');
    }),
  );

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
        describeLocalServices('/repo', { KOKORO_DIR: 'C:\\k', ...env }, saved).map(
          (s: { id: string; enabled: boolean }) => [s.id, s.enabled],
        ),
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
      const file = savedPreferencesPath(repoRoot);
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
