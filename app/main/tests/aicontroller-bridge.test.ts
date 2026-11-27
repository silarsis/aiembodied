import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AicontrollerBridge,
  echoRouteOverride,
  parseControllerMode,
} from '../src/aicontroller/bridge.js';
import {
  builtInServers,
  defaultRoutes,
  resolveModelRouting,
  routeTargetsWithOverride,
} from '../src/shared/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/shared/config/provider-settings.js';
import { FAKE_BACKEND_URLS, FakeAicontroller } from './helpers/fake-aicontroller.js';

const logger = { info: vi.fn(), warn: vi.fn() };

describe('AicontrollerBridge', () => {
  let fake: FakeAicontroller;
  beforeEach(async () => {
    fake = await new FakeAicontroller().start();
    vi.clearAllMocks();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const bridge = (
    env: Record<string, string | undefined> = {},
    extra: { onChange?: () => void; leaseWaitS?: number } = {},
  ) =>
    new AicontrollerBridge({
      logger,
      env: { AICONTROLLER_URL: fake.url, ...env },
      watchMs: 0,
      ...extra,
    });

  it('parses AICONTROLLER_ENABLED', () => {
    expect(parseControllerMode(undefined)).toBe('auto');
    expect(parseControllerMode('auto')).toBe('auto');
    expect(parseControllerMode('1')).toBe('required');
    expect(parseControllerMode('0')).toBe('off');
    expect(new AicontrollerBridge({ logger, env: {} }).url).toBe('http://127.0.0.1:8200');
  });

  it('uses the controller when it answers, and holds an echo-llm lease for client aiembodied', async () => {
    const b = bridge();
    expect(b.echoWaiting()).toBe(false); // not started: nothing to wait for
    await b.start();
    await b.ensureEcho();
    expect(b.echoWaiting()).toBe(false);
    expect(b.inUse()).toBe(true);
    expect(fake.active('echo-llm')).toHaveLength(1);
    expect(fake.active('echo-llm')[0]?.client).toBe('aiembodied');
    // Echo's chat base URL comes from the lease.
    expect(b.echoUrl()).toBe(FAKE_BACKEND_URLS['echo-llm']);
    const routing = resolveModelRouting(
      builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://x' }),
      defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
    );
    const override = echoRouteOverride(routing, b.echoUrl());
    expect(routeTargetsWithOverride(routing, 'llm', override)[0]?.server.url).toBe(
      FAKE_BACKEND_URLS['echo-llm'],
    );
    expect(b.status().line).toContain('echo-llm leased');
    await b.shutdown();
  });

  it('falls back in auto when the controller does not answer, and leases nothing', async () => {
    const dead = fake.url;
    await fake.stop();
    const b = new AicontrollerBridge({ logger, env: { AICONTROLLER_URL: dead }, watchMs: 0 });
    await b.start();
    await b.ensureEcho();
    expect(b.inUse()).toBe(false);
    expect(b.echoUrl()).toBeNull();
    expect(b.status().line).toContain('not running');
    fake = await new FakeAicontroller().start(); // so afterEach has something to stop
  });

  it('never uses the controller when AICONTROLLER_ENABLED=0', async () => {
    const b = bridge({ AICONTROLLER_ENABLED: '0' });
    await b.start();
    expect(b.inUse()).toBe(false);
    expect(fake.requests).toEqual([]);
  });

  it('requires the controller with AICONTROLLER_ENABLED=1: turns fail while it is down', async () => {
    const dead = fake.url;
    await fake.stop();
    const b = new AicontrollerBridge({
      logger,
      env: { AICONTROLLER_URL: dead, AICONTROLLER_ENABLED: '1' },
      watchMs: 0,
    });
    await b.start();
    expect(b.inUse()).toBe(true);
    await expect(b.ensureEcho()).rejects.toThrow(/model controller/);
    fake = await new FakeAicontroller().start();
  });

  it('releases the lease on quit and on suspend, and leases again on resume', async () => {
    const b = bridge();
    await b.start();
    await b.ensureEcho();
    await b.suspend();
    expect(fake.active('echo-llm')).toHaveLength(0);
    expect(b.echoUrl()).toBeNull();
    await b.ensureEcho(); // asleep: nothing is asked for
    expect(fake.active('echo-llm')).toHaveLength(0);
    await b.resume();
    await b.ensureEcho();
    expect(fake.active('echo-llm')).toHaveLength(1);
    await b.shutdown();
    expect(fake.active('echo-llm')).toHaveLength(0);
    expect([...fake.leases.values()].every((lease) => lease.state !== 'ready')).toBe(true);
  });

  it('shows a revoked lease as paused and leases again before the next turn', async () => {
    const onChange = vi.fn();
    const b = bridge({}, { onChange });
    await b.start();
    await b.ensureEcho();
    fake.revokeAll('GPU needed by game.exe');
    // The heartbeat finds out; the bridge's watch then reports it.
    await vi.waitFor(() => {
      b.check();
      expect(b.status().echo).toBe('paused');
    });
    expect(b.status().line).toContain(
      'Local LLM paused by the model controller (GPU needed by game.exe).',
    );
    expect(b.echoUrl()).toBeNull();
    await b.ensureEcho();
    expect(b.status().echo).toBe('leased');
    expect(fake.active('echo-llm')).toHaveLength(1);
    expect(fake.leases.size).toBe(2);
    await b.shutdown();
  });

  it('fails the turn with the pause reason when leasing again fails', async () => {
    const b = bridge();
    await b.start();
    await b.ensureEcho();
    fake.revokeAll('GPU needed by game.exe');
    fake.refuse.add('echo-llm');
    await vi.waitFor(() => {
      b.check();
      expect(b.status().echo).toBe('paused');
    });
    await expect(b.ensureEcho()).rejects.toThrow(
      /Local LLM paused by the model controller \(GPU needed by game.exe\)/,
    );
    await b.shutdown();
  });

  it('gives Echo’s lease up for the coder lease and takes it back after', async () => {
    const b = bridge();
    await b.start();
    await b.ensureEcho();
    const { url } = await b.leaseCoder();
    expect(url).toBe(FAKE_BACKEND_URLS['coder-llm']);
    expect(fake.active('echo-llm')).toHaveLength(0);
    expect(fake.active('coder-llm')).toHaveLength(1);
    await b.ensureEcho(); // chat is on the coder: Echo's lease is not asked for
    expect(fake.active('echo-llm')).toHaveLength(0);
    await b.releaseCoder();
    await b.leaseEcho();
    expect(fake.active('coder-llm')).toHaveLength(0);
    expect(fake.active('echo-llm')).toHaveLength(1);
    await b.shutdown();
  });

  describe('a lease queued at the controller', () => {
    const until = async (cond: () => boolean) => {
      for (let i = 0; i < 100 && !cond(); i++)
        await new Promise((resolve) => setTimeout(resolve, 10));
      expect(cond()).toBe(true);
    };

    it('is dropped when the app suspends or quits, and does not delay start()', async () => {
      fake.hold.add('motion');
      const b = bridge();
      await b.start();
      b.setMotionWanted(true);
      await until(() => fake.live('motion').length === 1);
      expect(fake.live('motion')[0].state).toBe('queued');
      await b.ensureMotion(); // returns at once instead of waiting for the queue
      await b.ensureEcho();
      expect(fake.active('echo-llm')).toHaveLength(1);
      await b.shutdown();
      await until(() => fake.live('motion').length === 0);
      expect(fake.live('echo-llm')).toHaveLength(0);
    });

    it('is asked for again after resume', async () => {
      fake.hold.add('motion');
      const b = bridge();
      await b.start();
      b.setMotionWanted(true);
      await until(() => fake.live('motion').length === 1);
      await b.suspend();
      await until(() => fake.live('motion').length === 0);
      fake.hold.delete('motion');
      await b.resume();
      await until(() => fake.active('motion').length === 1);
      await b.shutdown();
      expect(fake.live('motion')).toHaveLength(0);
    });

    it('is deleted when the controller answers that it is still queued', async () => {
      fake.stillQueued.add('motion');
      const b = bridge({}, { leaseWaitS: 0.2 });
      await b.start();
      b.setMotionWanted(true);
      await until(() => fake.requests.some((r) => r.startsWith('DELETE /v1/leases/')));
      expect(fake.live('motion')).toHaveLength(0);
      await b.shutdown();
    });

    it('says motion waits for memory once it has taken a while', async () => {
      fake.hold.add('motion');
      const b = bridge();
      await b.start();
      b.setMotionWanted(true);
      await until(() => fake.live('motion').length === 1);
      vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);
      expect(b.status().line).toContain('motion waiting for memory on the controller');
      vi.restoreAllMocks();
      await b.shutdown();
    });
  });
});
