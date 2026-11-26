import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = resolve(__dirname, '../../../services/speech/scripts/ensure-kokoro.ps1');
const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

// The script is PowerShell; it runs (and is tested) on Windows only.
describe.skipIf(process.platform !== 'win32')('ensure-kokoro.ps1', () => {
  const served: Record<string, Buffer> = {
    'kokoro-v1.0.onnx': Buffer.from('model bytes'),
    'voices-v1.0.bin': Buffer.from('voice bytes!'),
  };
  let server: Server;
  let base = '';
  let requests: string[] = [];
  let root = '';

  beforeEach(async () => {
    requests = [];
    root = mkdtempSync(join(tmpdir(), 'ensure-kokoro-'));
    server = createServer((req, res) => {
      const name = (req.url ?? '/').slice(1);
      requests.push(name);
      const body = served[name];
      if (!body) {
        res.writeHead(404).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/octet-stream' }).end(body);
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  });
  afterEach(async () => {
    await new Promise<void>((done) => server.close(() => done()));
    rmSync(root, { recursive: true, force: true });
  });

  const files = (
    overrides: Partial<Record<string, { size?: number; sha256?: string | null }>> = {},
  ) =>
    JSON.stringify(
      Object.entries(served).map(([name, body]) => ({
        name,
        size: body.length,
        sha256: sha(body),
        ...overrides[name],
      })),
    );

  // Async on purpose: a synchronous spawn would block this process, so the test server could never answer.
  const run = (args: string[], env: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args],
        {
          env: { ...process.env, KOKORO_DIR: '', ...env },
          windowsHide: true,
        },
      );
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString('utf8')));
      child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString('utf8')));
      child.on('close', (status) => done({ status, stdout, stderr }));
    });

  it('downloads both files, writes the folder, and fetches nothing on the next run', async () => {
    const dir = join(root, 'kokoro');
    const first = await run(['-Dir', dir, '-BaseUrl', base, '-FilesJson', files()]);
    expect(first.status, first.stderr).toBe(0);
    expect(first.stdout.trim().split(/\r?\n/).pop()).toBe(dir);
    expect(readFileSync(join(dir, 'kokoro-v1.0.onnx'))).toEqual(served['kokoro-v1.0.onnx']);
    expect(readFileSync(join(dir, 'voices-v1.0.bin'))).toEqual(served['voices-v1.0.bin']);
    expect(requests.sort()).toEqual(['kokoro-v1.0.onnx', 'voices-v1.0.bin']);

    requests = [];
    const second = await run(['-Dir', dir, '-BaseUrl', base, '-FilesJson', files()]);
    expect(second.status, second.stderr).toBe(0);
    expect(requests).toEqual([]);
  });

  it('defaults to <TTS_MODELS_DIR>\\kokoro and replaces a file of the wrong size', async () => {
    const models = join(root, 'tts-models');
    mkdirSync(join(models, 'kokoro'), { recursive: true });
    writeFileSync(join(models, 'kokoro', 'voices-v1.0.bin'), 'trunc');
    const result = await run(['-BaseUrl', base, '-FilesJson', files()], { TTS_MODELS_DIR: models });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split(/\r?\n/).pop()).toBe(join(models, 'kokoro'));
    expect(readFileSync(join(models, 'kokoro', 'voices-v1.0.bin'))).toEqual(
      served['voices-v1.0.bin'],
    );
  });

  it('refuses a download of the wrong size or checksum and leaves nothing behind', async () => {
    const dir = join(root, 'kokoro');
    const badSize = await run([
      '-Dir',
      dir,
      '-BaseUrl',
      base,
      '-FilesJson',
      files({ 'kokoro-v1.0.onnx': { size: 999 } }),
    ]);
    expect(badSize.status).not.toBe(0);
    expect(badSize.stderr + badSize.stdout).toMatch(/expected 999 bytes/);
    expect(existsSync(join(dir, 'kokoro-v1.0.onnx'))).toBe(false);
    expect(existsSync(join(dir, 'kokoro-v1.0.onnx.partial'))).toBe(false);

    const badSha = await run([
      '-Dir',
      dir,
      '-BaseUrl',
      base,
      '-FilesJson',
      files({ 'kokoro-v1.0.onnx': { sha256: '0'.repeat(64) } }),
    ]);
    expect(badSha.status).not.toBe(0);
    expect(badSha.stderr + badSha.stdout).toMatch(/SHA-256 mismatch/);
    expect(existsSync(join(dir, 'kokoro-v1.0.onnx'))).toBe(false);
  });
});
