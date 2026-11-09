import { describe, expect, it, vi } from 'vitest';
import { builtInServers, defaultRoutes, resolveModelRouting, type StoredModels } from '../src/config/model-routing.js';
import { DEFAULT_PROVIDER_SETTINGS } from '../src/config/provider-settings.js';
import { CoderModelSwap } from '../src/coding/model-swap.js';

const GGUF = 'D:\\models\\Qwen3-Coder-Next-Q4_K_M-00001-of-00003.gguf';
const CODER_URL = 'http://127.0.0.1:1236/v1/models';

function setup(
  options: {
    stored?: StoredModels;
    platform?: string;
    configured?: string;
    detected?: string | null;
    echoRunning?: boolean;
    answering?: () => boolean;
    mode?: 'auto' | 'side-by-side' | 'swap';
    free?: number | null;
    size?: number | null;
    lastActivity?: number | null;
    ownClock?: boolean;
  } = {},
) {
  const routing = resolveModelRouting(
    builtInServers({ providers: DEFAULT_PROVIDER_SETTINGS, comfyUiBaseUrl: 'http://127.0.0.1:8188' }),
    defaultRoutes(DEFAULT_PROVIDER_SETTINGS),
    options.stored,
  );
  let clock = 1_000_000;
  const log: string[] = [];
  // What the coder server does: it answers once started, until stopped.
  let coderUp = false;
  const echo = {
    stop: vi.fn(async () => {
      log.push('echo.stop');
      return options.echoRunning ?? true;
    }),
    start: vi.fn(async () => void log.push('echo.start')),
  };
  const coderControl = {
    stop: vi.fn(async () => {
      log.push('coder.stop');
      coderUp = false;
      return true;
    }),
    start: vi.fn(async () => {
      log.push('coder.start');
      coderUp = true;
    }),
  };
  const coderFactory = vi.fn((_model: unknown, _url: string) => coderControl);
  const onOverrideChange = vi.fn(async () => void log.push('override'));
  const activity = { at: options.lastActivity ?? null };
  const onWaiting = vi.fn();
  const logger = { info: vi.fn(), warn: vi.fn() };
  const swap = new CoderModelSwap({
    routing: () => routing,
    configuredGguf: () => options.configured,
    detectGguf: () => (options.detected === undefined ? GGUF : options.detected),
    echo,
    coder: coderFactory,
    isUp: async (url) => (url === CODER_URL ? (options.answering ? options.answering() : coderUp) : false),
    onOverrideChange,
    logger,
    platform: options.platform ?? 'win32',
    now: () => clock,
    sleep: async (ms) => {
      clock += ms;
    },
    mode: () => options.mode ?? 'swap',
    measureFree: async () => options.free ?? null,
    ggufSize: async () => options.size ?? null,
    ...(options.ownClock ? {} : { lastActivityAt: () => activity.at }),
    onWaiting,
    quietMs: 600_000,
    idleStopMs: 600_000,
    tickMs: 0,
    pollMs: 1000,
    loadTimeoutMs: 60_000,
  });
  return { swap, echo, activity, onWaiting, clock: () => clock, coderControl, coderFactory, onOverrideChange, logger, log, advance: (ms: number) => void (clock += ms), setCoderUp: (up: boolean) => void (coderUp = up) };
}

const GiB = 1024 ** 3;

describe('CoderModelSwap auto mode', () => {
  // A 48 GiB model needs 48 * 1.15 + 4 = 59.2 GiB.
  const size = 48 * GiB;

  it('loads next to Echo’s model when it fits, leaving Echo alone', async () => {
    const { swap, log, echo } = setup({ mode: 'auto', free: 80 * GiB, size });
    await swap.setNeeded(true);
    expect(log).toEqual(['coder.start']);
    expect(echo.stop).not.toHaveBeenCalled();
    expect(swap.chatOverride()).toBeNull();
    expect(swap.getState().phase).toBe('coder-loaded');
  });

  it('loads side by side when the memory cannot be measured', async () => {
    const unknownFree = setup({ mode: 'auto', free: null, size });
    await unknownFree.swap.setNeeded(true);
    expect(unknownFree.log).toEqual(['coder.start']);
    const unknownSize = setup({ mode: 'auto', free: 10 * GiB, size: null });
    await unknownSize.swap.setNeeded(true);
    expect(unknownSize.log).toEqual(['coder.start']);
  });

  it('waits for a quiet moment when it does not fit and Echo was just talked to', async () => {
    const { swap, log, echo, onWaiting, activity, clock, advance } = setup({ mode: 'auto', free: 20 * GiB, size });
    activity.at = clock() - 1000;
    await swap.setNeeded(true);
    expect(swap.getState().phase).toBe('waiting-for-quiet');
    expect(swap.getState().message).toContain('waiting until things are quiet');
    expect(echo.stop).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    advance(60_000);
    await swap.tick();
    expect(swap.getState().phase).toBe('waiting-for-quiet');
    expect(onWaiting).toHaveBeenCalledTimes(1);

    advance(600_000);
    await swap.tick();
    expect(log).toEqual(['echo.stop', 'coder.start', 'override']);
    expect(swap.getState().phase).toBe('coder-loaded');
    expect(swap.chatOverride()?.server.id).toBe('local-coder-llm');
  });

  it('swaps at once when it does not fit and Echo has been quiet', async () => {
    const { swap, log } = setup({ mode: 'auto', free: 20 * GiB, size });
    await swap.setNeeded(true);
    expect(log).toEqual(['echo.stop', 'coder.start', 'override']);
  });

  it('swaps back when Kevin talks to Echo, then waits for quiet while the task needs the model', async () => {
    const { swap, log, echo, activity, clock, advance, onWaiting } = setup({ mode: 'auto', free: 20 * GiB, size });
    await swap.setNeeded(true);
    log.length = 0;
    advance(5000);
    activity.at = clock();
    await swap.tick();
    expect(log).toEqual(['override', 'coder.stop', 'echo.start']);
    expect(echo.start).toHaveBeenCalledTimes(1);
    expect(swap.chatOverride()).toBeNull();
    expect(swap.getState().phase).toBe('waiting-for-quiet');
    expect(onWaiting).toHaveBeenCalledTimes(1);

    advance(600_000);
    await swap.tick();
    expect(swap.getState().phase).toBe('coder-loaded');
    expect(swap.chatOverride()).not.toBeNull();
  });

  it('noteActivity() sends a swapped coder back', async () => {
    const { swap, log, advance } = setup({ mode: 'auto', free: 20 * GiB, size, ownClock: true });
    await swap.setNeeded(true);
    log.length = 0;
    advance(1000);
    await swap.noteActivity();
    expect(log).toEqual(['override', 'coder.stop', 'echo.start']);
    expect(swap.getState().phase).toBe('waiting-for-quiet');
  });

  it('stops waiting when the task no longer needs the model', async () => {
    const { swap, activity, clock } = setup({ mode: 'auto', free: 20 * GiB, size });
    activity.at = clock();
    await swap.setNeeded(true);
    await swap.setNeeded(false);
    expect(swap.getState().phase).toBe('idle');
  });
});

describe('CoderModelSwap', () => {
  it('stops Echo’s model, starts the coder model, and lets Echo’s chat use it', async () => {
    const { swap, coderFactory, log } = setup();
    await swap.setNeeded(true);
    expect(log).toEqual(['echo.stop', 'coder.start', 'override']);
    expect(swap.getState().phase).toBe('coder-loaded');
    expect(coderFactory).toHaveBeenCalledWith({ path: GGUF, alias: 'qwen3-coder-next', contextLength: 65536 }, 'http://127.0.0.1:1236/v1');
    const override = swap.chatOverride();
    expect(override?.server.id).toBe('local-coder-llm');
    expect(override?.model).toBe('qwen3-coder-next');
    expect(override?.exclude).toEqual(['local-llm']);
  });

  it('prefers the file picked on the Coding page and the model name from the route', async () => {
    const { swap, coderFactory } = setup({
      configured: 'E:\\mine.gguf',
      stored: { routes: { coding: { server: 'local-coder-llm', model: 'coder-x' } } },
    });
    await swap.setNeeded(true);
    expect(coderFactory).toHaveBeenCalledWith({ path: 'E:\\mine.gguf', alias: 'coder-x', contextLength: 65536 }, 'http://127.0.0.1:1236/v1');
    expect(swap.chatOverride()?.model).toBe('coder-x');
  });

  it('swaps back only after the model has been unneeded for 120 s', async () => {
    const { swap, log, advance, onOverrideChange } = setup();
    await swap.setNeeded(true);
    log.length = 0;
    await swap.setNeeded(false);
    advance(119_000);
    await swap.tick();
    expect(swap.getState().phase).toBe('coder-loaded');
    expect(log).toEqual([]);
    advance(2000);
    await swap.tick();
    expect(log).toEqual(['override', 'coder.stop', 'echo.start']);
    expect(swap.getState()).toMatchObject({ phase: 'idle' });
    expect(swap.chatOverride()).toBeNull();
    expect(onOverrideChange).toHaveBeenCalledTimes(2);
  });

  it('does not thrash when a new task comes before the 120 s are up', async () => {
    const { swap, echo, coderControl, advance } = setup();
    await swap.setNeeded(true);
    await swap.setNeeded(false);
    advance(100_000);
    await swap.tick();
    await swap.setNeeded(true);
    advance(300_000);
    await swap.tick();
    expect(swap.getState().phase).toBe('coder-loaded');
    expect(echo.stop).toHaveBeenCalledTimes(1);
    expect(coderControl.start).toHaveBeenCalledTimes(1);
    expect(coderControl.stop).not.toHaveBeenCalled();
    // The idle time starts over each time the model stops being needed.
    await swap.setNeeded(false);
    advance(119_000);
    await swap.tick();
    expect(swap.getState().phase).toBe('coder-loaded');
  });

  it('runs quick changes of mind one after another', async () => {
    const { swap, log, advance } = setup();
    const first = swap.setNeeded(true);
    const second = swap.setNeeded(false);
    const third = swap.setNeeded(true);
    await Promise.all([first, second, third]);
    advance(10 * 60_000);
    await swap.tick();
    expect(log).toEqual(['echo.stop', 'coder.start', 'override']);
    expect(swap.getState().phase).toBe('coder-loaded');
  });

  it.each([
    ['not Windows', { platform: 'linux' }],
    ['the coding model is OpenAI', { stored: { routes: { coding: { server: 'openai', model: 'gpt-5' } } } as StoredModels }],
    ['the coder model server is on another PC', { stored: { servers: [{ id: 'local-coder-llm', url: 'http://192.168.1.9:1236/v1' }] } as StoredModels }],
  ])('does nothing when %s', async (_name, options) => {
    const { swap, echo, coderFactory } = setup(options);
    await swap.setNeeded(true);
    expect(echo.stop).not.toHaveBeenCalled();
    expect(coderFactory).not.toHaveBeenCalled();
    expect(swap.getState().phase).toBe('idle');
    expect(swap.chatOverride()).toBeNull();
  });

  it('says so, and leaves Echo’s model running, when no GGUF can be found', async () => {
    const { swap, echo, coderFactory } = setup({ detected: null });
    await swap.setNeeded(true);
    expect(echo.stop).not.toHaveBeenCalled();
    expect(coderFactory).not.toHaveBeenCalled();
    expect(swap.getState().phase).toBe('idle');
    expect(swap.getState().message).toContain('No Qwen3-Coder-Next GGUF found');
  });

  it('uses a coder server that already answers, and leaves it running afterwards', async () => {
    const { swap, coderControl, echo, advance } = setup({ answering: () => true });
    await swap.setNeeded(true);
    expect(coderControl.start).not.toHaveBeenCalled();
    expect(swap.getState().phase).toBe('coder-loaded');
    await swap.setNeeded(false);
    advance(121_000);
    await swap.tick();
    expect(coderControl.stop).not.toHaveBeenCalled();
    expect(echo.start).toHaveBeenCalledTimes(1);
  });

  it('starts Echo’s model again only if it was the one that stopped it', async () => {
    const notRunning = setup({ echoRunning: false });
    await notRunning.swap.setNeeded(true);
    expect(notRunning.swap.chatOverride()?.exclude).toEqual([]);
    await notRunning.swap.setNeeded(false);
    notRunning.advance(121_000);
    await notRunning.swap.tick();
    expect(notRunning.echo.start).not.toHaveBeenCalled();
    expect(notRunning.coderControl.stop).toHaveBeenCalledTimes(1);

    // Echo’s chat is on another server (OpenAI): its llama-server is not ours to stop.
    const remote = setup({ stored: { routes: { llm: { server: 'openai', model: 'gpt-4.1' } } } });
    await remote.swap.setNeeded(true);
    expect(remote.echo.stop).not.toHaveBeenCalled();
    expect(remote.swap.getState().phase).toBe('coder-loaded');
    await remote.swap.setNeeded(false);
    remote.advance(121_000);
    await remote.swap.tick();
    expect(remote.echo.start).not.toHaveBeenCalled();
  });

  it('gives Echo’s model back when the coder model does not start in time', async () => {
    const { swap, coderControl, echo, log } = setup({ answering: () => false });
    await swap.setNeeded(true);
    expect(swap.getState()).toMatchObject({ phase: 'idle', message: expect.stringContaining('did not start') });
    expect(coderControl.stop).toHaveBeenCalledTimes(1);
    expect(echo.start).toHaveBeenCalledTimes(1);
    expect(swap.chatOverride()).toBeNull();
    expect(log.indexOf('coder.stop')).toBeLessThan(log.indexOf('echo.start'));
  });

  it('starts the coder model again if it stops answering while it is needed', async () => {
    const { swap, coderControl, echo, setCoderUp } = setup();
    await swap.setNeeded(true);
    setCoderUp(false);
    await swap.tick();
    expect(swap.getState().phase).toBe('coder-loaded');
    await swap.tick();
    expect(coderControl.start).toHaveBeenCalledTimes(2);
    expect(swap.getState().phase).toBe('coder-loaded');
    // Echo’s model is still ours to restore afterwards.
    await swap.setNeeded(false);
    swap.stop();
    expect(echo.start).not.toHaveBeenCalled();
  });

  it('logs every transition', async () => {
    const { swap, logger } = setup();
    await swap.setNeeded(true);
    const phases = logger.info.mock.calls.filter(([message]) => message === 'Coder model swap.').map(([, data]) => (data as { phase: string }).phase);
    expect(phases).toEqual(['swapping-in', 'swapping-in', 'coder-loaded']);
  });

  describe('side by side', () => {
    it('starts the coder model without touching Echo’s model or the chat override', async () => {
      const { swap, echo, coderFactory, coderControl, onOverrideChange } = setup({ mode: 'side-by-side' });
      await swap.setNeeded(true);
      expect(echo.stop).not.toHaveBeenCalled();
      expect(coderControl.start).toHaveBeenCalledTimes(1);
      expect(coderFactory).toHaveBeenCalledWith({ path: GGUF, alias: 'qwen3-coder-next', contextLength: 65536 }, 'http://127.0.0.1:1236/v1');
      expect(swap.chatOverride()).toBeNull();
      expect(onOverrideChange).not.toHaveBeenCalled();
      expect(swap.getState()).toMatchObject({ phase: 'coder-loaded', message: 'The coder model is loaded next to Echo’s.' });
    });

    it('stops the coder model only after idleStopMs, and never starts Echo’s', async () => {
      const { swap, echo, coderControl, advance } = setup({ mode: 'side-by-side' });
      await swap.setNeeded(true);
      await swap.setNeeded(false);
      advance(599_000);
      await swap.tick();
      expect(swap.getState().phase).toBe('coder-loaded');
      expect(coderControl.stop).not.toHaveBeenCalled();
      advance(2000);
      await swap.tick();
      expect(coderControl.stop).toHaveBeenCalledTimes(1);
      expect(swap.getState()).toMatchObject({ phase: 'idle', message: 'Not needed now; the coder model was stopped to free memory.' });
      expect(echo.stop).not.toHaveBeenCalled();
      expect(echo.start).not.toHaveBeenCalled();
      expect(swap.chatOverride()).toBeNull();
    });

    it('does not stop a coder server it did not start', async () => {
      const { swap, coderControl, advance } = setup({ mode: 'side-by-side', answering: () => true });
      await swap.setNeeded(true);
      await swap.setNeeded(false);
      advance(601_000);
      await swap.tick();
      expect(coderControl.start).not.toHaveBeenCalled();
      expect(coderControl.stop).not.toHaveBeenCalled();
      expect(swap.getState().phase).toBe('idle');
    });

    it('restarts the coder model if it stops answering, and leaves Echo’s alone when a load fails', async () => {
      const { swap, coderControl, echo, setCoderUp } = setup({ mode: 'side-by-side' });
      await swap.setNeeded(true);
      setCoderUp(false);
      await swap.tick();
      await swap.tick();
      expect(coderControl.start).toHaveBeenCalledTimes(2);
      expect(swap.getState().phase).toBe('coder-loaded');

      const failing = setup({ mode: 'side-by-side', answering: () => false });
      await failing.swap.setNeeded(true);
      expect(failing.swap.getState().message).toContain('did not start');
      expect(failing.coderControl.stop).toHaveBeenCalledTimes(1);
      expect(failing.echo.stop).not.toHaveBeenCalled();
      expect(failing.echo.start).not.toHaveBeenCalled();
      expect(echo.stop).not.toHaveBeenCalled();
    });
  });
});
