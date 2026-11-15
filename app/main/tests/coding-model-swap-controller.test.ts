import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AicontrollerBridge } from '../src/aicontroller/bridge.js';
import { CoderModelSwap } from '../src/coding/model-swap.js';
import { builtInServers, defaultRoutes, resolveModelRouting } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { FAKE_BACKEND_URLS, FakeAicontroller } from './helpers/fake-aicontroller.js';

describe('CoderModelSwap with the model controller', () => {
  let fake: FakeAicontroller;
  beforeEach(async () => {
    fake = await new FakeAicontroller().start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  async function setup() {
    const logger = { info: vi.fn(), warn: vi.fn() };
    const bridge = new AicontrollerBridge({ logger, env: { AICONTROLLER_URL: fake.url }, watchMs: 0 });
    await bridge.start();
    await bridge.ensureEcho();
    const routing = resolveModelRouting(builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }), defaultRoutes(DEFAULT_PROVIDER_SETTINGS));
    let clock = 1_000_000;
    const echo = { stop: vi.fn(async () => true), start: vi.fn(async () => undefined) };
    const coder = vi.fn(() => ({ stop: vi.fn(async () => true), start: vi.fn(async () => undefined) }));
    const swap = new CoderModelSwap({
      routing: () => routing,
      configuredGguf: () => undefined,
      detectGguf: () => null, // no GGUF on this PC: the controller owns the models
      echo,
      coder,
      controller: bridge,
      isUp: async () => true,
      onOverrideChange: vi.fn(),
      logger,
      platform: 'linux', // not Windows: the controller doesn't care
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
      mode: () => 'auto',
      swapBackMs: 1000,
      tickMs: 0,
      pollMs: 100,
    });
    return { swap, bridge, echo, coder, advance: (ms: number) => void (clock += ms) };
  }

  it('leases coder-llm, chats on its URL, and on swap-back releases it and leases echo-llm again', async () => {
    const { swap, bridge, echo, coder, advance } = await setup();
    expect(fake.active('echo-llm')).toHaveLength(1);

    await swap.setNeeded(true);
    expect(swap.getState().phase).toBe('coder-loaded');
    // The app stopped and started nothing itself; the controller was asked.
    expect(echo.stop).not.toHaveBeenCalled();
    expect(coder).not.toHaveBeenCalled();
    expect(fake.active('coder-llm')).toHaveLength(1);
    expect(fake.active('coder-llm')[0]?.client).toBe('aiembodied');
    expect(fake.active('echo-llm')).toHaveLength(0);
    expect(swap.chatOverride()?.server.url).toBe(FAKE_BACKEND_URLS['coder-llm']);
    expect(bridge.status().line).toContain('coder-llm leased');

    await swap.setNeeded(false);
    advance(2000);
    await swap.tick();
    expect(swap.getState().phase).toBe('idle');
    expect(swap.chatOverride()).toBeNull();
    expect(fake.active('coder-llm')).toHaveLength(0);
    expect(fake.active('echo-llm')).toHaveLength(1);
    expect(echo.start).not.toHaveBeenCalled();
    expect(bridge.echoUrl()).toBe(FAKE_BACKEND_URLS['echo-llm']);
    await bridge.shutdown();
  });

  it('puts Echo back when the controller refuses the coder lease', async () => {
    const { swap, bridge } = await setup();
    fake.refuse.add('coder-llm');
    await swap.setNeeded(true);
    expect(swap.chatOverride()).toBeNull();
    expect(swap.getState().message).toContain('could not lease the coder model');
    expect(fake.active('coder-llm')).toHaveLength(0);
    expect(fake.active('echo-llm')).toHaveLength(1);
    await bridge.shutdown();
  });
});
