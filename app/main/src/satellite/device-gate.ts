/**
 * The privacy gate of a satellite PC (docs/features/satellite.md).
 *
 * Kevin's rule: a room's mic and camera are live only while at least one avatar is in the room, the screen is
 * unlocked, the link to bija is up, the room is open (Kevin did not close it) and no other app is full screen.
 * The gate lives in the satellite's main process, not in the page, and it fails closed: a fact that is not known
 * yet counts as "no". bija can ask devices off (`device.off`); it can never turn them on.
 *
 * This file is the pure part (facts in, result out, no Electron). `device-runtime.ts` wires it to the system.
 */

/** What the gate looks at. Every one must be true for the mic to be live. */
export interface DeviceFacts {
  /** At least one avatar is at this place and standing there (in transit does not count). */
  occupied: boolean;
  /** The screen is not locked. */
  unlocked: boolean;
  /** The link to bija is online. */
  linkUp: boolean;
  /** Kevin has not closed the room (the kill switch). Kept across restarts. */
  open: boolean;
  /** No other app is full screen on any monitor. */
  noFullscreenApp: boolean;
  /** bija has not asked the devices off. */
  notHeldOff: boolean;
}

export type DeviceLevel = 'off' | 'doorbell' | 'live';

export interface DeviceGateState extends DeviceFacts {
  /** The mic may be live: every fact is true. */
  micAllowed: boolean;
  /** Nobody is here but everything else is fine, and the room's doorbell setting is on: only the doorbell listens. */
  doorbell: boolean;
  mic: DeviceLevel;
  /** Off until the camera comes (a later update). */
  camera: 'off';
  speakers: 'off' | 'live';
  /** The same facts the way `device.state` names them. */
  locked: boolean;
  closed: boolean;
  fullscreen: boolean;
  /** Why the mic is off, in words for Kevin. Empty while it is live. */
  summary: string;
}

export const INITIAL_FACTS: DeviceFacts = {
  occupied: false,
  unlocked: true,
  linkUp: false,
  open: true,
  // Not known until the first check has answered: closed until then.
  noFullscreenApp: false,
  notHeldOff: true,
};

/** The first fact that is not true, in words. */
function whyOff(facts: DeviceFacts): string {
  if (!facts.open) return 'This room is closed';
  if (!facts.unlocked) return 'The screen is locked';
  if (!facts.noFullscreenApp) return 'Another app is full screen';
  if (!facts.linkUp) return 'Not connected to bija';
  if (!facts.notHeldOff) return 'bija turned the devices off';
  if (!facts.occupied) return 'Nobody is in this room';
  return '';
}

/** The result for a set of facts. Pure. */
export function evaluateGate(facts: DeviceFacts, doorbellEnabled = false): DeviceGateState {
  const others = facts.unlocked && facts.linkUp && facts.open && facts.noFullscreenApp && facts.notHeldOff;
  const micAllowed = facts.occupied && others;
  const doorbell = !facts.occupied && others && doorbellEnabled;
  const mic: DeviceLevel = micAllowed ? 'live' : doorbell ? 'doorbell' : 'off';
  return {
    ...facts,
    micAllowed,
    doorbell,
    mic,
    camera: 'off',
    speakers: facts.linkUp && facts.open ? 'live' : 'off',
    locked: !facts.unlocked,
    closed: !facts.open,
    fullscreen: !facts.noFullscreenApp,
    summary: doorbell ? 'Doorbell only' : whyOff(facts),
  };
}

/** Avatars that stand at this place, from a places snapshot (in transit they are nowhere). Anything unreadable gives none. */
export function avatarsHere(snapshot: unknown): string[] {
  if (!snapshot || typeof snapshot !== 'object') return [];
  const { locations, transit, localPlaceId } = snapshot as { locations?: unknown; transit?: unknown; localPlaceId?: unknown };
  if (!locations || typeof locations !== 'object' || typeof localPlaceId !== 'string') return [];
  const moving = new Set(Array.isArray(transit) ? transit.map((move) => (move as { avatarId?: unknown } | null)?.avatarId) : []);
  return Object.entries(locations as Record<string, unknown>)
    .filter(([avatarId, placeId]) => placeId === localPlaceId && !moving.has(avatarId))
    .map(([avatarId]) => avatarId);
}

export interface DeviceGateOptions {
  facts?: Partial<DeviceFacts>;
  /** The place's doorbell setting. Default off for satellites. */
  doorbellEnabled?: boolean;
  /** Called after any change, with the new state and the names of the facts that changed. */
  onChange?: (state: DeviceGateState, changed: Array<keyof DeviceFacts>) => void;
  /** Reloads the page. Called when the page did not report capture stopped in time, which drops every media stream. */
  reloadRenderer: () => void;
  /** How long the page gets to confirm that capture stopped. */
  captureTimeoutMs?: number;
  logger?: Pick<Console, 'warn' | 'info'>;
}

export const CAPTURE_STOP_TIMEOUT_MS = 1000;

export class DeviceGate {
  private facts: DeviceFacts;
  private current: DeviceGateState;
  private doorbellEnabled: boolean;
  private watchdog: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: DeviceGateOptions) {
    this.facts = { ...INITIAL_FACTS, ...options.facts };
    this.doorbellEnabled = options.doorbellEnabled === true;
    this.current = evaluateGate(this.facts, this.doorbellEnabled);
  }

  state(): DeviceGateState {
    return { ...this.current };
  }

  /** What permission requests for the mic (and later the camera) are answered with. */
  allowsMedia(): boolean {
    return this.current.micAllowed || this.current.doorbell;
  }

  /** Sets facts. Nothing happens when nothing changed. */
  update(patch: Partial<DeviceFacts>): DeviceGateState {
    const changed = (Object.keys(patch) as Array<keyof DeviceFacts>).filter((key) => patch[key] !== undefined && patch[key] !== this.facts[key]);
    if (changed.length === 0) return this.state();
    const next: DeviceFacts = { ...this.facts };
    for (const key of changed) next[key] = patch[key] as boolean;
    this.facts = next;
    return this.recompute(changed);
  }

  setDoorbellEnabled(enabled: boolean): void {
    if (enabled === this.doorbellEnabled) return;
    this.doorbellEnabled = enabled;
    this.recompute([]);
  }

  private recompute(changed: Array<keyof DeviceFacts>): DeviceGateState {
    const before = this.current;
    this.current = evaluateGate(this.facts, this.doorbellEnabled);
    const closing = this.allowedIn(before) && !this.allowedIn(this.current);
    if (closing) this.armWatchdog();
    else if (this.allowedIn(this.current)) this.clearWatchdog();
    this.options.onChange?.(this.state(), changed);
    return this.state();
  }

  private allowedIn(state: DeviceGateState): boolean {
    return state.micAllowed || state.doorbell;
  }

  /**
   * The page says every capture track is stopped. Without that the gate cannot know the mic is really off, so
   * after `captureTimeoutMs` it reloads the page, which drops every media stream.
   */
  captureStopped(): void {
    this.clearWatchdog();
  }

  private armWatchdog(): void {
    this.clearWatchdog();
    this.watchdog = setTimeout(() => {
      this.watchdog = null;
      this.options.logger?.warn('The page did not confirm that capture stopped; reloading it');
      try {
        this.options.reloadRenderer();
      } catch (error) {
        this.options.logger?.warn('Could not reload the page', { message: error instanceof Error ? error.message : String(error) });
      }
    }, this.options.captureTimeoutMs ?? CAPTURE_STOP_TIMEOUT_MS);
    this.watchdog.unref?.();
  }

  private clearWatchdog(): void {
    if (this.watchdog) clearTimeout(this.watchdog);
    this.watchdog = null;
  }

  dispose(): void {
    this.clearWatchdog();
  }
}

// -- Permissions ---------------------------------------------------------------------------------

/** The slice of Electron's `session` this uses. */
export interface PermissionSession {
  setPermissionRequestHandler(handler: ((webContents: unknown, permission: string, callback: (granted: boolean) => void, details?: unknown) => void) | null): void;
  setPermissionCheckHandler(handler: ((webContents: unknown, permission: string, origin?: string, details?: unknown) => boolean) | null): void;
}

const MEDIA_PERMISSIONS = new Set(['media', 'audioCapture', 'videoCapture']);

/**
 * While the gate is closed the page cannot start a new capture: `getUserMedia` is refused at the source. Every
 * other permission is answered as before the gate existed (granted).
 */
export function guardMediaPermissions(session: PermissionSession, gate: Pick<DeviceGate, 'allowsMedia'>): void {
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(MEDIA_PERMISSIONS.has(permission) ? gate.allowsMedia() : true);
  });
  session.setPermissionCheckHandler((_webContents, permission) => (MEDIA_PERMISSIONS.has(permission) ? gate.allowsMedia() : true));
}
