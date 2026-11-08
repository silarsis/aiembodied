import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildStopCommand, ServerManager } from '../src/server/server-manager.js';

const logger = { info: vi.fn(), warn: vi.fn(), debug: vi.fn() };

describe('ServerManager', () => {
  it('stops every server with a pid file, in one PowerShell call, on quit and on hibernate', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pids-'));
    const missing = path.join(dir, 'nope');
    const powershell = vi.fn(async () => 'stopped:llm\r\ncontainer:aiembodied-memory-db\r\n');
    const manager = new ServerManager({ logger, pidDirectories: [dir, missing], platform: 'win32', powershell });

    await expect(manager.stopAll()).resolves.toEqual(['stopped:llm', 'container:aiembodied-memory-db']);
    await manager.shutdown();
    await manager.hibernate();
    expect(powershell).toHaveBeenCalledTimes(3);
    const [command] = powershell.mock.calls[0] as unknown as [string];
    // Only folders that exist are searched.
    expect(command).toContain(`'${dir}'`);
    expect(command).not.toContain(missing);
  });

  it('runs one stop at a time when quit and suspend overlap', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pids-'));
    let finish: (value: string) => void = () => undefined;
    const powershell = vi.fn(() => new Promise<string>((resolve) => (finish = resolve)));
    const manager = new ServerManager({ logger, pidDirectories: [dir], platform: 'win32', powershell });
    const first = manager.shutdown();
    const second = manager.suspend();
    finish('stopped:speech');
    await Promise.all([first, second]);
    expect(powershell).toHaveBeenCalledTimes(1);
  });

  it('does nothing off Windows, or when no folder exists', async () => {
    const powershell = vi.fn(async () => '');
    const dir = mkdtempSync(path.join(tmpdir(), 'pids-'));
    await new ServerManager({ logger, pidDirectories: [dir], platform: 'linux', powershell }).stopAll();
    await new ServerManager({ logger, pidDirectories: [path.join(dir, 'gone')], platform: 'win32', powershell }).stopAll();
    expect(powershell).not.toHaveBeenCalled();
  });

  it('reports a failed stop without throwing', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'pids-'));
    mkdirSync(dir, { recursive: true });
    const powershell = vi.fn(async () => {
      throw new Error('timed out');
    });
    const manager = new ServerManager({ logger, pidDirectories: [dir], platform: 'win32', powershell });
    await expect(manager.shutdown()).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith('ServerManager: stopping local servers failed', { message: 'timed out' });
  });

  it('only kills a pid that started before its pid file, and stops the service containers', () => {
    const command = buildStopCommand(["C:\\it's\\logs"]);
    expect(command).toContain("'C:\\it''s\\logs'");
    expect(command).toContain('$process.StartTime -le $file.LastWriteTime.AddSeconds(5)');
    expect(command).toContain('taskkill.exe /PID $id /T /F');
    expect(command).toContain("'memory' = 'aiembodied-memory-db'");
    expect(command).toContain("'searxng' = 'aiembodied-searxng'");
    expect(command).toContain('Remove-Item -LiteralPath $file.FullName -Force');
  });
});
