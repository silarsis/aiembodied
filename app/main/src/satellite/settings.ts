/**
 * What a satellite PC remembers about itself: which bija it is paired with, its place, and where its window was.
 * Kept in `<userData>/satellite.json`. The token is not here: it is in the system keychain (see token-store.ts).
 *
 * Also how the app decides it is a satellite: `AIEMBODIED_ROLE=satellite`, or a satellite.json that says it
 * paired (so a PC that was set up once keeps starting as a satellite).
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';

export const SATELLITE_FILE = 'satellite.json';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
  fullScreen: boolean;
}

export interface SatelliteSettings {
  /** `ws://bija:8791` as typed on the connect screen. */
  hubUrl: string | null;
  deviceId: string | null;
  deviceName: string | null;
  placeId: string | null;
  placeName: string | null;
  bounds: WindowBounds | null;
  /** Kevin closed this room with the kill switch. Kept, so a closed room stays closed after a restart. */
  closed: boolean;
  /** Accelerator for the kill switch; null means the default (Ctrl+Alt+Shift+R). */
  closeShortcut: string | null;
  /** Accelerator for push-to-talk on this PC; null means the one bija uses, if any. */
  pushToTalk: string | null;
  /** No longer read: the doorbell is a setting of the place, kept on bija (Settings > Places) and read from the places snapshot. */
  doorbell: boolean;
  /** This PC's own microphone and speakers (a satellite's devices are not bija's). */
  audioInputDeviceId: string | null;
  audioOutputDeviceId: string | null;
}

const EMPTY: SatelliteSettings = {
  hubUrl: null,
  deviceId: null,
  deviceName: null,
  placeId: null,
  placeName: null,
  bounds: null,
  closed: false,
  closeShortcut: null,
  pushToTalk: null,
  doorbell: false,
  audioInputDeviceId: null,
  audioOutputDeviceId: null,
};

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim().slice(0, 300) : null);
const whole = (value: unknown): number | undefined => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined);

function readBounds(value: unknown): WindowBounds | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const width = whole(record.width);
  const height = whole(record.height);
  if (!width || !height || width < 200 || height < 150) return null;
  const x = whole(record.x);
  const y = whole(record.y);
  return { width, height, fullScreen: record.fullScreen === true, ...(x !== undefined && y !== undefined ? { x, y } : {}) };
}

export class SatelliteSettingsStore {
  private current: SatelliteSettings;

  constructor(private readonly file: string) {
    this.current = this.read();
  }

  private read(): SatelliteSettings {
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.file, 'utf8'));
      if (!parsed || typeof parsed !== 'object') return { ...EMPTY };
      const record = parsed as Record<string, unknown>;
      return {
        hubUrl: text(record.hubUrl),
        deviceId: text(record.deviceId),
        deviceName: text(record.deviceName),
        placeId: text(record.placeId),
        placeName: text(record.placeName),
        bounds: readBounds(record.bounds),
        closed: record.closed === true,
        closeShortcut: text(record.closeShortcut),
        pushToTalk: text(record.pushToTalk),
        doorbell: record.doorbell === true,
        audioInputDeviceId: text(record.audioInputDeviceId),
        audioOutputDeviceId: text(record.audioOutputDeviceId),
      };
    } catch {
      return { ...EMPTY };
    }
  }

  get(): SatelliteSettings {
    return { ...this.current };
  }

  /** True once this PC has paired (there is a hub and a device id). */
  isPaired(): boolean {
    return Boolean(this.current.hubUrl && this.current.deviceId);
  }

  update(patch: Partial<SatelliteSettings>): SatelliteSettings {
    this.current = { ...this.current, ...patch };
    this.write();
    return this.get();
  }

  /** Forgets the pairing but keeps where the window was. */
  clearPairing(): SatelliteSettings {
    return this.update({ hubUrl: null, deviceId: null, deviceName: null, placeId: null, placeName: null });
  }

  private write(): void {
    mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.tmp`;
    writeFileSync(temporary, JSON.stringify(this.current, null, 2));
    renameSync(temporary, this.file);
  }
}

/**
 * True when this start is a satellite: the environment says so, or this PC paired before (satellite.json has a hub).
 * `AIEMBODIED_ROLE=full` forces the full app, e.g. to look at a PC that was a satellite.
 */
export function detectSatelliteRole(env: NodeJS.ProcessEnv, userDataDir: string): boolean {
  const role = env.AIEMBODIED_ROLE?.trim().toLowerCase();
  if (role === 'satellite') return true;
  if (role === 'full') return false;
  const file = path.join(userDataDir, SATELLITE_FILE);
  return existsSync(file) && new SatelliteSettingsStore(file).isPaired();
}

/** `AIEMBODIED_USER_DATA=<dir>` puts the app's userData there, so two copies can run side by side on one PC. Returns the folder, if set. */
export function userDataOverride(env: NodeJS.ProcessEnv): string | null {
  const dir = env.AIEMBODIED_USER_DATA?.trim();
  return dir ? path.resolve(dir) : null;
}
