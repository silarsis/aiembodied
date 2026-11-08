import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLlmControl, type LocalLlmControlOptions } from '../src/local-voice/local-llm-control.js';

const folders: string[] = [];
afterEach(async () => {
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function control(overrides: Partial<LocalLlmControlOptions> = {}, withScript = true) {
  const repoRoot = await mkdtemp(path.join(tmpdir(), 'llm-control-'));
  folders.push(repoRoot);
  if (withScript) {
    await mkdir(path.join(repoRoot, 'scripts'));
    await writeFile(path.join(repoRoot, 'scripts', 'start-local-llm.ps1'), '');
  }
  const powershell = vi.fn(async () => 'stopped\r\n');
  const launch = vi.fn();
  const llm = new LocalLlmControl({
    baseUrl: () => 'http://127.0.0.1:1234/v1',
    repoRoot,
    logDirectory: path.join(repoRoot, 'logs'),
    platform: 'win32',
    powershell,
    launch,
    ...overrides,
  });
  return { llm, powershell, launch };
}

describe('LocalLlmControl', () => {
  it('stops only llama-server on the configured port', async () => {
    const { llm, powershell } = await control();
    await expect(llm.stop()).resolves.toBe(true);
    const command = powershell.mock.calls[0] as unknown as [string];
    expect(command[0]).toContain('-LocalPort 1234');
    expect(command[0]).toContain("ProcessName -eq 'llama-server'");
  });

  it('reports false when nothing was stopped', async () => {
    const { llm } = await control({ powershell: async () => '' });
    await expect(llm.stop()).resolves.toBe(false);
  });

  it.each([
    ['another machine', { baseUrl: () => 'http://192.168.1.5:1234/v1' }],
    ['no local server in use', { baseUrl: () => null }],
    ['another platform', { platform: 'linux' }],
  ])('leaves it alone with %s', async (_name, overrides) => {
    const { llm, powershell } = await control(overrides);
    await expect(llm.stop()).resolves.toBe(false);
    expect(powershell).not.toHaveBeenCalled();
  });

  it("doesn't stop what it couldn't start again", async () => {
    const { llm, powershell } = await control({}, false);
    await expect(llm.stop()).resolves.toBe(false);
    expect(powershell).not.toHaveBeenCalled();
  });

  it('starts it again with the start script on the same port', async () => {
    const { llm, launch } = await control();
    await llm.start();
    const command = (launch.mock.calls[0] as [string])[0];
    expect(command).toContain('start-local-llm.ps1');
    expect(command).toContain('"-Port"');
    expect(command).toContain('"1234"');
    expect(command).toContain('-WindowStyle Hidden');
  });

  it('names its pid and log files after fileName, so a second server has its own pid file', async () => {
    const { llm, launch } = await control({
      fileName: 'coder-llm',
      baseUrl: () => 'http://127.0.0.1:1236/v1',
      model: async () => ({ path: 'D:\\m\\coder-Q4_K_M-00001-of-00003.gguf', alias: 'qwen3-coder-next', contextLength: 65536 }),
    });
    await llm.start();
    const command = (launch.mock.calls[0] as [string])[0];
    expect(command).toContain('"1236"');
    expect(command).toContain('"qwen3-coder-next"');
    expect(command).toContain('"65536"');
    expect(command).toMatch(/coder-llm\.pid/);
    expect(command).toMatch(/coder-llm\.log/);
    expect(command).toMatch(/coder-llm\.err\.log/);
  });

  it('keeps llm.pid by default', async () => {
    const { llm, launch } = await control();
    await llm.start();
    expect((launch.mock.calls[0] as [string])[0]).toMatch(/[\\/]llm\.pid/);
  });

  it('restarts llama-server with the downloaded model and its own context limit', async () => {
    const model = async () => ({ path: 'C:\\models\\m-Q4_K_M.gguf', alias: 'm-q4_k_m', contextLength: 32768 });
    const { llm, powershell, launch } = await control({ model });
    await expect(llm.restart()).resolves.toMatchObject({ restarted: true, message: expect.stringContaining('m-q4_k_m') });
    expect((powershell.mock.calls[0] as unknown as [string])[0]).toContain("ProcessName -eq 'llama-server'");
    const command = (launch.mock.calls[0] as [string])[0];
    expect(command).toContain('"-Model"');
    expect(command).toContain('m-Q4_K_M.gguf');
    expect(command).toContain('"-Alias"');
    expect(command).toContain('"32768"');
  });

  it('leaves another program on the port alone', async () => {
    const { llm, launch } = await control({ powershell: async () => 'other:LM Studio\r\n' });
    await expect(llm.restart()).resolves.toMatchObject({ restarted: false, message: expect.stringContaining('LM Studio') });
    expect(launch).not.toHaveBeenCalled();
  });

  it('says what to run when it cannot restart it', async () => {
    const { llm, powershell } = await control({ platform: 'linux', model: async () => ({ path: '/m.gguf', alias: 'm' }) });
    await expect(llm.restart()).resolves.toMatchObject({ restarted: false, message: expect.stringContaining('-Model "/m.gguf"') });
    expect(powershell).not.toHaveBeenCalled();
  });
});
