/**
 * What Echo knows about whether Kevin is around: microphone, voice phase, when each side last
 * spoke, whether the camera sees a face, and do-not-disturb (persisted). The deliberator reads
 * `describe()` as part of its prompt. Everything here is best effort and never throws.
 */
export type PresenceVoicePhase = 'off' | 'waiting' | 'listening' | 'transcribing' | 'thinking' | 'responding' | 'error';

export const PRESENCE_DND_KEY = 'presence.doNotDisturb';
const VOICE_PHASES: readonly PresenceVoicePhase[] = ['off', 'waiting', 'listening', 'transcribing', 'thinking', 'responding', 'error'];

export interface PresenceStore {
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

export interface PresenceState {
  doNotDisturb: boolean;
  listening: boolean;
  voicePhase: PresenceVoicePhase;
  /** ms since epoch; null when it has not happened since the app started. */
  lastUserSpeechAt: number | null;
  lastAssistantSpokeAt: number | null;
  faceSeenAt: number | null;
}

export type PresenceUpdate = Partial<PresenceState>;

export interface PresenceSnapshot {
  doNotDisturb: boolean;
  listening: boolean;
  voicePhase: PresenceVoicePhase;
  secondsSinceUserSpoke: number | null;
  secondsSinceAssistantSpoke: number | null;
  secondsSinceFaceSeen: number | null;
  /** Local time, e.g. "Tue 21:40". */
  localTime: string;
}

export function isVoicePhase(value: unknown): value is PresenceVoicePhase {
  return typeof value === 'string' && (VOICE_PHASES as readonly string[]).includes(value);
}

const age = (now: number, at: number | null): number | null => (at === null ? null : Math.max(0, Math.round((now - at) / 1000)));

function span(seconds: number): string {
  if (seconds < 120) return `${seconds} s`;
  if (seconds < 7200) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

export class PresenceTracker {
  private state: PresenceState;

  constructor(private readonly store?: PresenceStore) {
    this.state = { doNotDisturb: this.readDnd(), listening: false, voicePhase: 'off', lastUserSpeechAt: null, lastAssistantSpokeAt: null, faceSeenAt: null };
  }

  private readDnd(): boolean {
    try {
      return this.store?.getValue(PRESENCE_DND_KEY) === '1';
    } catch {
      return false;
    }
  }

  /** Reads the saved do-not-disturb again, for a store that opens after the tracker is made. */
  hydrate(): void {
    this.state = { ...this.state, doNotDisturb: this.readDnd() };
  }

  get doNotDisturb(): boolean {
    return this.state.doNotDisturb;
  }

  update(partial: PresenceUpdate): void {
    const next = { ...this.state };
    if (typeof partial.listening === 'boolean') next.listening = partial.listening;
    if (isVoicePhase(partial.voicePhase)) next.voicePhase = partial.voicePhase;
    for (const key of ['lastUserSpeechAt', 'lastAssistantSpokeAt', 'faceSeenAt'] as const) {
      const value = partial[key];
      if (value === null || (typeof value === 'number' && Number.isFinite(value))) next[key] = value;
    }
    if (typeof partial.doNotDisturb === 'boolean' && partial.doNotDisturb !== next.doNotDisturb) {
      next.doNotDisturb = partial.doNotDisturb;
      try {
        this.store?.setValue(PRESENCE_DND_KEY, partial.doNotDisturb ? '1' : '0');
      } catch {
        // Keep the in-memory value even when it cannot be saved.
      }
    }
    this.state = next;
  }

  snapshot(now: number = Date.now()): PresenceSnapshot {
    const s = this.state;
    const date = new Date(now);
    const day = date.toLocaleDateString('en-US', { weekday: 'short' });
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return {
      doNotDisturb: s.doNotDisturb,
      listening: s.listening,
      voicePhase: s.voicePhase,
      secondsSinceUserSpoke: age(now, s.lastUserSpeechAt),
      secondsSinceAssistantSpoke: age(now, s.lastAssistantSpokeAt),
      secondsSinceFaceSeen: age(now, s.faceSeenAt),
      localTime: `${day} ${time}`,
    };
  }

  describe(now: number = Date.now()): string {
    const p = this.snapshot(now);
    const lines = [
      p.secondsSinceUserSpoke === null ? 'Kevin has not spoken since the app started' : `Kevin last spoke ${span(p.secondsSinceUserSpoke)} ago`,
      p.secondsSinceAssistantSpoke === null ? 'No avatar has spoken yet' : `An avatar last spoke ${span(p.secondsSinceAssistantSpoke)} ago`,
      `microphone ${p.listening ? 'on' : 'off'}; voice state: ${p.voicePhase}`,
      p.secondsSinceFaceSeen === null ? 'camera has not seen a face' : `camera saw a face ${span(p.secondsSinceFaceSeen)} ago`,
      `do not disturb: ${p.doNotDisturb ? 'on' : 'off'}`,
      `local time ${p.localTime}`,
    ];
    return lines.join('\n');
  }
}
