import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AudioDevicePreferences {
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
}

export interface PreferencesStore {
  load(): Promise<AudioDevicePreferences>;
  save(preferences: AudioDevicePreferences): Promise<void>;
}

export class FilePreferencesStore implements PreferencesStore {
  constructor(private readonly filePath: string) {}

  async load(): Promise<AudioDevicePreferences> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      return this.sanitize(parsed);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return {};
      }

      throw error;
    }
  }

  async save(preferences: AudioDevicePreferences): Promise<void> {
    const directory = path.dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const payload = JSON.stringify(preferences, null, 2);
    await fs.writeFile(this.filePath, payload, 'utf8');
  }

  private sanitize(input: Record<string, unknown>): AudioDevicePreferences {
    const audioInputDeviceId = this.normalizeId(input.audioInputDeviceId);
    const audioOutputDeviceId = this.normalizeId(input.audioOutputDeviceId);

    const preferences: AudioDevicePreferences = {};

    if (audioInputDeviceId) {
      preferences.audioInputDeviceId = audioInputDeviceId;
    }

    if (audioOutputDeviceId) {
      preferences.audioOutputDeviceId = audioOutputDeviceId;
    }

    return preferences;
  }

  private normalizeId(value: unknown): string | undefined {
    if (typeof value !== 'string') {
      return undefined;
    }

    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
}

export class InMemoryPreferencesStore implements PreferencesStore {
  private preferences: AudioDevicePreferences = {};

  async load(): Promise<AudioDevicePreferences> {
    return { ...this.preferences };
  }

  async save(preferences: AudioDevicePreferences): Promise<void> {
    this.preferences = { ...preferences };
  }
}
