import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { AvatarAnimationService } from '../src/avatar/avatar-animation-service.js';
import { VrmaGenerationService } from '../src/avatar/vrma-generation-service.js';
import { MemoryStore } from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'vrma-generation-'));
  tempDirs.push(directory);
  const store = new MemoryStore({ filePath: path.join(directory, 'memory.db') });
  stores.push(store);
  return { store, directory };
}

function createClient(outputText: string) {
  const create = vi.fn<[unknown], Promise<{ output_text: string }>>().mockResolvedValue({ output_text: outputText });
  const client = { responses: { create } } as unknown as OpenAI;
  return { client, create };
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

describe('VrmaGenerationService', () => {
  it('generates and persists a VRMA animation', async () => {
    const { store, directory } = await createStore();
    const animationService = new AvatarAnimationService({
      store,
      animationsDirectory: path.join(directory, 'vrma-animations'),
    });

    const outputText = JSON.stringify({
      meta: {
        name: 'friendly-wave',
        fps: 30,
        loop: true,
        duration: 1.2,
        kind: 'gesture',
      },
      tracks: [
        {
          bone: 'hips',
          keyframes: [
            { t: 0, q: [0, 0, 0, 1] },
            { t: 1, q: [0, 0.2, 0, 0.98] },
          ],
        },
      ],
      hips: {
        position: {
          keyframes: [
            { t: 0, p: [0, 0, 0] },
            { t: 1, p: [0, 0.02, 0] },
          ],
        },
      },
      expressions: [
        {
          name: 'happy',
          keyframes: [
            { t: 0, v: 0 },
            { t: 1, v: 0.4 },
          ],
        },
      ],
    });

    const { client, create } = createClient(outputText);
    const service = new VrmaGenerationService({ client, animationService });

    const result = await service.generateAnimation({ prompt: 'Wave hello' });
    expect(create).toHaveBeenCalled();
    expect(result.animation.name).toBe('friendly-wave');

    const stored = animationService.listAnimations();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('friendly-wave');
    expect(stored[0]?.duration).toBeGreaterThan(0);
  });
});
