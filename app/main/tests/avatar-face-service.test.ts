import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import { AvatarFaceService } from '../src/avatar/avatar-face-service.js';
import type { AvatarUploadRequest } from '../src/avatar/types.js';
import { MemoryStore } from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}

function createClientWithResponsesOnly() {
  const create = vi.fn<[unknown], Promise<any>>();
  const client = { responses: { create } } as unknown as OpenAI;
  return { client, responsesCreate: create };
}

function createClientWithImagesOnly() {
  const create = vi.fn<[unknown], Promise<any>>();
  const client = { images: { create } } as unknown as OpenAI;
  return { client, imagesCreate: create };
}

function createClientWithBoth() {
  const responsesCreate = vi.fn<[unknown], Promise<any>>();
  const imagesCreate = vi.fn<[unknown], Promise<any>>();
  const client = { responses: { create: responsesCreate }, images: { create: imagesCreate } } as unknown as OpenAI;
  return { client, responsesCreate, imagesCreate };
}

async function createStore(): Promise<MemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'avatar-face-service-'));
  tempDirs.push(directory);
  const store = new MemoryStore({ filePath: path.join(directory, 'memory.db') });
  stores.push(store);
  return store;
}

beforeEach(() => {
  vi.useRealTimers();
});

afterEach(async () => {
  while (stores.length > 0) {
    stores.pop()?.dispose();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }

  vi.restoreAllMocks();
});

describe('AvatarFaceService (generate/apply)', () => {
  it('generates candidates via Responses API and applies a selection', async () => {
    const store = await createStore();
    const { client, responsesCreate } = createClientWithResponsesOnly();

    // For each layer call, return an image_generation_call output with base64 content
    responsesCreate.mockImplementation(async () => ({
      output: [{ type: 'image_generation_call', result: b64([1, 2, 3]) }],
    }));

    const service = new AvatarFaceService({ client, store, now: () => 42_000 });
    const request: AvatarUploadRequest = { name: 'Friendly', imageDataUrl: 'data:image/png;base64,' + b64([9, 9, 9]) };

    const gen = await service.generateFace(request);
    expect(responsesCreate).toHaveBeenCalled();
    for (const call of responsesCreate.mock.calls) {
      const params = call[0] as { input?: ResponseInput; model?: string; tools?: unknown };
      expect(params).toMatchObject({ model: 'gpt-4.1-mini', tools: [{ type: 'image_generation' }] });
      const messages = params.input;
      expect(Array.isArray(messages)).toBe(true);
      if (!Array.isArray(messages)) continue;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toMatchObject({ type: 'message', role: 'system' });
      const systemContent = (messages[0] as { content?: Array<{ type?: string }> }).content ?? [];
      expect(systemContent[0]).toMatchObject({ type: 'input_text' });
      const userMessage = messages[1] as { content?: Array<Record<string, unknown>> };
      expect(userMessage).toMatchObject({ type: 'message', role: 'user' });
      expect(Array.isArray(userMessage.content)).toBe(true);
      if (!Array.isArray(userMessage.content)) continue;
      expect(userMessage.content).toHaveLength(2);
      expect(userMessage.content[0]).toMatchObject({
        type: 'input_text',
        text: expect.stringContaining('Reference portrait attached.'),
      });
      expect(userMessage.content[1]).toMatchObject({
        type: 'input_image',
        image_url: request.imageDataUrl,
        detail: 'high',
      });
    }
    expect(gen.generationId).toMatch(/^[-0-9a-f]+$/i);
    expect(gen.candidates.length).toBeGreaterThan(0);
    const cand = gen.candidates[0];
    expect(cand.strategy).toBe('responses');
    expect(cand.componentsCount).toBeGreaterThan(0);
    expect(typeof cand.qualityScore).toBe('number');

    const apply = await service.applyGeneratedFace(gen.generationId, cand.id, 'Applied Face');
    expect(apply.faceId).toMatch(/^[-0-9a-f]+$/i);

    const active = await service.getActiveFace();
    expect(active?.name).toBe('Applied Face');
    expect(active?.components.length).toBeGreaterThan(0);
    expect(active?.components[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('generates candidates via Images API when available', async () => {
    const store = await createStore();
    const { client, imagesCreate } = createClientWithImagesOnly();
    imagesCreate.mockResolvedValue({ data: [{ b64_json: b64([4, 5, 6]) }] });

    const service = new AvatarFaceService({ client, store });
    const gen = await service.generateFace({ name: 'Bot', imageDataUrl: 'data:image/png;base64,' + b64([7]) });
    expect(gen.candidates.length).toBe(1);
    expect(gen.candidates[0].strategy).toBe('images_edit');
  });

  it('uploadFace throws deprecation error', async () => {
    const store = await createStore();
    const { client } = createClientWithBoth();
    const service = new AvatarFaceService({ client, store });
    await expect(service.uploadFace({ name: 'Any', imageDataUrl: 'data:image/png;base64,' + b64([1]) }))
      .rejects.toThrow('uploadFace is deprecated. Use generateFace + applyGeneratedFace.');
  });

  it('logs strategy failures and still returns remaining candidates', async () => {
    const store = await createStore();
    const logger = { error: vi.fn() };
    const { client, responsesCreate, imagesCreate } = createClientWithBoth();

    const apiError: any = Object.assign(new Error('server error'), { status: 500, response: { data: 'server error' } });
    responsesCreate.mockRejectedValue(apiError);
    imagesCreate.mockResolvedValue({ data: [{ b64_json: b64([4]) }] });

    const service = new AvatarFaceService({ client, store, logger });
    const gen = await service.generateFace({ name: 'Bot', imageDataUrl: 'data:image/png;base64,' + b64([2]) });
    // Images strategy should succeed, responses strategy should log and be skipped
    expect(gen.candidates.length).toBe(1);
    expect(gen.candidates[0].strategy).toBe('images_edit');
    expect(logger.error).toHaveBeenCalled();
  });

  it('lists, activates, and deletes faces', async () => {
    const store = await createStore();
    const { client } = createClientWithResponsesOnly();
    const service = new AvatarFaceService({ client, store });

    // Seed a face directly in the store
    store.createFace(
      { id: 'face-a', name: 'Face A', createdAt: 10 },
      [{ id: 'component-a', faceId: 'face-a', slot: 'base', sequence: 0, mimeType: 'image/png', data: Buffer.from([1]) }],
    );

    const list = await service.listFaces();
    expect(list).toHaveLength(1);
    expect(list[0].previewDataUrl?.startsWith('data:image/png;base64,')).toBe(true);

    await expect(service.setActiveFace('face-a')).resolves.toMatchObject({ id: 'face-a' });
    expect(store.getActiveFaceId()).toBe('face-a');

    await service.deleteFace('face-a');
    expect(store.getActiveFaceId()).toBeNull();
    expect(store.listFaces()).toHaveLength(0);
  });
});
