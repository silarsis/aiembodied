import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ComfyUIRuntime } from '../src/avatar/generation/comfyui-runtime.js';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn }));
let directory: string;
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "comfy's launcher "));
  await Promise.all(
    ['main.py', 'python.exe', 'models.yaml'].map((file) =>
      writeFile(path.join(directory, file), 'fixture'),
    ),
  );
  spawn.mockReset();
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
function setup() {
  const client = {
    baseUrl: 'http://127.0.0.1:8188',
    isAvailable: vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true),
  };
  const logDirectory = path.join(directory, 'logs');
  const runtime = new ComfyUIRuntime({
    client,
    platform: 'win32',
    logDirectory,
    env: {
      COMFYUI_DIR: directory,
      COMFYUI_PYTHON: path.join(directory, 'python.exe'),
      COMFYUI_MODEL_PATHS: path.join(directory, 'models.yaml'),
      AIEMBODIED_HOST_APPDATA: 'host-appdata',
    },
  });
  return { runtime, client, logDirectory };
}
describe('Windows ComfyUI launcher', () => {
  it('does not create pipes that the background service can keep open, then polls server readiness', async () => {
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit('close', 0));
      return child;
    });
    const { runtime, client } = setup();
    await Promise.all([runtime.ensureReady(), runtime.ensureReady()]);
    expect(spawn).toHaveBeenCalledTimes(1);
    const [file, args, options] = spawn.mock.calls[0];
    expect(file).toBe('powershell.exe');
    expect(options).toMatchObject({
      stdio: 'ignore',
      windowsHide: true,
      timeout: 30_000,
      env: { APPDATA: 'host-appdata' },
    });
    expect(options.detached).not.toBe(true);
    const command = Buffer.from(args[args.indexOf('-EncodedCommand') + 1], 'base64').toString(
      'utf16le',
    );
    expect(command).toContain("$ErrorActionPreference = 'Stop'");
    expect(command).toContain("$ProgressPreference = 'SilentlyContinue'");
    expect(command).toContain('-WindowStyle Hidden');
    expect(command).toContain(directory.replaceAll("'", "''"));
    expect(command).toContain('--extra-model-paths-config');
    expect(client.isAvailable).toHaveBeenCalledTimes(2);
  });
  it('returns a concise launch error rather than an encoded command or CLIXML', async () => {
    const { runtime, logDirectory } = setup();
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      void writeFile(
        path.join(logDirectory, 'comfyui-startup.err.log'),
        '\uFEFFAccess to the executable was denied.',
      ).then(() => child.emit('close', 1));
      return child;
    });
    await expect(runtime.ensureReady()).rejects.toThrow(
      'ComfyUI could not be started: Access to the executable was denied.',
    );
    expect(await readFile(path.join(logDirectory, 'comfyui-startup.err.log'), 'utf8')).toContain(
      'denied',
    );
  });
  it('handles a missing PowerShell executable without leaking its command arguments', async () => {
    spawn.mockImplementation(() => {
      const child = new EventEmitter();
      queueMicrotask(() =>
        child.emit('error', new Error('spawn ENOENT -EncodedCommand private-payload')),
      );
      return child;
    });
    const { runtime } = setup();
    const attempt = runtime.ensureReady();
    await expect(attempt).rejects.toThrow('Windows could not launch ComfyUI');
    await expect(attempt).rejects.not.toThrow(/EncodedCommand|private-payload|CLIXML/);
  });
});
