import { describe, expect, it, vi } from 'vitest';
import { createBridge } from '../../src/shared/bridge/create-bridge.js';
import { channelKind } from '../../src/shared/satellite/channels.js';

describe('the pursuits bridge', () => {
  function bridge() {
    const invoke = vi.fn().mockResolvedValue([]);
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const api = createBridge({
      invoke,
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return () => listeners.delete(channel);
      },
    });
    return { api, invoke, listeners };
  }

  it("starts a session, lists the offers, who is reading, and a character's notes through IPC", async () => {
    const { api, invoke } = bridge();
    await api.pursuits?.start('sage', 'station-1');
    expect(invoke).toHaveBeenLastCalledWith('pursuits:start', 'sage', 'station-1');
    await api.pursuits?.offers();
    expect(invoke).toHaveBeenLastCalledWith('pursuits:offers');
    await api.pursuits?.running();
    expect(invoke).toHaveBeenLastCalledWith('pursuits:running');
    await api.pursuits?.notes('sage', 10);
    expect(invoke).toHaveBeenLastCalledWith('pursuits:notes', 'sage', 10);
    await api.pursuits?.stop?.('sage');
    expect(invoke).toHaveBeenLastCalledWith('pursuits:stop', 'sage');
  });

  it('hears who is reading', () => {
    const { api, listeners } = bridge();
    const heard: string[][] = [];
    const stop = api.pursuits?.onChanged((running) => heard.push(running));
    listeners.get('pursuits:changed')?.(['sage']);
    expect(heard).toEqual([['sage']]);
    stop?.();
    expect(listeners.has('pursuits:changed')).toBe(false);
  });

  it('is decided for a satellite: start, offers and running go to bija; the notes stay on bija', () => {
    expect(channelKind('pursuits:start')).toBe('forward');
    expect(channelKind('pursuits:offers')).toBe('forward');
    expect(channelKind('pursuits:running')).toBe('forward');
    expect(channelKind('pursuits:changed')).toBe('event');
    expect(channelKind('pursuits:notes')).toBe('unavailable');
  });
});
