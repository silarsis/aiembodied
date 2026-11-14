import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FULLSCREEN_POLL_MS, FullscreenWatcher, encodeScript, type SpawnLike } from '../../src/satellite/fullscreen-watch.js';

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  written: string[] = [];
  stdin = { write: (text: string) => void this.written.push(text), end: vi.fn() };
  kill = vi.fn();
  say(text: string) {
    this.stdout.emit('data', Buffer.from(text));
  }
}

function setup(platform: NodeJS.Platform = 'win32') {
  const children: FakeChild[] = [];
  const spawn = vi.fn((_command: string, _args: string[]) => {
    const child = new FakeChild();
    children.push(child);
    return child as unknown as ReturnType<SpawnLike>;
  });
  const seen: boolean[] = [];
  const watcher = new FullscreenWatcher({ platform, spawn: spawn as unknown as SpawnLike, onChange: (value) => seen.push(value), ownPid: 4242 });
  return { watcher, spawn, children, seen };
}

describe('FullscreenWatcher', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('always says "no full-screen app" away from Windows, and starts nothing', () => {
    const { watcher, spawn, seen } = setup('linux');
    watcher.start();
    expect(seen).toEqual([true]);
    expect(spawn).not.toHaveBeenCalled();
    watcher.stop();
  });

  it('starts one PowerShell process with our pid, and counts as full screen until it answers', () => {
    const { watcher, spawn, children, seen } = setup();
    watcher.start();
    expect(seen).toEqual([false]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args).toContain('-EncodedCommand');
    expect((spawn.mock.calls[0] as unknown as [string, string[], { env: NodeJS.ProcessEnv }])[2].env.AIEMBODIED_PID).toBe('4242');
    children[0].say('ready\n');
    // The first poll goes out as soon as the helper is ready.
    expect(children[0].written).toEqual(['\n']);
    children[0].say('0\n');
    expect(seen).toEqual([false, true]);
  });

  it('writes one line per poll and follows the answers', () => {
    const { watcher, children, seen } = setup();
    watcher.start();
    children[0].say('ready\n0\n');
    vi.advanceTimersByTime(FULLSCREEN_POLL_MS);
    expect(children[0].written).toHaveLength(2);
    children[0].say('1\n');
    expect(seen).toEqual([false, true, false]);
    vi.advanceTimersByTime(FULLSCREEN_POLL_MS);
    children[0].say('0');
    children[0].say('\n');
    expect(seen).toEqual([false, true, false, true]);
  });

  it('does not write a new line while the last one is unanswered, and fails closed when the helper is stuck', () => {
    const { watcher, children, seen } = setup();
    watcher.start();
    children[0].say('ready\n0\n');
    vi.advanceTimersByTime(FULLSCREEN_POLL_MS);
    expect(children[0].written).toHaveLength(2);
    vi.advanceTimersByTime(FULLSCREEN_POLL_MS);
    expect(children[0].written).toHaveLength(2);
    expect(seen.at(-1)).toBe(true);
    vi.advanceTimersByTime(FULLSCREEN_POLL_MS);
    expect(seen.at(-1)).toBe(false);
  });

  it('fails closed when the helper dies, and starts it again later', () => {
    const { watcher, spawn, children, seen } = setup();
    watcher.start();
    children[0].say('ready\n0\n');
    expect(seen.at(-1)).toBe(true);
    children[0].emit('exit', 1);
    expect(seen.at(-1)).toBe(false);
    vi.advanceTimersByTime(10_000);
    expect(spawn).toHaveBeenCalledTimes(2);
    children[1].say('ready\n0\n');
    expect(seen.at(-1)).toBe(true);
  });

  it('stops the helper', () => {
    const { watcher, children, spawn } = setup();
    watcher.start();
    watcher.stop();
    expect(children[0].kill).toHaveBeenCalled();
    children[0].emit('exit', 0);
    vi.advanceTimersByTime(60_000);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it('encodes the script as UTF-16 base64 for -EncodedCommand', () => {
    expect(Buffer.from(encodeScript('Hi'), 'base64').toString('utf16le')).toBe('Hi');
  });
});
