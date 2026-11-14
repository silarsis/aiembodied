import { describe, expect, it, vi } from 'vitest';
import { PageActivity } from '../../src/web-satellite/page-activity.js';

function setup(options: { foreground?: boolean; linkUp?: boolean } = {}) {
  const state = { now: 1_000_000, foreground: options.foreground ?? true, linkUp: options.linkUp ?? true };
  const sent: number[] = [];
  let tick: (() => void) | null = null;
  const clear = vi.fn();
  const activity = new PageActivity({
    isForeground: () => state.foreground,
    send: (at) => {
      if (!state.linkUp) return false;
      sent.push(at);
      return true;
    },
    now: () => state.now,
    setInterval: (fn) => {
      tick = fn;
      return 7;
    },
    clearInterval: clear,
  });
  return { state, sent, activity, tick: () => tick?.(), clear };
}

describe('PageActivity', () => {
  it('reports at start while the page is in the foreground, then on every 15 second tick', () => {
    const { activity, sent, state, tick } = setup();
    activity.start();
    expect(sent).toEqual([1_000_000]);
    state.now += 15_000;
    tick();
    expect(sent).toEqual([1_000_000, 1_015_000]);
  });

  it('counts a touch or key, throttled to one report per 15 seconds', () => {
    const { activity, sent, state } = setup();
    activity.note();
    state.now += 5_000;
    activity.note();
    activity.note();
    expect(sent).toHaveLength(1);
    state.now += 10_000;
    activity.note();
    expect(sent).toHaveLength(2);
  });

  it('says nothing while the page is hidden, and reports as soon as it comes back', () => {
    const { activity, sent, state, tick } = setup({ foreground: false });
    activity.start();
    tick();
    activity.note();
    expect(sent).toEqual([]);
    state.foreground = true;
    state.now += 1_000;
    activity.note();
    expect(sent).toEqual([1_001_000]);
  });

  it('tries again at once when the link was down, and stops its timer', () => {
    const { activity, sent, state, clear } = setup({ linkUp: false });
    activity.note();
    expect(sent).toEqual([]);
    state.linkUp = true;
    state.now += 1_000;
    activity.note();
    expect(sent).toEqual([1_001_000]);
    activity.start();
    activity.stop();
    expect(clear).toHaveBeenCalledWith(7);
  });
});
