import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MOTION_TRACE_STORAGE_KEY,
  SETTLE_RETRY_STORAGE_KEY,
  flushMotionTrace,
  getMotionTraceSetting,
  initMotionTrace,
  isMotionTraceEnabled,
  isSettleRetryEnabled,
  setMotionTraceActive,
  setMotionTraceSetting,
  setMotionTraceTransport,
  setSettleRetryEnabled,
  trace,
  type MotionTraceTransport,
} from '../../src/rooms/motion-trace.js';

describe('motion trace', () => {
  let transport: { append: ReturnType<typeof vi.fn>; configure: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    window.localStorage.clear();
    transport = { append: vi.fn(), configure: vi.fn(async (on: boolean) => on) };
    setMotionTraceTransport(transport as unknown as MotionTraceTransport);
    setMotionTraceActive(false);
  });

  afterEach(() => {
    setMotionTraceActive(false);
    setMotionTraceTransport(undefined);
  });

  it('does not run the builder or send anything while off', () => {
    const build = vi.fn(() => ({ a: 1 }));
    trace('echo', 'contact', build);
    flushMotionTrace();
    expect(build).not.toHaveBeenCalled();
    expect(transport.append).not.toHaveBeenCalled();
  });

  it('batches lines with ts, t, avatar and kind', () => {
    setMotionTraceActive(true);
    trace('echo', 'plan', () => ({ label: 'sit on sofa' }));
    trace('rex', 'stream.chunk', () => ({ index: 0 }));
    expect(transport.append).not.toHaveBeenCalled();
    flushMotionTrace();
    const lines = transport.append.mock.calls[0]![0] as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ avatar: 'echo', kind: 'plan', label: 'sit on sofa' });
    expect(typeof lines[0]!.ts).toBe('string');
    expect(typeof lines[0]!.t).toBe('number');
    expect(lines[1]).toMatchObject({ avatar: 'rex', kind: 'stream.chunk', index: 0 });
  });

  it('turns on from the setting and follows what the main process answers', async () => {
    await setMotionTraceSetting(true);
    expect(getMotionTraceSetting()).toBe(true);
    expect(window.localStorage.getItem(MOTION_TRACE_STORAGE_KEY)).toBe('1');
    expect(isMotionTraceEnabled()).toBe(true);
    await setMotionTraceSetting(false);
    expect(isMotionTraceEnabled()).toBe(false);
    // The environment variable wins in the main process.
    transport.configure.mockResolvedValue(true);
    await initMotionTrace();
    expect(isMotionTraceEnabled()).toBe(true);
  });

  it('keeps the settle retry switch, off by default (only "1" means on)', () => {
    expect(isSettleRetryEnabled()).toBe(false);
    setSettleRetryEnabled(true);
    expect(isSettleRetryEnabled()).toBe(true);
    expect(window.localStorage.getItem(SETTLE_RETRY_STORAGE_KEY)).toBe('1');
    setSettleRetryEnabled(false);
    expect(isSettleRetryEnabled()).toBe(false);
    expect(window.localStorage.getItem(SETTLE_RETRY_STORAGE_KEY)).toBeNull();
  });
});
