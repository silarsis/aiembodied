import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MemoryStore,
  type MemoryStoreExport,
  type FaceComponentRecord,
  type FaceRecord,
  type VrmModelRecord,
} from '../src/memory/memory-store.js';

const tempDirs: string[] = [];
const stores: MemoryStore[] = [];

async function createStore(): Promise<MemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'memory-store-'));
  tempDirs.push(directory);
  const filePath = path.join(directory, 'memory.db');
  const store = new MemoryStore({ filePath });
  stores.push(store);
  return store;
}

async function cleanup() {
  while (stores.length > 0) {
    const store = stores.pop();
    store?.dispose();
  }

  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

afterEach(async () => {
  await cleanup();
});

describe('MemoryStore', () => {
  it('runs migrations and persists sessions and messages', async () => {
    const store = await createStore();
    const startedAt = Date.now();

    store.createSession({ id: 'session-1', startedAt, title: 'First Session' });
    store.appendMessage({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      ts: startedAt + 10,
      content: 'Hello there!',
      audioPath: null,
    });
    store.appendMessage({
      id: 'message-2',
      sessionId: 'session-1',
      role: 'assistant',
      ts: startedAt + 20,
      content: 'Hi! How can I help you?',
      audioPath: '   ',
    });

    const listing = store.listSessions();
    expect(listing).toHaveLength(1);
    expect(listing[0]).toMatchObject({ id: 'session-1', startedAt, title: 'First Session' });

    const loaded = store.getSessionWithMessages('session-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.messages).toHaveLength(2);
    expect(loaded?.messages[1]).toMatchObject({
      id: 'message-2',
      audioPath: null,
    });
  });

  it('updates session titles and orders sessions by recency', async () => {
    const store = await createStore();
    const base = Date.now();

    store.createSession({ id: 'session-older', startedAt: base - 1_000, title: 'Older' });
    store.createSession({ id: 'session-newer', startedAt: base, title: 'Newer' });

    store.updateSessionTitle('session-older', '  ');
    store.updateSessionTitle('session-newer', 'Updated Title');

    const sessions = store.listSessions();
    expect(sessions.map((session) => session.id)).toEqual(['session-newer', 'session-older']);
    expect(sessions[1].title).toBeNull();

    const older = store.getSessionWithMessages('session-older');
    expect(older?.title).toBeNull();
  });

  it('supports key-value storage and deletion', async () => {
    const store = await createStore();

    expect(store.getValue('missing')).toBeNull();

    store.setValue('last-session', 'session-123');
    expect(store.getValue('last-session')).toBe('session-123');

    store.setValue('last-session', 'session-456');
    expect(store.getValue('last-session')).toBe('session-456');

    store.deleteValue('last-session');
    expect(store.getValue('last-session')).toBeNull();
  });

  it('exports and imports data using replace and merge strategies', async () => {
    const original = await createStore();
    const startedAt = Date.now();
    original.createSession({ id: 'session-1', startedAt, title: 'History' });
    original.appendMessage({
      id: 'message-1',
      sessionId: 'session-1',
      role: 'user',
      ts: startedAt + 1,
      content: 'Ping',
      audioPath: null,
    });
    original.setValue('lastSessionId', 'session-1');
    const face: FaceRecord = { id: 'face-1', name: 'Friendly', createdAt: startedAt };
    const component: FaceComponentRecord = {
      id: 'component-1',
      faceId: 'face-1',
      slot: 'base',
      sequence: 0,
      mimeType: 'image/png',
      data: Buffer.from([1, 2, 3]),
    };
    original.createFace(face, [component]);
    original.setActiveFace('face-1');
    const vrmModel: VrmModelRecord = {
      id: 'vrm-1',
      name: 'VRM Model',
      createdAt: startedAt,
      filePath: path.join('models', 'vrm-1.vrm'),
      fileSha: 'sha-123',
      version: '1.0',
      thumbnail: Buffer.from([7, 7, 7]),
    };
    original.createVrmModel(vrmModel);
    original.setActiveVrmModel('vrm-1');

    const exported = original.exportData();

    const replacement = await createStore();
    replacement.createSession({ id: 'session-old', startedAt: startedAt - 100, title: 'Old' });
    replacement.setValue('lastSessionId', 'session-old');

    replacement.importData(exported, { strategy: 'replace' });
    expect(replacement.listSessions()).toHaveLength(1);
    expect(replacement.getValue('lastSessionId')).toBe('session-1');
    expect(replacement.listFaces()).toHaveLength(1);
    expect(replacement.getFaceComponent('face-1', 'base')?.data.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(replacement.listVrmModels()).toHaveLength(1);
    expect(replacement.getActiveVrmModelId()).toBe('vrm-1');
    expect(replacement.getVrmModel('vrm-1')?.thumbnail?.equals(Buffer.from([7, 7, 7]))).toBe(true);

    const mergeTarget = await createStore();
    mergeTarget.createSession({ id: 'session-2', startedAt: startedAt + 500, title: 'Keep me' });
    mergeTarget.createFace(
      { id: 'face-keep', name: 'Keep', createdAt: startedAt + 500 },
      [
        {
          id: 'component-keep',
          faceId: 'face-keep',
          slot: 'base',
          sequence: 0,
          mimeType: 'image/png',
          data: Buffer.from([4, 5, 6]),
        },
      ],
    );

    const mergeComponents = exported.faceComponents.map((item) => ({
      ...item,
      data: item.data,
    }));

    const mergeData: MemoryStoreExport = {
      ...exported,
      sessions: [...exported.sessions, { id: 'session-2', startedAt: startedAt + 500, title: 'Keep me' }],
      messages: exported.messages,
      kv: exported.kv,
      faces: exported.faces,
      faceComponents: mergeComponents,
    };

    mergeTarget.importData(mergeData, { strategy: 'merge' });

    const mergedSessions = mergeTarget.listSessions();
    expect(mergedSessions).toHaveLength(2);
    expect(mergedSessions.map((session) => session.id)).toContain('session-1');
    expect(mergedSessions.map((session) => session.id)).toContain('session-2');
    expect(mergeTarget.listFaces().map((item) => item.id)).toEqual(['face-keep', 'face-1']);
    expect(mergeTarget.listVrmModels().map((item) => item.id)).toContain('vrm-1');
  });

  it('stores avatar faces and resets active face when deleted', async () => {
    const store = await createStore();
    const createdAt = Date.now();
    const face: FaceRecord = { id: 'face-10', name: 'Primary', createdAt };
    const component: FaceComponentRecord = {
      id: 'component-10',
      faceId: 'face-10',
      slot: 'base',
      sequence: 0,
      mimeType: 'image/png',
      data: Buffer.from([9, 9, 9]),
    };

    store.createFace(face, [component]);
    store.setActiveFace('face-10');

    expect(store.getActiveFaceId()).toBe('face-10');
    expect(store.listFaces()).toHaveLength(1);
    expect(store.getFace('face-10')?.name).toBe('Primary');
    expect(store.getFaceComponent('face-10', 'base')?.data.equals(Buffer.from([9, 9, 9]))).toBe(true);

    store.deleteFace('face-10');
    expect(store.listFaces()).toHaveLength(0);
    expect(store.getActiveFaceId()).toBeNull();
  });

  it('stores VRM models and resets active model when deleted', async () => {
    const store = await createStore();
    const createdAt = Date.now();
    const model: VrmModelRecord = {
      id: 'vrm-42',
      name: 'Primary VRM',
      createdAt,
      filePath: path.join('assets', 'vrm-42.vrm'),
      fileSha: 'hash-42',
      version: '1.0',
      thumbnail: Buffer.from([1, 2, 3]),
    };

    store.createVrmModel(model);
    store.setActiveVrmModel('vrm-42');

    const listed = store.listVrmModels();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 'vrm-42', name: 'Primary VRM', version: '1.0' });
    expect(listed[0].thumbnail?.equals(Buffer.from([1, 2, 3]))).toBe(true);
    expect(store.getActiveVrmModelId()).toBe('vrm-42');

    store.deleteVrmModel('vrm-42');
    expect(store.listVrmModels()).toHaveLength(0);
    expect(store.getActiveVrmModelId()).toBeNull();
  });
});
