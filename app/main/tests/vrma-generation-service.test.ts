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

function createClient(outputText: string | string[]) {
  const outputs = Array.isArray(outputText) ? [...outputText] : [outputText];
  const create = vi.fn<[unknown], Promise<{ output_text: string }>>().mockImplementation(async () => {
    const next = outputs.shift() ?? '';
    return { output_text: next };
  });
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

    const analystOutput = `The greeting wave is a friendly, relaxed gesture initiated from the shoulder. The movement starts with the elbow extending slightly forward and upward, the forearm follows with a gentle rotational motion from the wrist. The head tilts slightly upward and to the side, indicating engagement. The shoulders remain stable and slightly dropped. The movement is smooth and sustained, suggesting ease and warmth. The wave resolves gradually, returning the arm and head to a neutral position.`;

    const planOutput = JSON.stringify({
      meta: {
        name: 'friendly-wave',
        loop: true,
        approxDuration: 1.2,
        recommendedFps: 30,
        kind: 'gesture',
      },
      globalStyle: {
        energy: 'medium',
        keyframeDensity: 'medium',
        hipsMovement: 'none',
        usesExpressions: true,
      },
      phases: [
        {
          name: 'wave',
          startTime: 0,
          endTime: 1.2,
          purpose: 'friendly wave gesture',
          bones: [{ bone: 'hips', role: 'primary', motion: 'slight sway' }],
          description: 'Wave motion from shoulder to wrist',
          keyframeDensity: 'medium',
          easingHint: 'easeInOut',
          expressions: [],
        },
      ],
    });

    const compilerOutput = JSON.stringify({
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

    const { client, create } = createClient([analystOutput, planOutput, compilerOutput]);
    const service = new VrmaGenerationService({ client, animationService });

    const result = await service.generateAnimation({ prompt: 'Wave hello' });
    expect(create).toHaveBeenCalledTimes(3);
    expect(result.animation.name).toBe('friendly-wave');

    const stored = animationService.listAnimations();
    expect(stored).toHaveLength(1);
    expect(stored[0]?.name).toBe('friendly-wave');
    expect(stored[0]?.duration).toBeGreaterThan(0);
  });

  it('retries when the model returns invalid bones', async () => {
    const { store, directory } = await createStore();
    const animationService = new AvatarAnimationService({
      store,
      animationsDirectory: path.join(directory, 'vrma-animations'),
    });

    const analystOutput = 'A simple waving motion from the shoulder down through the arm and wrist.';

    const planOutput = JSON.stringify({
      meta: {
        name: 'valid-bones',
        loop: true,
        approxDuration: 1.0,
        recommendedFps: 30,
        kind: 'gesture',
      },
      globalStyle: {
        energy: 'medium',
        keyframeDensity: 'medium',
        hipsMovement: 'none',
        usesExpressions: false,
      },
      phases: [
        {
          name: 'wave',
          startTime: 0,
          endTime: 1.0,
          purpose: 'wave gesture',
          bones: [{ bone: 'hips', role: 'primary', motion: 'sway' }],
          description: 'Wave motion',
          keyframeDensity: 'medium',
          easingHint: 'easeInOut',
          expressions: [],
        },
      ],
    });

    const invalidOutput = JSON.stringify({
      meta: {
        name: 'invalid-bones',
        fps: 30,
        loop: true,
        duration: 1.0,
      },
      tracks: [
        {
          bone: 'left_arm',
          keyframes: [{ t: 0, q: [0, 0, 0, 1] }],
        },
      ],
      hips: {},
      expressions: [],
    });

    const validOutput = JSON.stringify({
      meta: {
        name: 'valid-bones',
        fps: 30,
        loop: true,
        duration: 1.0,
      },
      tracks: [
        {
          bone: 'hips',
          keyframes: [{ t: 0, q: [0, 0, 0, 1] }],
        },
      ],
      hips: {},
      expressions: [],
    });

    const { client, create } = createClient([analystOutput, planOutput, invalidOutput, validOutput]);
    const service = new VrmaGenerationService({ client, animationService });

    const result = await service.generateAnimation({ prompt: 'Wave hello', bones: ['hips', 'spine'] });
    expect(result.animation.name).toBe('valid-bones');
    expect(create).toHaveBeenCalledTimes(4);

    const retryPayload = create.mock.calls[3]?.[0];
    const serialized = JSON.stringify(retryPayload);
    expect(serialized).toContain('left_arm');
    expect(serialized).toContain('hips');
  });
});
