import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { MISSING_VISION_MODEL, VisionServer, visionServerFor, withVisionServer } from '../src/local-vision/vision-server.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'vision-server-'));
  mkdirSync(path.join(root, 'scripts'));
  writeFileSync(path.join(root, 'scripts', 'start-local-vision.ps1'), '');
  writeFileSync(path.join(root, 'm.gguf'), 'm');
  writeFileSync(path.join(root, 'p.gguf'), 'p');
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function harness(options: { picked?: boolean; platform?: string; loadsAfter?: number; alreadyUp?: boolean; neverUp?: boolean } = {}) {
  let up = options.alreadyUp === true;
  let polls = 0;
  let clock = 0;
  const timers: Array<{ id: number; cb: () => void; ms: number }> = [];
  let nextId = 1;
  const launch = vi.fn(() => {
    polls = 0;
  });
  const stop = vi.fn(async () => {
    up = false;
  });
  const fetchFn = vi.fn(async (input: unknown) => {
    const url = String(input);
    if (!up && launch.mock.calls.length > 0 && !options.neverUp) {
      polls += 1;
      if (polls > (options.loadsAfter ?? 2)) up = true;
    }
    const ok = up && (url.endsWith('/health') || url.endsWith('/models'));
    // llama-server answers 503 while the model loads.
    return new Response('', { status: ok ? 200 : launch.mock.calls.length ? 503 : 500 });
  }) as unknown as typeof fetch;
  const server = new VisionServer({
    baseUrl: () => 'http://127.0.0.1:1237/v1',
    pick: async () => (options.picked === false ? null : { repo: 'r/r', model: path.join(root, 'm.gguf'), mmproj: path.join(root, 'p.gguf'), alias: 'qwen3-vl' }),
    repoRoot: root,
    logDirectory: path.join(root, 'logs'),
    platform: options.platform ?? 'win32',
    fetchFn,
    launch,
    stop,
    setTimer: (cb, ms) => {
      const id = nextId++;
      timers.push({ id, cb, ms });
      return id;
    },
    clearTimer: (handle) => {
      const index = timers.findIndex((timer) => timer.id === handle);
      if (index >= 0) timers.splice(index, 1);
    },
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  return { server, launch, stop, fetchFn, timers };
}

describe('vision server', () => {
  it('uses a server that already answers without starting anything', async () => {
    const { server, launch, stop, timers } = harness({ alreadyUp: true });
    await server.ensureRunning();
    expect(launch).not.toHaveBeenCalled();
    server.release();
    expect(timers).toHaveLength(1);
    timers[0].cb();
    await Promise.resolve();
    // Not started by the app, so not stopped by it.
    expect(stop).not.toHaveBeenCalled();
  });

  it('starts the script hidden with the model, mmproj and a pid file, and waits through the 503s', async () => {
    const { server, launch } = harness({ loadsAfter: 3 });
    await server.ensureRunning();
    expect(launch).toHaveBeenCalledTimes(1);
    const command = (launch.mock.calls[0] as unknown as [string])[0];
    expect(command).toContain('start-local-vision.ps1');
    expect(command).toContain('-Mmproj');
    expect(command).toContain('-Port');
    expect(command).toContain('1237');
    expect(command).toContain('-WindowStyle Hidden');
    expect(command).toContain('vision.pid');
    expect(command).toContain('vision.err.log');
    expect(server.activeJobs).toBe(1);
  });

  it('shares one start between callers that arrive together', async () => {
    const { server, launch } = harness();
    await Promise.all([server.ensureRunning(), server.ensureRunning(), server.ensureRunning()]);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(server.activeJobs).toBe(3);
  });

  it('stops after ten idle minutes, and each job resets the timer', async () => {
    const { server, stop, timers } = harness();
    await server.ensureRunning();
    server.release();
    expect(timers).toHaveLength(1);
    expect(timers[0].ms).toBe(10 * 60_000);
    // Another job arrives before the time is up: the old timer is gone.
    await server.ensureRunning();
    expect(timers).toHaveLength(0);
    server.release();
    expect(timers).toHaveLength(1);
    timers[0].cb();
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it('does not stop while a job is still running', async () => {
    const { server, stop, timers } = harness();
    await server.ensureRunning();
    await server.ensureRunning();
    server.release();
    expect(timers).toHaveLength(0);
    expect(stop).not.toHaveBeenCalled();
  });

  it('asks for the download when the model files are missing, and starts nothing', async () => {
    const { server, launch } = harness({ picked: false });
    await expect(server.ensureRunning()).rejects.toThrow(MISSING_VISION_MODEL);
    expect(launch).not.toHaveBeenCalled();
    expect(server.activeJobs).toBe(0);
  });

  it('gives up after 180 seconds and stops what it started', async () => {
    const { server, stop } = harness({ neverUp: true });
    await expect(server.ensureRunning()).rejects.toThrow(/did not finish loading within 180 seconds/);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(server.activeJobs).toBe(0);
  });

  it('cannot start the script off Windows', async () => {
    const { server, launch } = harness({ platform: 'linux' });
    await expect(server.ensureRunning()).rejects.toThrow(/Windows only/);
    expect(launch).not.toHaveBeenCalled();
  });
});

describe('routing a job to the vision server', () => {
  const routing = (stored = {}) =>
    resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS), stored);
  const fake = () => ({ ensureRunning: vi.fn(async () => undefined), release: vi.fn() });

  it('starts the server for the local-vision route and releases it afterwards, even when the job fails', async () => {
    const server = fake();
    await expect(withVisionServer(routing(), 'describe', server, async () => 'a description')).resolves.toBe('a description');
    expect(server.ensureRunning).toHaveBeenCalledTimes(1);
    expect(server.release).toHaveBeenCalledTimes(1);
    await expect(withVisionServer(routing(), 'posecheck', server, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(server.release).toHaveBeenCalledTimes(2);
  });

  it('does nothing for OpenAI, another PC, or a use that is not routed there', async () => {
    const server = fake();
    await withVisionServer(routing({ routes: { describe: { server: 'openai', model: 'gpt-4.1-mini' } } }), 'describe', server, async () => 1);
    await withVisionServer(routing({ servers: [{ id: 'local-vision', url: 'http://192.168.1.9:1237/v1' }] }), 'describe', server, async () => 1);
    await withVisionServer(routing(), 'posegen', server, async () => 1);
    expect(server.ensureRunning).not.toHaveBeenCalled();
    expect(server.release).not.toHaveBeenCalled();
    expect(visionServerFor(routing(), 'describe')?.id).toBe('local-vision');
    expect(visionServerFor(routing(), 'llm')).toBeNull();
  });

  it('does not run the job when the server will not start', async () => {
    const server = { ensureRunning: vi.fn(async () => Promise.reject(new Error(MISSING_VISION_MODEL))), release: vi.fn() };
    const job = vi.fn(async () => 'x');
    await expect(withVisionServer(routing(), 'describe', server, job)).rejects.toThrow(MISSING_VISION_MODEL);
    expect(job).not.toHaveBeenCalled();
    expect(server.release).not.toHaveBeenCalled();
  });
});
