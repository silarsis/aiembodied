import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import { AvatarPoseService } from '../src/avatar/avatar-pose-service.js';
import { MemoryStore } from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createStore() {
  const directory = await mkdtemp(path.join(tmpdir(), 'pose-service-'));
  tempDirs.push(directory);
  const store = new MemoryStore({ filePath: path.join(directory, 'memory.db') });
  stores.push(store);
  return { store, directory };
}

beforeEach(() => {
  // placeholder for setup
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
});

describe('AvatarPoseService', () => {
  it('should upload and persist a pose', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    const poseData = JSON.stringify({
      Armature_Hips: { rotation: [0, 0, 0, 1] },
      Armature_Chest: { rotation: [0.1, 0, 0, 0.995] },
    });

    const result = await service.uploadPose({
      fileName: 'test-pose.pose.json',
      data: poseData,
      name: 'Test Pose',
    });

    expect(result.pose).toBeDefined();
    expect(result.pose.id).toBeTruthy();
    expect(result.pose.name).toBe('Test Pose');
    expect(result.pose.createdAt).toBeGreaterThan(0);
    expect(result.pose.fileSha).toBeTruthy();
  });

  it('should list poses', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    const pose1 = await service.uploadPose({
      fileName: 'pose1.pose.json',
      data: '{}',
      name: 'Pose 1',
    });

    const pose2 = await service.uploadPose({
      fileName: 'pose2.pose.json',
      data: '{}',
      name: 'Pose 2',
    });

    const list = service.listPoses();
    expect(list).toHaveLength(2);
    const names = list.map((p) => p.name).sort();
    expect(names).toEqual(['Pose 1', 'Pose 2']);
  });

  it('should load pose data from disk', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    const poseData = {
      Armature_Hips: { rotation: [0, 0, 0, 1] },
    };

    const result = await service.uploadPose({
      fileName: 'test.pose.json',
      data: JSON.stringify(poseData),
      name: 'Test',
    });

    const loaded = await service.loadPose(result.pose.id);
    expect(loaded).toEqual(poseData);
  });

  it('should reject invalid pose extension', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    await expect(
      service.uploadPose({
        fileName: 'invalid.json',
        data: '{}',
        name: 'Invalid',
      }),
    ).rejects.toThrow('must use the .pose.json extension');
  });

  it('should reject invalid JSON data', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    await expect(
      service.uploadPose({
        fileName: 'test.pose.json',
        data: 'not json',
        name: 'Test',
      }),
    ).rejects.toThrow('invalid JSON data');
  });

  it('should reject non-object JSON', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    await expect(
      service.uploadPose({
        fileName: 'test.pose.json',
        data: '"string"',
        name: 'Test',
      }),
    ).rejects.toThrow('must be an object');
  });

  it('should delete poses', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    const result = await service.uploadPose({
      fileName: 'delete-me.pose.json',
      data: '{}',
      name: 'To Delete',
    });

    const poseId = result.pose.id;
    let list = service.listPoses();
    expect(list).toHaveLength(1);

    await service.deletePose(poseId);

    list = service.listPoses();
    expect(list).toHaveLength(0);
  });

  it('should sanitize pose names', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    const result = await service.uploadPose({
      fileName: 'test.pose.json',
      data: '{}',
      name: '   Trimmed Name   ',
    });

    expect(result.pose.name).toBe('Trimmed Name');
  });

  it('should handle missing pose load gracefully', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    await expect(service.loadPose('nonexistent-id')).rejects.toThrow(
      'Requested VRM pose is not available.',
    );
  });

  it('should persist pose file with correct content', async () => {
    const { store, directory } = await createStore();
    const service = new AvatarPoseService({ store, posesDirectory: directory });

    const poseData = {
      Armature_Hips: { rotation: [0, 0, 0, 1] },
      Armature_Chest: { rotation: [0.1, 0, 0, 0.995] },
    };

    const result = await service.uploadPose({
      fileName: 'test.pose.json',
      data: JSON.stringify(poseData, null, 2),
      name: 'Test',
    });

    // Verify file was written
    const record = store.getVrmPose(result.pose.id);
    expect(record).toBeDefined();

    const fileContent = await readFile(record!.filePath, 'utf8');
    const loaded = JSON.parse(fileContent);
    expect(loaded).toEqual(poseData);
  });
});
