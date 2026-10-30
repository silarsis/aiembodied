import { describe, expect, it, vi } from 'vitest';
import { PushToTalkShortcut } from '../src/talk/push-to-talk.js';

function createShortcuts(taken: string[] = []) {
  const handlers = new Map<string, () => void>();
  const globalShortcut = {
    register: vi.fn((accelerator: string, callback: () => void) => {
      if (accelerator === 'Nonsense+') {
        throw new Error('conversion failure');
      }
      if (taken.includes(accelerator)) {
        return false;
      }
      handlers.set(accelerator, callback);
      return true;
    }),
    unregister: vi.fn((accelerator: string) => {
      handlers.delete(accelerator);
    }),
  };
  return { globalShortcut, handlers };
}

describe('PushToTalkShortcut', () => {
  it('registers the key and calls onPress when it is pressed', () => {
    const { globalShortcut, handlers } = createShortcuts();
    const onPress = vi.fn();
    const onStatus = vi.fn();
    const shortcut = new PushToTalkShortcut({ globalShortcut, onPress, onStatus });

    expect(shortcut.apply('CommandOrControl+Shift+Space')).toEqual({ shortcut: 'CommandOrControl+Shift+Space', registered: true });
    handlers.get('CommandOrControl+Shift+Space')?.();
    expect(onPress).toHaveBeenCalledTimes(1);
    expect(onStatus).toHaveBeenLastCalledWith({ shortcut: 'CommandOrControl+Shift+Space', registered: true });
  });

  it('swaps keys, keeps a registered one as is, and turns off on an empty shortcut', () => {
    const { globalShortcut, handlers } = createShortcuts();
    const shortcut = new PushToTalkShortcut({ globalShortcut, onPress: vi.fn() });

    shortcut.apply('Ctrl+Shift+Space');
    shortcut.apply('Ctrl+Shift+Space');
    expect(globalShortcut.register).toHaveBeenCalledTimes(1);

    shortcut.apply('Alt+F9');
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Ctrl+Shift+Space');
    expect([...handlers.keys()]).toEqual(['Alt+F9']);

    expect(shortcut.apply('')).toEqual({ shortcut: '', registered: false });
    expect(handlers.size).toBe(0);
  });

  it('reports a key another app holds, or one Electron cannot parse, and retries on the next apply', () => {
    const taken = ['Ctrl+Space'];
    const { globalShortcut } = createShortcuts(taken);
    const warn = vi.fn();
    const shortcut = new PushToTalkShortcut({ globalShortcut, onPress: vi.fn(), logger: { info: vi.fn(), warn } });

    expect(shortcut.apply('Ctrl+Space')).toEqual({
      shortcut: 'Ctrl+Space',
      registered: false,
      error: 'Ctrl+Space is already in use by another app.',
    });
    expect(shortcut.apply('Nonsense+').error).toMatch(/not a valid shortcut/);
    expect(warn).toHaveBeenCalledTimes(2);

    taken.length = 0;
    expect(shortcut.apply('Ctrl+Space')).toEqual({ shortcut: 'Ctrl+Space', registered: true });
  });

  it('releases the key on dispose', () => {
    const { globalShortcut, handlers } = createShortcuts();
    const shortcut = new PushToTalkShortcut({ globalShortcut, onPress: vi.fn() });
    shortcut.apply('Ctrl+Shift+Space');
    shortcut.dispose();
    expect(handlers.size).toBe(0);
    expect(shortcut.getStatus()).toEqual({ shortcut: '', registered: false });
  });
});
