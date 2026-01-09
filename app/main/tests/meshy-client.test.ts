import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { MeshyClient } from '../src/avatar/meshy-client.js';

const createJsonResponse = (body: unknown, status = 200): Response => {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const createBufferResponse = (buffer: Buffer, status = 200): Response => {
  return new Response(buffer, {
    status,
    headers: { 'Content-Type': 'application/octet-stream' },
  });
};

describe('MeshyClient', () => {
  it('requires a non-empty API key', () => {
    expect(() => new MeshyClient({ apiKey: '' })).toThrow('Meshy API key is required.');
    expect(() => new MeshyClient({ apiKey: '  ' })).toThrow('Meshy API key is required.');
  });

  it('creates a Meshy generation job with the expected payload', async () => {
    const fetcher = vi.fn().mockResolvedValue(createJsonResponse({ id: 'job-123' }));
    const client = new MeshyClient({ apiKey: 'meshy-key', fetcher });

    const result = await client.createGenerationJob({ prompt: '  Friendly assistant  ' });

    expect(result).toEqual({ jobId: 'job-123' });
    expect(fetcher).toHaveBeenCalledWith(
      'https://api.meshy.ai/v1/text-to-3d',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          prompt: 'Friendly assistant',
          model_format: 'fbx',
          rig: true,
        }),
        headers: expect.objectContaining({
          Authorization: 'Bearer meshy-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('normalizes Meshy status responses', async () => {
    const fetcher = vi.fn().mockResolvedValue(
      createJsonResponse({
        state: 'running',
        progress: 0.45,
        outputs: {
          preview: 'https://preview.example',
          fbx: 'https://asset.example/model.fbx',
        },
      }),
    );
    const client = new MeshyClient({ apiKey: 'meshy-key', fetcher });

    const result = await client.getJobStatus('job-9');

    expect(result).toEqual({
      jobId: 'job-9',
      status: 'generating',
      progress: 45,
      previewPath: 'https://preview.example',
      fbxPath: 'https://asset.example/model.fbx',
      errorMessage: null,
    });
  });

  it('downloads assets and persists them to disk', async () => {
    const buffer = Buffer.from('fbx-data');
    const fetcher = vi.fn().mockResolvedValue(createBufferResponse(buffer));
    const client = new MeshyClient({ apiKey: 'meshy-key', fetcher });
    const directory = await mkdtemp(path.join(tmpdir(), 'meshy-client-'));
    const destination = path.join(directory, 'model.fbx');

    const result = await client.downloadAsset('https://asset.example/model.fbx', destination);

    expect(result).toEqual({ bytes: buffer.length });
    expect(fetcher).toHaveBeenCalledWith(
      'https://asset.example/model.fbx',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer meshy-key',
          'Content-Type': 'application/json',
        }),
      }),
    );
    await expect(readFile(destination)).resolves.toEqual(buffer);
    await rm(directory, { recursive: true, force: true });
  });
});
