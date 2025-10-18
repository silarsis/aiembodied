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

type ResponsesClient = Pick<OpenAI, 'responses'>;

function createResponsesClientMock() {
  const create = vi.fn<[unknown, unknown?], Promise<unknown>>();
  const client = { responses: { create } } as unknown as ResponsesClient;
  return { client, create };
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
  it('uploads faces via OpenAI and stores components for rendering', async () => {
    const store = await createStore();
    const payload = {
      name: 'Friendly Bot',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    } satisfies AvatarUploadRequest;

    const openAiResponse = {
      output_text: JSON.stringify({
        name: 'Cheerful Friend',
        components: [
          {
            slot: 'base',
            mimeType: 'image/png',
            data: Buffer.from([1, 2, 3]).toString('base64'),
          },
          {
            slot: 'mouth-0',
            mimeType: 'image/png',
            data: Buffer.from([4, 5, 6]).toString('base64'),
            sequence: 0,
          },
        ],
      }),
    };

    const { client, create } = createResponsesClientMock();
    create.mockResolvedValue(openAiResponse);

    const service = new AvatarFaceService({
      client,
      store,
      now: () => 42_000,
    });

    const result = await service.uploadFace(payload);
    expect(result.faceId).toMatch(/^[-0-9a-f]+$/i);
    expect(create).toHaveBeenCalledTimes(1);

    const faces = store.listFaces();
    expect(faces).toHaveLength(1);
    expect(store.getActiveFaceId()).toBe(result.faceId);

    const active = await service.getActiveFace();
    expect(active).not.toBeNull();
    expect(active?.components).toHaveLength(2);
    expect(active?.components[0].dataUrl.startsWith('data:image/png;base64,')).toBe(true);
  });

  it('sends base64 payloads to OpenAI when uploading faces', async () => {
    const store = await createStore();
    const payload = {
      name: 'Layered Bot',
      imageDataUrl: 'data:image/png;base64,aGVsbG8=',
    } satisfies AvatarUploadRequest;

    const openAiResponse = {
      output_text: JSON.stringify({
        components: [
          { slot: 'base', mimeType: 'image/png', data: Buffer.from([1]).toString('base64') },
        ],
      }),
    };

    const requests: unknown[] = [];

    const { client, create } = createResponsesClientMock();
    create.mockImplementation(async (body: unknown) => {
      requests.push(body);
      return openAiResponse;
    });

    const service = new AvatarFaceService({
      client,
      store,
    });

    await service.uploadFace(payload);

    expect(create).toHaveBeenCalledTimes(1);
    const requestBody = requests[0] as Record<string, any>;
    const systemPayload = requestBody?.input?.[0]?.content?.[0];
    const imagePayload = requestBody?.input?.[1]?.content?.[1];
    const responseFormat = requestBody?.text?.format;
    expect(systemPayload).toMatchObject({ type: 'input_text' });
    expect(imagePayload).toEqual({
      type: 'input_image',
      image_url: 'data:image/png;base64,aGVsbG8=',
      detail: 'auto',
    });
    expect(responseFormat?.type).toBe('json_schema');
    expect(responseFormat?.name).toBe('AvatarComponents');
    expect(responseFormat?.schema).toMatchObject({ required: ['components'] });
    const componentSchema = responseFormat?.schema?.properties?.components?.items;
    expect(componentSchema?.required).toEqual(['slot', 'mimeType', 'data']);
  });

  it('lists faces and manages active selection lifecycle', async () => {
    const store = await createStore();
    const { client, create } = createResponsesClientMock();
    create.mockImplementation(async () => {
      throw new Error('unexpected OpenAI invocation');
    });

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
    const { client, create } = createResponsesClientMock();
    create.mockImplementation(async () => {
      throw new Error('unexpected OpenAI invocation');
    });

    const service = new AvatarFaceService({
      client,
      store,
    });

    await expect(service.setActiveFace('missing-face')).rejects.toThrow();
  });

  it('throws when OpenAI returns an error status', async () => {
    const store = await createStore();
    const logger = { error: vi.fn() };
    const { client, create } = createResponsesClientMock();
    const apiError = Object.assign(new Error('server error'), {
      status: 500,
      response: { data: 'server error' },
    });
    create.mockRejectedValue(apiError);

    const service = new AvatarFaceService({
      client,
      store,
      logger,
    });

    await expect(
      service.uploadFace({ name: 'Broken', imageDataUrl: 'data:image/png;base64,ZmFpbA==' }),
    ).rejects.toThrow('OpenAI response request failed with status 500: server error');

    expect(create).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('OpenAI response request failed with status 500', {
      status: 500,
      body: 'server error',
    });
  });

  it('throws when OpenAI returns invalid JSON payload', async () => {
    const store = await createStore();
    const logger = { error: vi.fn() };
    const { client, create } = createResponsesClientMock();
    create.mockResolvedValue({ output_text: 'not-json' });

    const service = new AvatarFaceService({
      client,
      store,
      logger,
    });

    await expect(
      service.uploadFace({ name: 'Invalid', imageDataUrl: 'data:image/png;base64,ZmFpbA==' }),
    ).rejects.toThrow('OpenAI returned an invalid avatar component payload.');

    expect(create).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith('Failed to parse avatar component response JSON.', {
      message: expect.stringContaining('Unexpected token'),
    });
  });

  it('validates avatar image data URLs before uploading', async () => {
    const store = await createStore();
    const { client, create } = createResponsesClientMock();

    const service = new AvatarFaceService({
      client,
      store,
    });

    await expect(
      service.uploadFace({ name: 'Broken', imageDataUrl: 'data:image/png;base64,' }),
    ).rejects.toThrow('Avatar image data URL is missing image data.');

    await expect(
      service.uploadFace({ name: 'Broken', imageDataUrl: 'not-a-data-url' }),
    ).rejects.toThrow('Avatar image data URL is malformed; expected base64-encoded data.');

    expect(create).not.toHaveBeenCalled();
  });
});
