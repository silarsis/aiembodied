import { promises as fs } from 'node:fs';
import path from 'node:path';

export interface AudioDevicePreferences {
  audioInputDeviceId?: string;
  audioOutputDeviceId?: string;
  realtimeModel?: string;
  realtimeVoice?: string;
  sessionInstructions?: string;
  vadTurnDetection?: 'none' | 'server_vad';
  vadThreshold?: number;
  vadSilenceDurationMs?: number;
  vadMinSpeechDurationMs?: number;
}

export interface PreferencesStore {
  load(): Promise<AudioDevicePreferences>;
  save(preferences: AudioDevicePreferences): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasErrnoCode(error: unknown): error is { code: string } {
  if (typeof error !== 'object' || error === null) return false;
  if (!('code' in error)) return false;
  // After 'in' check, TypeScript knows 'code' exists
  return typeof error.code === 'string';
}

export class FilePreferencesStore implements PreferencesStore {
  constructor(private readonly filePath: string) { }

  async load(): Promise<AudioDevicePreferences> {
    try {
      const raw = await fs.readFile(this.filePath, 'utf8');
      const parsed: unknown = JSON.parse(raw);
      if (!isRecord(parsed)) {
        return {};
      }
      return this.sanitize(parsed);
    } catch (error) {
      if (hasErrnoCode(error) && error.code === 'ENOENT') {
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
    const realtimeModel = this.normalizeId(input.realtimeModel);
    const realtimeVoice = this.normalizeId(input.realtimeVoice);
    const sessionInstructions = this.normalizeId(input.sessionInstructions);
    const vadTurnDetection = this.normalizeTurnDetection(input.vadTurnDetection);
    const vadThreshold = this.normalizeNumber(input.vadThreshold, 0, 1);
    const vadSilenceDurationMs = this.normalizeInt(input.vadSilenceDurationMs, 0, 10000);
    const vadMinSpeechDurationMs = this.normalizeInt(input.vadMinSpeechDurationMs, 0, 10000);

    const preferences: AudioDevicePreferences = {};

    if (audioInputDeviceId) {
      preferences.audioInputDeviceId = audioInputDeviceId;
    }

    if (audioOutputDeviceId) {
      preferences.audioOutputDeviceId = audioOutputDeviceId;
    }

    if (realtimeModel) {
      preferences.realtimeModel = realtimeModel;
    }

    if (realtimeVoice) {
      preferences.realtimeVoice = realtimeVoice;
    }

    if (sessionInstructions) {
      preferences.sessionInstructions = sessionInstructions;
    }

    if (vadTurnDetection) {
      preferences.vadTurnDetection = vadTurnDetection;
    }

    if (typeof vadThreshold === 'number') {
      preferences.vadThreshold = vadThreshold;
    }

    if (typeof vadSilenceDurationMs === 'number') {
      preferences.vadSilenceDurationMs = vadSilenceDurationMs;
    }

    if (typeof vadMinSpeechDurationMs === 'number') {
      preferences.vadMinSpeechDurationMs = vadMinSpeechDurationMs;
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

  private normalizeTurnDetection(value: unknown): 'none' | 'server_vad' | undefined {
    if (value === 'none' || value === 'server_vad') return value;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === 'none' || v === 'server_vad') return v;
    }
    return undefined;
  }

  private normalizeNumber(value: unknown, min: number, max: number): number | undefined {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return undefined;
    if (n < min || n > max) return undefined;
    return n;
  }

  private normalizeInt(value: unknown, min: number, max: number): number | undefined {
    const n = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(n)) return undefined;
    const i = Math.round(n);
    if (i < min || i > max) return undefined;
    return i;
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
