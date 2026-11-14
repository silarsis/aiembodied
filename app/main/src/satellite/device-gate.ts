/**
 * The privacy gate of a satellite PC (docs/features/satellite.md).
 *
 * Kevin's rule: a room's mic and camera are live only while at least one avatar is in the room (the camera also
 * needs the room's "Camera presence" setting), the screen is
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
  /** This place's "Camera presence" setting, as bija last sent it. Not known yet counts as off. */
  cameraEnabled: boolean;
}

/** Facts as callers may give them: the camera setting can be left out and then counts as off. */
export type GateFacts = Omit<DeviceFacts, 'cameraEnabled'> & Partial<Pick<DeviceFacts, 'cameraEnabled'>>;

export type DeviceLevel = 'off' | 'doorbell' | 'live';

export interface DeviceGateState extends DeviceFacts {
  /** The mic may be live: every fact is true. */
  micAllowed: boolean;
  /** Nobody is here but everything else is fine, and the room's doorbell setting is on: only the doorbell listens. */
  doorbell: boolean;
  mic: DeviceLevel;
  /** The camera may be live: every fact the mic needs is true, and the place's camera setting is on. */
  cameraAllowed: boolean;
  /** The camera never has a doorbell level: it is live or off. */
  camera: 'off' | 'live';
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
  // Not known until bija's first snapshot has arrived: off until then.
  cameraEnabled: false,
};

/** The first fact that is not true, in words. */
function whyOff(facts: GateFacts): string {
  if (!facts.open) return 'This room is closed';
  if (!facts.unlocked) return 'The screen is locked';
  if (!facts.noFullscreenApp) return 'Another app is full screen';
  if (!facts.linkUp) return 'Not connected to bija';
  if (!facts.notHeldOff) return 'bija turned the devices off';
  if (!facts.occupied) return 'Nobody is in this room';
  return '';
}

/** Why the camera is off while the mic is live, in words for Kevin. Empty while it is live or when the mic is off too. */
export function cameraWhyOff(facts: GateFacts): string {
  return whyOff(facts) === '' && facts.cameraEnabled !== true ? 'Camera presence is off for this room' : '';
}

/** The result for a set of facts. Pure. */
export function evaluateGate(facts: GateFacts, doorbellEnabled = false): DeviceGateState {
  const others = facts.unlocked && facts.linkUp && facts.open && facts.noFullscreenApp && facts.notHeldOff;
  const micAllowed = facts.occupied && others;
  const doorbell = !facts.occupied && others && doorbellEnabled;
  // The camera needs everything the mic needs (an avatar is here, nothing blocks the room) and the room's own setting.
  const cameraAllowed = micAllowed && facts.cameraEnabled === true;
  const mic: DeviceLevel = micAllowed ? 'live' : doorbell ? 'doorbell' : 'off';
  return {
    ...facts,
    cameraEnabled: facts.cameraEnabled === true,
    micAllowed,
    doorbell,
    mic,
    cameraAllowed,
    camera: cameraAllowed ? 'live' : 'off',
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

  /**
   * What permission requests for media are answered with. A request that includes video needs the camera to be
   * allowed; an audio-only request needs the mic; a request for both needs both. 'any' is for the advisory
   * permission check, which cannot tell the devices apart: true while either may be live.
   *
   * The doorbell does not open the page's microphone: it listens in the main process (the wake word worker), and
   * audio never leaves the PC in doorbell mode.
   */
  allowsMedia(kind: 'audio' | 'video' | 'both' | 'any' = 'any'): boolean {
    const micOk = this.current.micAllowed;
    if (kind === 'audio') return micOk;
    if (kind === 'video') return this.current.cameraAllowed;
    if (kind === 'both') return micOk && this.current.cameraAllowed;
    return micOk || this.current.cameraAllowed;
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
    // Closing the mic or the camera alone both need the page to confirm that its tracks stopped.
    const closing = (this.allowedIn(before) && !this.allowedIn(this.current)) || (before.cameraAllowed && !this.current.cameraAllowed);
    if (closing) this.armWatchdog();
    else if (this.allowedIn(this.current) && !this.allowedIn(before)) this.clearWatchdog();
    this.options.onChange?.(this.state(), changed);
    return this.state();
  }

  /** The page's own microphone may be live. The doorbell is not that: it listens in the main process. */
  private allowedIn(state: DeviceGateState): boolean {
    return state.micAllowed;
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

/** Which devices a media permission asks for. Anything that cannot be read counts as both (fail closed). */
export function mediaKind(permission: string, details: unknown): 'audio' | 'video' | 'both' {
  if (permission === 'audioCapture') return 'audio';
  if (permission === 'videoCapture') return 'video';
  const info = (details && typeof details === 'object' ? details : {}) as { mediaTypes?: unknown; mediaType?: unknown };
  // A request lists `mediaTypes: ['video', 'audio']`; a check names one `mediaType`.
  const types = Array.isArray(info.mediaTypes) ? info.mediaTypes : typeof info.mediaType === 'string' ? [info.mediaType] : [];
  const video = types.includes('video');
  const audio = types.includes('audio');
  if (video && audio) return 'both';
  if (video) return 'video';
  if (audio) return 'audio';
  return 'both';
}

/**
 * While the gate is closed the page cannot start a new capture: `getUserMedia` is refused at the source, the mic
 * and the camera each by their own rule. Every other permission is answered as before the gate existed (granted).
 */
export function guardMediaPermissions(session: PermissionSession, gate: Pick<DeviceGate, 'allowsMedia'>): void {
  session.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    callback(MEDIA_PERMISSIONS.has(permission) ? gate.allowsMedia(mediaKind(permission, details)) : true);
  });
  // The check is advisory (real capture goes through the request above) and may not say which device it means.
  session.setPermissionCheckHandler((_webContents, permission, _origin, details) => {
    if (!MEDIA_PERMISSIONS.has(permission)) return true;
    const kind = mediaKind(permission, details);
    return gate.allowsMedia(kind === 'both' ? 'any' : kind);
  });
}
