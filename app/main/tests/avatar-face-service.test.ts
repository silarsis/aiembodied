import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import type OpenAI from 'openai';
import { AvatarFaceService } from '../src/avatar/avatar-face-service.js';
import type { AvatarUploadRequest } from '../src/avatar/types.js';
import { MemoryStore } from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

function createOpenAiClientMock() {
  const imagesCreate = vi.fn<[unknown, unknown?], Promise<unknown>>();
  const responsesCreate = vi.fn<[unknown, unknown?], Promise<unknown>>();
  const client = { images: { create: imagesCreate }, responses: { create: responsesCreate } } as unknown as OpenAI;
  return { client, imagesCreate, responsesCreate };
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

describe('AvatarFaceService', () => {
  it('uploads faces via OpenAI images API and stores components for rendering', async () => {
    const store = await createStore();
    const payload = {
      name: 'Friendly Bot',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    } satisfies AvatarUploadRequest;

    // Mock successful image generation response for each layer
    const openAiResponse = {
      data: [
        {
          b64_json: Buffer.from([1, 2, 3]).toString('base64'),
        }
      ]
    };

    const descriptor = {
      hairColor: 'dark brown',
      hairStyle: 'short curls',
      eyeColor: 'green',
      skinTone: 'medium tan',
      facialHair: 'none',
      accessories: ['round glasses'],
      notableFeatures: 'soft freckles',
    };

    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();
    responsesCreate.mockResolvedValue({ output_text: JSON.stringify(descriptor) });
    imagesCreate.mockResolvedValue(openAiResponse);

    const service = new AvatarFaceService({
      client,
      store,
      now: () => 42_000,
    });

    const result = await service.uploadFace(payload);
    expect(result.faceId).toMatch(/^[-0-9a-f]+$/i);

    // Should be called once for the descriptor and once per layer specification
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(imagesCreate).toHaveBeenCalledTimes(9);

    const faces = store.listFaces();
    expect(faces).toHaveLength(1);
    expect(store.getActiveFaceId()).toBe(result.faceId);

    const active = await service.getActiveFace();
    expect(active).not.toBeNull();
    expect(active?.components).toHaveLength(9); // All 9 layers generated
    expect(active?.components[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('sends correct parameters to OpenAI images API when uploading faces', async () => {
    const store = await createStore();
    const payload = {
      name: 'Layered Bot',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    } satisfies AvatarUploadRequest;

    const openAiResponse = {
      data: [
        { b64_json: Buffer.from([1]).toString('base64') }
      ]
    };

    const requests: unknown[] = [];

    const descriptor = {
      hairColor: 'jet black',
      hairStyle: 'long wavy hair',
      eyeColor: 'amber',
      skinTone: 'deep brown',
      facialHair: 'none',
      accessories: ['silver hoop earrings'],
      notableFeatures: 'bold eyeliner',
    };

    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();
    responsesCreate.mockResolvedValue({ output_text: JSON.stringify(descriptor) });

    imagesCreate.mockImplementation(async (body: unknown) => {
      requests.push(body);
      return openAiResponse;
    });

    const service = new AvatarFaceService({
      client,
      store,
    });

    await service.uploadFace(payload);

    // Should be called once for the descriptor and once per layer
    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(imagesCreate).toHaveBeenCalledTimes(9);

    // Check first request parameters
    const firstRequest = requests[0] as Record<string, any>;
    expect(firstRequest).toMatchObject({
      model: 'gpt-image-1',
      size: '256x256',
      n: 1,
      response_format: 'b64_json',
    });
    expect(typeof firstRequest.prompt).toBe('string');
    expect(firstRequest.prompt.length).toBeGreaterThan(0);
    expect(firstRequest.prompt).toContain('jet black');
    expect(firstRequest.prompt).toContain('amber');
    expect(firstRequest.prompt).toContain('silver hoop earrings');
  });

  it('propagates descriptor details into each image prompt', async () => {
    const store = await createStore();
    const payload = {
      name: 'Descriptor Bot',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    } satisfies AvatarUploadRequest;

    const descriptor = {
      hairColor: 'silver',
      hairStyle: 'short pixie cut',
      eyeColor: 'violet',
      skinTone: 'porcelain',
      facialHair: 'none',
      accessories: ['round glasses', 'pearl earrings'],
      notableFeatures: 'star tattoo under left eye',
    };

    const openAiResponse = {
      data: [
        { b64_json: Buffer.from([1]).toString('base64') }
      ]
    };

    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();
    responsesCreate.mockResolvedValue({ output_text: JSON.stringify(descriptor) });
    imagesCreate.mockResolvedValue(openAiResponse);

    const service = new AvatarFaceService({
      client,
      store,
    });

    await service.uploadFace(payload);

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    const prompts = imagesCreate.mock.calls.map(([params]) => (params as { prompt?: string }).prompt ?? '');
    expect(prompts).toHaveLength(9);
    for (const prompt of prompts) {
      expect(prompt).toContain('silver');
      expect(prompt).toContain('violet');
      expect(prompt).toContain('round glasses');
      expect(prompt).toContain('star tattoo under left eye');
    }
  });

  it('fails early when descriptor analysis cannot be generated', async () => {
    const store = await createStore();
    const payload = {
      name: 'Descriptor Failure',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    } satisfies AvatarUploadRequest;

    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();
    responsesCreate.mockRejectedValue(Object.assign(new Error('analysis failed'), {
      status: 429,
      response: { data: { error: 'rate limit' } },
    }));

    const service = new AvatarFaceService({
      client,
      store,
    });

    await expect(service.uploadFace(payload)).rejects.toThrow(
      'OpenAI response request failed with status 429: {"error":"rate limit"}',
    );

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(imagesCreate).not.toHaveBeenCalled();
  });

  it('lists faces and manages active selection lifecycle', async () => {
    const store = await createStore();
    const { client } = createOpenAiClientMock();

    const service = new AvatarFaceService({
      client,
      store,
    });

    store.createFace(
      { id: 'face-a', name: 'Face A', createdAt: 10 },
      [
        {
          id: 'component-a',
          faceId: 'face-a',
          slot: 'base',
          sequence: 0,
          mimeType: 'image/png',
          data: Buffer.from([7, 8, 9]),
        },
      ],
    );

    const faces = await service.listFaces();
    expect(faces).toHaveLength(1);
    expect(faces[0]).toMatchObject({ id: 'face-a', name: 'Face A' });
    expect(faces[0].previewDataUrl?.startsWith('data:image/png;base64,')).toBe(true);

    const detail = await service.setActiveFace('face-a');
    expect(detail?.id).toBe('face-a');
    expect(store.getActiveFaceId()).toBe('face-a');

    await service.deleteFace('face-a');
    expect(store.listFaces()).toHaveLength(0);
    expect(store.getActiveFaceId()).toBeNull();
  });

  it('rejects attempts to activate unknown faces', async () => {
    const store = await createStore();
    const { client } = createOpenAiClientMock();

    const service = new AvatarFaceService({
      client,
      store,
    });

    await expect(service.setActiveFace('missing-face')).rejects.toThrow();
  });

  it('throws when OpenAI returns an error status', async () => {
    const store = await createStore();
    const logger = { error: vi.fn() };
    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();
    const apiError = Object.assign(new Error('server error'), {
      status: 500,
      response: { data: 'server error' },
    });

    const descriptor = {
      hairColor: 'auburn',
      hairStyle: 'bob cut',
      eyeColor: 'blue',
      skinTone: 'fair',
      facialHair: 'none',
      accessories: [],
      notableFeatures: 'light freckles',
    };

    responsesCreate.mockResolvedValue({ output_text: JSON.stringify(descriptor) });
    imagesCreate.mockRejectedValue(apiError);

    const service = new AvatarFaceService({
      client,
      store,
      logger,
    });

    await expect(
      service.uploadFace({ name: 'Broken', imageDataUrl: 'data:image/png;base64,ZmFpbA==' }),
    ).rejects.toThrow('OpenAI response request failed with status 500: server error');

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(imagesCreate).toHaveBeenCalledTimes(1); // Failed on first layer
    expect(logger.error).toHaveBeenCalledWith('OpenAI response request failed with status 500', {
      status: 500,
      body: 'server error',
    });
  });

  it('throws when OpenAI returns no image data', async () => {
    const store = await createStore();
    const logger = { error: vi.fn() };
    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();

    const descriptor = {
      hairColor: 'blonde',
      hairStyle: 'pixie cut',
      eyeColor: 'hazel',
      skinTone: 'light',
      facialHair: 'none',
      accessories: ['red headband'],
      notableFeatures: 'rosy cheeks',
    };

    responsesCreate.mockResolvedValue({ output_text: JSON.stringify(descriptor) });
    imagesCreate.mockResolvedValue({ data: [] }); // No image data returned

    const service = new AvatarFaceService({
      client,
      store,
      logger,
    });

    await expect(
      service.uploadFace({ name: 'Invalid', imageDataUrl: 'data:image/png;base64,ZmFpbA==' }),
    ).rejects.toThrow('No image data returned for base');

    expect(responsesCreate).toHaveBeenCalledTimes(1);
    expect(imagesCreate).toHaveBeenCalledTimes(1); // Failed on first layer (base), so stopped early
    expect(logger.error).toHaveBeenCalledWith('Failed to generate base', expect.objectContaining({
      slot: 'base',
      error: 'No image data returned for base'
    }));
  });

  it('validates avatar image data URLs before uploading', async () => {
    const store = await createStore();
    const { client, imagesCreate, responsesCreate } = createOpenAiClientMock();

    const service = new AvatarFaceService({
      client,
      store,
    });

    await expect(
      service.uploadFace({ name: 'Broken', imageDataUrl: 'data:image/png;base64,' }),
    ).rejects.toThrow('Avatar image data URL is missing image data.');

    expect(responsesCreate).not.toHaveBeenCalled();
    expect(imagesCreate).not.toHaveBeenCalled();

    await expect(
      service.uploadFace({ name: 'Broken', imageDataUrl: 'not-a-data-url' }),
    ).rejects.toThrow('Avatar image data URL is malformed; expected base64-encoded data.');

    expect(responsesCreate).not.toHaveBeenCalled();
    expect(imagesCreate).not.toHaveBeenCalled();
  });
});
