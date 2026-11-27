import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AicontrollerBridge, ControllerModelMissing } from '../src/aicontroller/bridge.js';
import { ComfyUIPool } from '../src/avatar/generation/comfyui-pool.js';
import type { ComfyUIRuntime } from '../src/avatar/generation/comfyui-runtime.js';
import {
  builtInServers,
  defaultRoutes,
  resolveModelRouting,
  type StoredModels,
} from '../src/shared/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/shared/config/provider-settings.js';
import { LocalLlmControl } from '../src/local-voice/local-llm-control.js';
import { VisionServer } from '../src/local-vision/vision-server.js';
import { FAKE_BACKEND_URLS, FakeAicontroller } from './helpers/fake-aicontroller.js';

const logger = { info: vi.fn(), warn: vi.fn() };

const routing = (stored: StoredModels = { servers: [], routes: {} }) =>
  resolveModelRouting(
    builtInServers({
      providers: DEFAULT_PROVIDER_SETTINGS,
      comfyUiBaseUrl: 'http://127.0.0.1:8188',
    }),
    defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
    stored,
  );

/** A ComfyUI that records every request and finishes any graph at once. Nothing touches the network. */
function fakeComfy() {
  const urls: string[] = [];
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    urls.push(`${init?.method ?? 'GET'} ${url.origin}${url.pathname}`);
    if (url.pathname === '/prompt') return new Response(JSON.stringify({ prompt_id: 'p1' }));
    if (url.pathname.startsWith('/history/')) {
      return new Response(
        JSON.stringify({
          p1: {
            status: { completed: true },
            outputs: { 9: { images: [{ type: 'output', filename: 'a.png' }] } },
          },
        }),
      );
    }
    if (url.pathname === '/view') return new Response(new Uint8Array([1, 2, 3]));
    return new Response('{}');
  }) as unknown as typeof fetch;
  return { urls, fetchFn };
}

describe('aicontroller leases for the other GPU servers', () => {
  let fake: FakeAicontroller;
  beforeEach(async () => {
    fake = await new FakeAicontroller().start();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const bridge = (
    extra: Partial<ConstructorParameters<typeof AicontrollerBridge>[0]> = {},
    env: Record<string, string> = {},
  ) =>
    new AicontrollerBridge({
      logger,
      env: { AICONTROLLER_URL: fake.url, ...env },
      watchMs: 0,
      sharedIdleMs: 120,
      ...extra,
    });

  describe('ComfyUI', () => {
    const pool = (
      b: AicontrollerBridge,
      comfy: ReturnType<typeof fakeComfy>,
      stored?: StoredModels,
      ensureReady = vi.fn(async () => undefined),
    ) =>
      new ComfyUIPool({
        routing: () => routing(stored),
        logDirectory: 'unused',
        fetchFn: comfy.fetchFn,
        leases: b,
        createRuntime: () => ({ ensureReady }) as unknown as ComfyUIRuntime,
        logger: { warn: vi.fn(), info: vi.fn() },
      });

    it('leases comfyui for a job, uses the lease URL, never calls /free, and shares the lease with the next job', async () => {
      const b = bridge();
      await b.start();
      await b.ensureEcho();
      expect(fake.active('echo-llm')).toHaveLength(1);
      const comfy = fakeComfy();
      const ensureReady = vi.fn(async () => undefined);
      const p = pool(b, comfy, undefined, ensureReady);

      const first = await p.pick('image');
      expect(await first.run({})).toEqual(Buffer.from([1, 2, 3]));
      // Two takes in a row: one lease, on the lease's URL, and the app started nothing.
      const second = await p.pick('image');
      await second.run({});
      expect(fake.leaseRequests.filter((request) => request.backend === 'comfyui')).toHaveLength(1);
      expect(fake.active('comfyui')[0]?.client).toBe('aiembodied');
      expect(ensureReady).not.toHaveBeenCalled();
      expect(comfy.urls).toContain(`POST ${FAKE_BACKEND_URLS.comfyui}/prompt`);
      expect(comfy.urls.every((entry) => entry.includes(FAKE_BACKEND_URLS.comfyui as string))).toBe(
        true,
      );
      expect(comfy.urls.some((entry) => entry.includes('/free'))).toBe(false);
      // The controller never evicts a leased Echo, so Echo's lease is given back meanwhile.
      expect(fake.active('echo-llm')).toHaveLength(0);
      expect(b.status().line).toContain('comfyui leased');

      // After a quiet spell the lease goes back and Echo's model is leased again.
      await vi.waitFor(() => expect(fake.active('comfyui')).toHaveLength(0));
      await vi.waitFor(() => expect(fake.active('echo-llm')).toHaveLength(1));
      expect(b.status().line).toContain('comfyui, vision idle');
      await b.shutdown();
    });

    it('holds the lease while a request runs, and gives it back after a failed or cancelled job', async () => {
      const b = bridge();
      await b.start();
      const first = await b.acquire('comfyui');
      expect(first?.url).toBe(FAKE_BACKEND_URLS.comfyui);
      await new Promise((resolve) => setTimeout(resolve, 300)); // longer than the quiet spell
      expect(fake.active('comfyui')).toHaveLength(1);
      first?.done();
      first?.done(); // twice is harmless
      await vi.waitFor(() => expect(fake.active('comfyui')).toHaveLength(0));

      const p = pool(b, fakeComfy());
      const client = await p.pick('image');
      const abort = new AbortController();
      abort.abort();
      await expect(client.run({}, { signal: abort.signal })).rejects.toThrow(/cancelled/);
      await vi.waitFor(() => expect(fake.active('comfyui')).toHaveLength(0));
      await b.shutdown();
    });

    it('leaves another machine’s ComfyUI alone', async () => {
      const b = bridge();
      await b.start();
      const comfy = fakeComfy();
      const stored: StoredModels = {
        servers: [{ id: 'rack', name: 'Rack', type: 'comfy', url: 'http://rack:8188' }],
        routes: { image: { server: 'rack' } },
      };
      const client = await pool(b, comfy, stored).pick('image');
      await client.run({});
      expect(client.baseUrl).toBe('http://rack:8188');
      expect(fake.leaseRequests.filter((request) => request.backend === 'comfyui')).toHaveLength(0);
      expect(comfy.urls.every((entry) => entry.includes('http://rack:8188'))).toBe(true);
      await b.shutdown();
    });

    it('runs its own ComfyUI as before when the controller is not used', async () => {
      const b = bridge({}, { AICONTROLLER_ENABLED: '0' });
      await b.start();
      const ensureReady = vi.fn(async () => undefined);
      const client = await pool(b, fakeComfy(), undefined, ensureReady).pick('image');
      expect(ensureReady).toHaveBeenCalled();
      expect(client.baseUrl).toBe('http://127.0.0.1:8188');
      expect(fake.requests).toEqual([]);
    });

    it.each([
      ['lists no comfyui backend', true],
      ['answers 404 for it', false],
    ])('falls back to its own ComfyUI once when the controller %s', async (_name, statusWorks) => {
      fake.unknown.add('comfyui');
      fake.statusWorks = statusWorks;
      const b = bridge();
      await b.start();
      const ensureReady = vi.fn(async () => undefined);
      const p = pool(b, fakeComfy(), undefined, ensureReady);
      await p.pick('image');
      await p.pick('image');
      expect(ensureReady).toHaveBeenCalledTimes(2);
      expect(
        fake.leaseRequests.filter((request) => request.backend === 'comfyui').length,
      ).toBeLessThanOrEqual(1);
      expect(
        logger.warn.mock.calls.filter(([message]) =>
          String(message).includes('no comfyui backend'),
        ),
      ).toHaveLength(1);
      expect(b.managesBackend('comfyui')).toBe(false);
      expect(b.status().line).toContain('comfyui not on the controller');
      await b.shutdown();
    });

    it('does not lease this PC’s ComfyUI just to pick a server, so a job routed elsewhere leaves Echo alone', async () => {
      const b = bridge();
      await b.start();
      await b.ensureEcho();
      await pool(b, fakeComfy()).pick('image');
      expect(fake.leaseRequests.filter((request) => request.backend === 'comfyui')).toHaveLength(0);
      expect(fake.active('echo-llm')).toHaveLength(1);
      await b.shutdown();
    });

    it('fails the job with the reason when the controller can’t give ComfyUI the GPU', async () => {
      const b = bridge();
      await b.start();
      fake.refuse.add('comfyui');
      // Picking no longer leases (the job's own lease picks the machine); the job fails with the reason.
      const client = await pool(b, fakeComfy()).pick('image');
      await expect(client.run({})).rejects.toThrow(/GPU needed by game.exe/);
      await b.shutdown();
    });
  });

  describe('motion', () => {
    it('leases motion while it is enabled, shows a revoke in the status, and leases again', async () => {
      const onChange = vi.fn();
      const b = bridge({ onChange });
      b.setMotionWanted(true); // before the controller is found: leased once it is
      await b.start();
      await vi.waitFor(() => expect(b.motionUrl()).toBe(FAKE_BACKEND_URLS.motion));
      expect(fake.active('motion')[0]?.client).toBe('aiembodied');
      await b.ensureEcho();
      expect(b.status().line).toContain('echo-llm, motion leased');

      fake.revokeAll('GPU needed by game.exe');
      await vi.waitFor(() => {
        b.check();
        expect(b.motionUrl()).toBeNull();
      });
      expect(b.status().line).toContain(
        'Motion paused by the model controller (GPU needed by game.exe).',
      );
      expect(b.status().leases).toContainEqual({ backend: 'motion', state: 'paused' });
      await b.ensureMotion();
      expect(b.motionUrl()).toBe(FAKE_BACKEND_URLS.motion);
      expect(b.status().line).not.toContain('Motion paused');
      await b.ensureEcho();

      // Sleep gives it back, resume takes it again.
      await b.suspend();
      expect(fake.active('motion')).toHaveLength(0);
      await b.resume();
      await vi.waitFor(() => expect(fake.active('motion')).toHaveLength(1));
      // Turning motion off in Models and servers gives it back.
      b.setMotionWanted(false);
      await vi.waitFor(() => expect(fake.active('motion')).toHaveLength(0));
      expect(b.status().leases.some((entry) => entry.backend === 'motion')).toBe(false);
      await b.shutdown();
      expect([...fake.leases.values()].every((lease) => lease.state !== 'ready')).toBe(true);
      expect(onChange).toHaveBeenCalled();
    });

    it('leases nothing when motion is off, and keeps the configured address without a motion backend', async () => {
      const b = bridge();
      await b.start();
      expect(fake.leaseRequests.some((request) => request.backend === 'motion')).toBe(false);
      fake.unknown.add('motion');
      const c = bridge();
      c.setMotionWanted(true);
      await c.start();
      await c.ensureMotion();
      expect(c.motionUrl()).toBeNull();
      expect(c.managesBackend('motion')).toBe(false);
      expect(c.status().line).toContain('motion not on the controller');
      await b.shutdown();
      await c.shutdown();
    });
  });

  describe('vision', () => {
    const server = (b: AicontrollerBridge, running = false) => {
      const launch = vi.fn();
      const vision = new VisionServer({
        baseUrl: () => 'http://127.0.0.1:41237/v1',
        pick: async () => null,
        repoRoot: 'unused',
        logDirectory: 'unused',
        platform: 'linux',
        // Without the controller the app would find its own server running.
        fetchFn: (async () =>
          new Response('', { status: running ? 200 : 500 })) as unknown as typeof fetch,
        launch,
        stop: async () => undefined,
        leases: b,
        logger,
      });
      return { vision, launch };
    };

    it('leases vision for a use, shares it with the next, and gives it back after the quiet spell', async () => {
      const b = bridge();
      await b.start();
      const { vision, launch } = server(b);
      await vision.ensureRunning();
      expect(fake.active('vision')).toHaveLength(1);
      vision.release();
      await vision.ensureRunning();
      vision.release();
      expect(fake.leaseRequests.filter((request) => request.backend === 'vision')).toHaveLength(1);
      expect(launch).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(fake.active('vision')).toHaveLength(0));
      await b.shutdown();
    });

    it('falls back to its own server when the controller has no vision backend', async () => {
      fake.unknown.add('vision');
      const b = bridge();
      await b.start();
      const { vision } = server(b, true); // its own server answers
      await vision.ensureRunning();
      vision.release();
      expect(fake.leaseRequests.some((request) => request.backend === 'vision')).toBe(false);
      expect(b.status().line).toContain('vision not on the controller');

      // Same when only the lease call says so.
      const other = new FakeAicontroller();
      await other.start();
      other.statusWorks = false;
      other.unknown.add('vision');
      const c = new AicontrollerBridge({
        logger,
        env: { AICONTROLLER_URL: other.url },
        watchMs: 0,
      });
      await c.start();
      const { vision: second } = server(c, true);
      await second.ensureRunning();
      await second.ensureRunning();
      second.release();
      second.release();
      expect(other.leaseRequests.filter((request) => request.backend === 'vision')).toHaveLength(1);
      await c.shutdown();
      await other.stop();
      await b.shutdown();
    });
  });

  describe('the Thinking model picker', () => {
    const fooPath = 'C:\\models\\unsloth\\Foo-GGUF\\Foo-Q4_K_M.gguf';

    beforeEach(() => {
      fake.models.push({
        id: 'llm-foo',
        kind: 'llm',
        path: 'c:/models/unsloth/Foo-GGUF/Foo-Q4_K_M.gguf',
        file_name: 'Foo-Q4_K_M.gguf',
        alias: 'foo',
      });
      fake.models.push({
        id: 'llm-bar',
        kind: 'llm',
        path: '/elsewhere/Bar-Q8_0.gguf',
        file_name: 'Bar-Q8_0.gguf',
        alias: 'bar',
      });
    });

    it('releases Echo’s lease and leases echo-llm again with the picked model', async () => {
      const b = bridge();
      await b.start();
      await b.ensureEcho();
      const first = fake.active('echo-llm')[0];
      expect(first?.model).toBeNull();

      const message = await b.useEchoModel({ path: fooPath, alias: 'foo' });
      expect(message).toContain('foo');
      expect(first?.state).toBe('released');
      await vi.waitFor(() => expect(fake.active('echo-llm')[0]?.model).toBe('llm-foo'));
      expect(fake.leaseRequests.at(-1)).toMatchObject({ backend: 'echo-llm', model: 'llm-foo' });

      // A revoke leases the same model again; back to the default asks for none.
      fake.revokeAll('GPU needed by game.exe');
      await vi.waitFor(() => {
        b.check();
        expect(b.status().echo).toBe('paused');
      });
      await b.ensureEcho();
      expect(fake.leaseRequests.at(-1)?.model).toBe('llm-foo');
      await b.useEchoModel(null);
      await vi.waitFor(() => expect(fake.leaseRequests.at(-1)?.model).toBeNull());
      await vi.waitFor(() => expect(fake.active('echo-llm')).toHaveLength(1));
      await b.shutdown();
    });

    it('asks for the model picked earlier when Echo’s first lease is made', async () => {
      const b = bridge({ echoModel: async () => ({ path: '/x/Bar-Q8_0.gguf', alias: 'bar' }) });
      await b.start();
      await b.ensureEcho();
      expect(fake.leaseRequests[0]).toMatchObject({ backend: 'echo-llm', model: 'llm-bar' });
      await b.shutdown();
    });

    it('says what to do when the controller doesn’t have the model, and leaves the lease alone', async () => {
      const b = bridge();
      await b.start();
      await b.ensureEcho();
      const before = fake.leaseRequests.length;
      await expect(
        b.useEchoModel({ path: 'D:\\other\\Missing-Q4.gguf', alias: 'missing' }),
      ).rejects.toThrow(ControllerModelMissing);
      await expect(
        b.useEchoModel({ path: 'D:\\other\\Missing-Q4.gguf', alias: 'missing' }),
      ).rejects.toThrow(
        "model controller doesn't have missing; add its folder to the controller's model_store",
      );
      expect(fake.leaseRequests).toHaveLength(before);
      expect(fake.active('echo-llm')).toHaveLength(1);
      await b.shutdown();
    });

    it('is what LocalLlmControl.restart() does with the controller in use', async () => {
      const b = bridge();
      await b.start();
      await b.ensureEcho();
      const control = new LocalLlmControl({
        baseUrl: () => 'http://127.0.0.1:1234/v1',
        repoRoot: 'unused',
        logDirectory: 'unused',
        platform: 'win32',
        powershell: vi.fn(),
        launch: vi.fn(),
        model: async () => ({ path: fooPath, alias: 'foo' }),
        viaController: () => b.inUse(),
        useModelViaController: (pick) => b.useEchoModel(pick),
      });
      await expect(control.restart()).resolves.toMatchObject({
        restarted: true,
        message: expect.stringContaining('foo'),
      });
      await vi.waitFor(() => expect(fake.active('echo-llm')[0]?.model).toBe('llm-foo'));
      const missing = new LocalLlmControl({
        baseUrl: () => 'http://127.0.0.1:1234/v1',
        repoRoot: 'unused',
        logDirectory: 'unused',
        model: async () => ({ path: '/nope/Nope.gguf', alias: 'nope' }),
        viaController: () => true,
        useModelViaController: (pick) => b.useEchoModel(pick),
      });
      await expect(missing.restart()).resolves.toMatchObject({
        restarted: false,
        message: expect.stringContaining('model_store'),
      });
      await b.shutdown();
    });
  });

  describe('giving Echo its lease back after a per-use lease', () => {
    const until = async (condition: () => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (!condition() && Date.now() < end)
        await new Promise((resolve) => setTimeout(resolve, 10));
    };

    it('asks again when the first hand-back fails, without waiting for a turn', async () => {
      const b = bridge({ watchMs: 15, echoRetryMs: 30 });
      await b.start();
      await b.ensureEcho();
      const handle = await b.acquire('comfyui');
      expect(fake.active('echo-llm')).toHaveLength(0);
      // The controller refuses echo-llm at the moment ComfyUI lets go (it is busy, or the GPU is wanted).
      fake.refuse.add('echo-llm');
      handle?.done();
      await until(() =>
        logger.warn.mock.calls.some(([message]) =>
          String(message).includes('Could not lease echo-llm again'),
        ),
      );
      expect(fake.active('echo-llm')).toHaveLength(0);
      fake.refuse.delete('echo-llm');
      await until(() => fake.active('echo-llm').length === 1, 4000);
      expect(fake.active('echo-llm')).toHaveLength(1);
      await b.shutdown();
    });

    it('asks again when the controller did not answer its health check at the hand-back', async () => {
      // A busy controller (ComfyUI and a mesh model loading) can miss the client's 2 s health probe. The
      // client then refuses every lease for a minute without sending anything, so no POST is seen.
      let healthDown = false;
      const fetchFn = ((input: string | URL | Request, init?: RequestInit) => {
        if (healthDown && String(input).endsWith('/health'))
          return Promise.reject(new Error('timed out'));
        return fetch(input, init);
      }) as typeof fetch;
      const b = bridge({ watchMs: 15, echoRetryMs: 30, fetchFn });
      await b.start();
      await b.ensureEcho();
      const handle = await b.acquire('comfyui');
      healthDown = true;
      handle?.done();
      await until(() =>
        logger.warn.mock.calls.some(([message]) =>
          String(message).includes('Could not lease echo-llm again'),
        ),
      );
      const posts = fake.leaseRequests.length;
      healthDown = false;
      // The client would refuse for its own minute; the bridge makes it look again.
      await until(() => fake.active('echo-llm').length === 1, 4000);
      expect(fake.leaseRequests.length).toBeGreaterThanOrEqual(posts);
      expect(fake.active('echo-llm')).toHaveLength(1);
      await b.shutdown();
    });

    it('keeps asking for Echo and motion after a wake the controller has not handled yet', async () => {
      const b = bridge({ watchMs: 15, echoRetryMs: 30 });
      await b.start();
      b.setMotionWanted(true);
      await b.ensureEcho();
      await until(() => fake.active('motion').length === 1);
      await b.suspend();
      expect(fake.active('echo-llm')).toHaveLength(0);
      expect(fake.active('motion')).toHaveLength(0);
      // The PC wakes; the controller still says it is going to sleep.
      fake.refuse.add('echo-llm');
      fake.refuse.add('motion');
      await b.resume();
      await until(
        () =>
          logger.warn.mock.calls.filter(([message]) => String(message).includes('after resume'))
            .length >= 2,
      );
      fake.refuse.delete('echo-llm');
      fake.refuse.delete('motion');
      // No turn and no motion request: the bridge asks again by itself.
      await until(
        () => fake.active('echo-llm').length === 1 && fake.active('motion').length === 1,
        4000,
      );
      expect(fake.active('echo-llm')).toHaveLength(1);
      expect(fake.active('motion')).toHaveLength(1);
      await b.shutdown();
    });

    it('asks again when the controller restarted and forgot Echo’s lease', async () => {
      const b = bridge({ watchMs: 15, echoRetryMs: 30 });
      await b.start();
      await b.ensureEcho();
      expect(fake.active('echo-llm')).toHaveLength(1);
      fake.leases.clear(); // the controller restarted: heartbeats now get 404
      await until(() => fake.active('echo-llm').length === 1, 4000);
      expect(fake.active('echo-llm')).toHaveLength(1);
      await b.shutdown();
    });

    it('does not take the GPU back from a game that revoked Echo, nor from a ComfyUI job still running', async () => {
      const b = bridge({ watchMs: 15, echoRetryMs: 30 });
      await b.start();
      await b.ensureEcho();
      fake.revokeAll('game');
      await until(() => b.status().echo === 'paused');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.active('echo-llm')).toHaveLength(0);
      const handle = await b.acquire('comfyui');
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(fake.leaseRequests.filter((request) => request.backend === 'echo-llm')).toHaveLength(
        1,
      );
      handle?.done();
      await b.shutdown();
    });
  });

  it('Echo’s turn says why its model is unloaded while ComfyUI works', async () => {
    const b = bridge();
    await b.start();
    await b.ensureEcho();
    const handle = await b.acquire('comfyui');
    fake.refuse.add('echo-llm');
    await expect(b.ensureEcho()).rejects.toThrow(
      /Echo's model is unloaded while comfyui uses the GPU/,
    );
    fake.refuse.delete('echo-llm');
    handle?.done();
    await b.shutdown();
  });
});
