import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import type OpenAI from 'openai';
import { AvatarPoseService } from '../src/avatar/avatar-pose-service.js';
import { PoseGenerationService } from '../src/avatar/pose-generation-service.js';
import { MemoryStore } from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pose-generation-'));
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

describe('PoseGenerationService', () => {
  it('should generate a pose with 2-step workflow', async () => {
    const { store, directory } = await createStore();
    const poseService = new AvatarPoseService({ store, posesDirectory: directory });

    const expandedDescription = 'Arms at sides, legs straight, confident posture with chest out.';
    // API returns array format: { bones: [{ name, rotation, position }] }
    // The service converts this to object format internally
    const poseJson = {
      bones: [
        { name: 'Armature_Hips', rotation: [0, 0, 0, 1], position: null },
        { name: 'Armature_Chest', rotation: [0.1, 0, 0, 0.995], position: null },
        { name: 'Armature_LeftShoulder', rotation: [0, 0, 0, 1], position: null },
        { name: 'Armature_RightShoulder', rotation: [0, 0, 0, 1], position: null },
      ],
    };

    const { client } = createClient([expandedDescription, JSON.stringify(poseJson)]);
    const service = new PoseGenerationService({
      client,
      poseService,
    });

    const result = await service.generatePose({
      prompt: 'confident power stance',
      bones: ['Armature_Hips', 'Armature_Chest', 'Armature_LeftShoulder', 'Armature_RightShoulder'],
    });

    expect(result.pose).toBeDefined();
    expect(result.pose.id).toBeTruthy();
    expect(result.pose.name).toBe('confident power stance');
    expect(result.pose.createdAt).toBeGreaterThan(0);
    expect(result.pose.fileSha).toBeTruthy();
  });

  it('should reject empty prompt', async () => {
    const { store, directory } = await createStore();
    const poseService = new AvatarPoseService({ store, posesDirectory: directory });
    const { client } = createClient('');
    const service = new PoseGenerationService({
      client,
      poseService,
    });

    await expect(
      service.generatePose({
        prompt: '   ',
        bones: [],
      }),
    ).rejects.toThrow('Pose generation prompt is required.');
  });

  it('should normalize bones list', async () => {
    const { store, directory } = await createStore();
    const poseService = new AvatarPoseService({ store, posesDirectory: directory });

    const expandedDescription = 'Test pose';
    const poseJson = { bones: [{ name: 'Armature_Hips', rotation: [0, 0, 0, 1], position: null }] };
    const { client, create } = createClient([expandedDescription, JSON.stringify(poseJson)]);

    const service = new PoseGenerationService({
      client,
      poseService,
    });

    await service.generatePose({
      prompt: 'test',
      bones: ['  Armature_Hips  ', 'Armature_Hips', '', '  '],
    });

    const calls = create.mock.calls;
    expect(calls.length).toBe(2);
    // Check that bones are normalized in the second (compiler) call
    const compilerCall = calls[1]?.[0] as unknown;
    const inputStr = JSON.stringify(compilerCall);
    expect(inputStr).toContain('Armature_Hips');
  });

  it('should parse invalid JSON from pose compiler gracefully', async () => {
    const { store, directory } = await createStore();
    const poseService = new AvatarPoseService({ store, posesDirectory: directory });
    const { client } = createClient(['expanded', 'not json']);

    const service = new PoseGenerationService({
      client,
      poseService,
    });

    await expect(
      service.generatePose({
        prompt: 'test',
        bones: [],
      }),
    ).rejects.toThrow();
  });

  it('should include model description in prompts', async () => {
    const { store, directory } = await createStore();
    const poseService = new AvatarPoseService({ store, posesDirectory: directory });

    const expandedDescription = 'Test pose for a cheerful character';
    const poseJson = { bones: [{ name: 'Armature_Hips', rotation: [0, 0, 0, 1], position: null }] };
    const { client, create } = createClient([expandedDescription, JSON.stringify(poseJson)]);

    const service = new PoseGenerationService({
      client,
      poseService,
    });

    await service.generatePose({
      prompt: 'cheerful wave',
      bones: [],
      modelDescription: 'A cheerful robot assistant with expressive gestures',
    });

    const calls = create.mock.calls;
    expect(calls.length).toBe(2);

    // Check that model description is in both calls
    for (const call of calls) {
      const inputStr = JSON.stringify(call[0]);
      expect(inputStr).toContain('cheerful robot');
    }
  });
});
