import { readFileSync } from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { readShellHook } from '../../src/web-satellite/shell-hook.js';

/**
 * The Android app injects a script that sets `window.__AIEMBODIED_SHELL__` (android-room, ProxyMapping.kt). It cannot
 * run here as Kotlin, but the script is plain JavaScript, so this test pulls it out of the Kotlin source and checks it
 * builds the hook the page reads (`readShellHook`) and talks to the native object the way the Kotlin side expects.
 */
const source = readFileSync(
  path.resolve(__dirname, '../../../../android-room/app/src/main/java/com/silarsis/aiembodied/room/ProxyMapping.kt'),
  'utf8',
);
const script = /SHELL_SCRIPT: String = """([\s\S]*?)""".trimIndent\(\)/.exec(source)?.[1] ?? '';

interface FakeNative {
  pairing: () => string;
  foreground: () => boolean;
  reportGate: (json: string) => void;
}

function run(native: FakeNative | undefined): Window {
  const win: Record<string, unknown> = { JSON };
  if (native) win.AiembodiedShell = native;
  win.window = win;
  vm.runInNewContext(script, win);
  return win as unknown as Window;
}

describe('the Android shell script', () => {
  it('was found in the Kotlin source', () => {
    expect(script).toContain('__AIEMBODIED_SHELL__');
  });

  it('sets the pairing the page reads and the phone kind', () => {
    const win = run({
      pairing: () => JSON.stringify({ hubUrl: 'ws://bija:8791', deviceId: 'dev-1', token: 'tok', deviceName: 'Pixel' }),
      foreground: () => true,
      reportGate: () => undefined,
    });
    const hook = readShellHook(win);
    expect(hook).toMatchObject({ hubUrl: 'ws://bija:8791', deviceId: 'dev-1', token: 'tok', deviceName: 'Pixel', kind: 'phone' });
  });

  it('reads the foreground from the shell each time, and anything but true counts as no', () => {
    let value: unknown = true;
    const win = run({ pairing: () => '{}', foreground: () => value as boolean, reportGate: () => undefined });
    const hook = readShellHook(win);
    const foreground = hook?.foreground as () => boolean;
    expect(foreground()).toBe(true);
    value = false;
    expect(foreground()).toBe(false);
    value = 'yes';
    expect(foreground()).toBe(false);
  });

  it('tells the page listeners when the shell says the foreground changed, until they are removed', () => {
    const win = run({ pairing: () => '{}', foreground: () => true, reportGate: () => undefined });
    const hook = readShellHook(win);
    let calls = 0;
    const off = hook?.onForeground?.(() => {
      calls += 1;
    }) as () => void;
    const native = (win as unknown as { __AIEMBODIED_SHELL_NATIVE__: { foregroundChanged: () => void } }).__AIEMBODIED_SHELL_NATIVE__;
    native.foregroundChanged();
    expect(calls).toBe(1);
    off();
    native.foregroundChanged();
    expect(calls).toBe(1);
  });

  it('passes every gate state to the shell as JSON', () => {
    const reports: string[] = [];
    const win = run({ pairing: () => '{}', foreground: () => true, reportGate: (json) => reports.push(json) });
    readShellHook(win)?.onGate?.({ micAllowed: true, cameraAllowed: false, occupied: true } as never);
    expect(JSON.parse(reports[0] ?? '{}')).toEqual({ micAllowed: true, cameraAllowed: false, occupied: true });
  });

  it('survives a shell that throws, failing closed', () => {
    const win = run({
      pairing: () => 'not json',
      foreground: () => {
        throw new Error('gone');
      },
      reportGate: () => {
        throw new Error('gone');
      },
    });
    const hook = readShellHook(win);
    expect(hook?.token).toBeUndefined();
    expect((hook?.foreground as () => boolean)()).toBe(false);
    expect(() => hook?.onGate?.({} as never)).not.toThrow();
  });

  it('sets nothing without the native object', () => {
    expect(readShellHook(run(undefined))).toBeNull();
  });
});
