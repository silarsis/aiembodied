import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FilePreferencesStore, InMemoryPreferencesStore } from '../src/config/preferences-store.js';

describe('Preferences stores', () => {
  it('returns stored values from the in-memory store', async () => {
    const store = new InMemoryPreferencesStore();
    await store.save({ audioInputDeviceId: 'mic', audioOutputDeviceId: 'speaker' });

    await expect(store.load()).resolves.toEqual({
      audioInputDeviceId: 'mic',
      audioOutputDeviceId: 'speaker',
    });
  });

  it('persists preferences to disk in the file store', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'prefs-'));
    const filePath = path.join(directory, 'preferences.json');
    const store = new FilePreferencesStore(filePath);

    await expect(store.load()).resolves.toEqual({});

    await store.save({ audioInputDeviceId: 'mic-1', audioOutputDeviceId: 'speaker-2' });
    await expect(store.load()).resolves.toEqual({
      audioInputDeviceId: 'mic-1',
      audioOutputDeviceId: 'speaker-2',
    });

    const contents = await readFile(filePath, 'utf8');
    expect(contents).toContain('mic-1');
  });
});
