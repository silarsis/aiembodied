import type { AudioDevicePreferences } from '../../../main/src/config/preferences-store.js';

export interface StoredPairing {
  hubUrl: string;
  deviceId: string;
  token: string;
  deviceName: string;
  placeId: string | null;
  placeName: string | null;
}

const PAIRING_KEY = 'aiembodied.web.pairing';
const CLOSED_KEY = 'aiembodied.web.closed';
const AUDIO_KEY = 'aiembodied.web.audio';

/**
 * What the web satellite keeps in the page's localStorage: the pairing (including the device token), the "room
 * closed" switch and the speaker choice. The camera choice is kept by the page itself, as on the desktop.
 * A storage that throws (private mode, blocked) behaves like an empty one; a closed switch that cannot be read
 * counts as closed (fail closed).
 */
export class WebStore {
  constructor(private readonly storage: Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>) {}

  pairing(): StoredPairing | null {
    try {
      const raw = JSON.parse(this.storage.getItem(PAIRING_KEY) ?? 'null') as Partial<StoredPairing> | null;
      if (raw && typeof raw.hubUrl === 'string' && typeof raw.deviceId === 'string' && typeof raw.token === 'string' && raw.hubUrl && raw.deviceId && raw.token) {
        return {
          hubUrl: raw.hubUrl,
          deviceId: raw.deviceId,
          token: raw.token,
          deviceName: typeof raw.deviceName === 'string' ? raw.deviceName : '',
          placeId: typeof raw.placeId === 'string' ? raw.placeId : null,
          placeName: typeof raw.placeName === 'string' ? raw.placeName : null,
        };
      }
    } catch {
      // Unreadable: not paired.
    }
    return null;
  }

  setPairing(pairing: StoredPairing): void {
    try {
      this.storage.setItem(PAIRING_KEY, JSON.stringify(pairing));
    } catch {
      // The pairing then lasts until the page closes.
    }
  }

  clearPairing(): void {
    try {
      this.storage.removeItem(PAIRING_KEY);
    } catch {
      // Nothing to remove.
    }
  }

  /** True when Kevin closed this room. Unreadable counts as closed. */
  closed(): boolean {
    try {
      return this.storage.getItem(CLOSED_KEY) === '1';
    } catch {
      return true;
    }
  }

  setClosed(closed: boolean): void {
    try {
      if (closed) this.storage.setItem(CLOSED_KEY, '1');
      else this.storage.removeItem(CLOSED_KEY);
    } catch {
      // The switch then lasts until the page closes.
    }
  }

  audio(): AudioDevicePreferences {
    try {
      const raw = JSON.parse(this.storage.getItem(AUDIO_KEY) ?? '{}') as AudioDevicePreferences;
      return {
        ...(typeof raw.audioInputDeviceId === 'string' && raw.audioInputDeviceId ? { audioInputDeviceId: raw.audioInputDeviceId } : {}),
        ...(typeof raw.audioOutputDeviceId === 'string' && raw.audioOutputDeviceId ? { audioOutputDeviceId: raw.audioOutputDeviceId } : {}),
      };
    } catch {
      return {};
    }
  }

  setAudio(preferences: AudioDevicePreferences): void {
    try {
      this.storage.setItem(AUDIO_KEY, JSON.stringify(preferences));
    } catch {
      // Kept until the page closes.
    }
  }
}
