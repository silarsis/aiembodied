/**
 * The phones that have paired with this desktop, and the pairing code they use. Kept in a small
 * JSON file in the user data folder so devices are remembered across restarts.
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

/** No 0/O, 1/I/L: the code is read off one screen and typed on another. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 12;
const MAX_DEVICES = 20;

export interface CompanionDeviceRecord {
  id: string;
  name: string;
  firstSeen: number;
  lastSeen: number;
  address: string | null;
}

interface RegistryFile {
  pairingCode: string;
  devices: CompanionDeviceRecord[];
}

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return code;
}

/** "abcd-efgh-jkmn" or "ABCDEFGHJKMN" → "ABCDEFGHJKMN". */
export function normalizePairingCode(value: string): string {
  return value.toUpperCase().replace(/[^0-9A-Z]/g, '');
}

/** "ABCDEFGHJKMN" → "ABCD-EFGH-JKMN", for display. */
export function formatPairingCode(code: string): string {
  return normalizePairingCode(code).replace(/(.{4})(?=.)/g, '$1-');
}

export function isValidDeviceId(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{4,64}$/.test(value);
}

export function cleanDeviceName(value: unknown, fallback: string): string {
  const name = typeof value === 'string' ? [...value].filter((char) => char >= ' ' && char !== '\u007f').join('').trim().slice(0, 60) : '';
  return name || fallback;
}

export class CompanionRegistry {
  private data: RegistryFile = { pairingCode: '', devices: [] };
  private writing: Promise<void> = Promise.resolve();
  private loading: Promise<void> | null = null;

  constructor(
    private readonly filePath: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** Load once; later calls wait for the same load. */
  ensureLoaded(): Promise<void> {
    this.loading ??= this.load();
    return this.loading;
  }

  async load(): Promise<void> {
    try {
      const raw = JSON.parse(await fs.readFile(this.filePath, 'utf8')) as Partial<RegistryFile>;
      const code = typeof raw.pairingCode === 'string' ? normalizePairingCode(raw.pairingCode) : '';
      const devices = Array.isArray(raw.devices) ? raw.devices.filter(isDeviceRecord) : [];
      this.data = { pairingCode: code, devices };
    } catch {
      this.data = { pairingCode: '', devices: [] };
    }
    if (this.data.pairingCode.length < 8) {
      this.data.pairingCode = generatePairingCode();
      await this.save();
    }
  }

  get pairingCode(): string {
    return this.data.pairingCode;
  }

  /** Constant-time check of a code a client sent. */
  matches(candidate: string | null | undefined): boolean {
    if (!candidate || !this.data.pairingCode) {
      return false;
    }
    const given = Buffer.from(normalizePairingCode(candidate));
    const expected = Buffer.from(this.data.pairingCode);
    return given.length === expected.length && timingSafeEqual(given, expected);
  }

  /** A new code: every paired phone has to enter it again. */
  async rotate(): Promise<string> {
    await this.ensureLoaded();
    this.data.pairingCode = generatePairingCode();
    await this.save();
    return this.data.pairingCode;
  }

  list(): CompanionDeviceRecord[] {
    return [...this.data.devices].sort((a, b) => b.lastSeen - a.lastSeen);
  }

  get(id: string): CompanionDeviceRecord | undefined {
    return this.data.devices.find((device) => device.id === id);
  }

  /** Record that a device was seen; saved at most once a minute unless it is new or renamed. */
  touch(id: string, name: string, address: string | null): CompanionDeviceRecord {
    const time = this.now();
    let device = this.get(id);
    let changed = false;
    if (!device) {
      device = { id, name, firstSeen: time, lastSeen: time, address };
      this.data.devices.push(device);
      this.data.devices = this.list().slice(0, MAX_DEVICES);
      changed = true;
    } else {
      changed = device.name !== name || device.address !== address || time - device.lastSeen > 60_000;
      device.name = name;
      device.address = address;
      device.lastSeen = time;
    }
    if (changed) {
      void this.save();
    }
    return device;
  }

  async forget(id: string): Promise<void> {
    await this.ensureLoaded();
    this.data.devices = this.data.devices.filter((device) => device.id !== id);
    await this.save();
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.writing = this.writing
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.writeFile(this.filePath, snapshot, { encoding: 'utf8', mode: 0o600 });
      });
    return this.writing;
  }
}

function isDeviceRecord(value: unknown): value is CompanionDeviceRecord {
  const record = value as Partial<CompanionDeviceRecord> | null;
  return (
    typeof record === 'object' &&
    record !== null &&
    isValidDeviceId(record.id) &&
    typeof record.name === 'string' &&
    typeof record.firstSeen === 'number' &&
    typeof record.lastSeen === 'number'
  );
}
