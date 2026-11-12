/**
 * The first "speaks unprompted" behaviour. A slow tick looks at presence and, when there is a
 * reason (Kevin just came back, things were noted quietly), asks Laya (Quick decisions) whether
 * this is a good moment. If so, the avatar gets a system note and says one short line.
 *
 * Being quiet is the safe default: hard rules run first with no model call, and when Quick
 * decisions are off or fail the tick does nothing (there is no chat-model fallback).
 */
import type { SystemOneClient } from '../decide/system-one.js';
import type { SwitchboardBus } from '../switchboard/bus.js';
import type { PresenceTracker, PresenceVoicePhase } from './presence.js';

export const PROACTIVE_TICK_MS = 60_000;
export const PROACTIVE_MIN_GAP_MS = 20 * 60_000;
export const PROACTIVE_QUIET_HOURS = '22-7';
/** Kevin or an avatar spoke this recently: stay quiet. */
export const PROACTIVE_RECENT_SPEECH_MS = 2 * 60_000;
/** No face for this long, then one: he has come back. */
export const PROACTIVE_AWAY_MS = 30 * 60_000;
/** `act` must reach this. */
export const PROACTIVE_ACT_THRESHOLD = 0.75;
/** The top `what` choice must reach this. */
export const PROACTIVE_WHAT_THRESHOLD = 0.6;
const MAX_NOTES = 5;
const NOTE_CHARS = 120;
const BUSY_PHASES: readonly PresenceVoicePhase[] = ['listening', 'transcribing', 'thinking', 'responding'];

export type ProactiveReason = 'arrival' | 'noted';

type Logger = Pick<Console, 'warn'> & { debug?: (message: string, data?: Record<string, unknown>) => void; info?: (message: string, data?: Record<string, unknown>) => void };

/** Hours "22-7" (start-end, local, end exclusive, may wrap past midnight) as a pair, or null for none. */
export function parseQuietHours(value: string | undefined): { start: number; end: number } | null {
  const match = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(value ?? '');
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  if (start > 24 || end > 24 || start === end) return null;
  return { start: start % 24, end: end % 24 };
}

export function inQuietHours(hours: { start: number; end: number } | null, hour: number): boolean {
  if (!hours) return false;
  return hours.start < hours.end ? hour >= hours.start && hour < hours.end : hour >= hours.start || hour < hours.end;
}

export interface ProactiveTickOptions {
  presence: PresenceTracker;
  /** A client for the current routing, or null when Quick decisions are off. Built per tick. */
  makeClient: () => SystemOneClient | null;
  /** Gives the host avatar a system note (non-urgent). */
  notify: (text: string, options: { urgent: boolean; source?: string }) => void;
  avatarName?: () => string;
  bus?: () => SwitchboardBus | null | undefined;
  now?: () => number;
  tickMs?: number;
  minGapMs?: number;
  quietHours?: string;
  enabled?: boolean;
  logger?: Logger;
}

/** Reads the PROACTIVE_* settings from an environment. */
export function proactiveSettingsFromEnv(env: NodeJS.ProcessEnv): Pick<ProactiveTickOptions, 'tickMs' | 'minGapMs' | 'quietHours' | 'enabled'> {
  const num = (value: string | undefined, fallback: number): number => {
    const n = Number(value);
    return value && Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    tickMs: num(env.PROACTIVE_TICK_MS, PROACTIVE_TICK_MS),
    minGapMs: num(env.PROACTIVE_MIN_GAP_MS, PROACTIVE_MIN_GAP_MS),
    quietHours: env.PROACTIVE_QUIET_HOURS ?? PROACTIVE_QUIET_HOURS,
    enabled: env.PROACTIVE_ENABLED?.trim() !== '0',
  };
}

export class ProactiveTick {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastProactiveAt: number | null = null;
  private lastFaceSeenAt: number | null = null;
  private notes: Array<{ text: string; at: number }> = [];
  private readonly tickMs: number;
  private readonly minGapMs: number;
  private readonly quiet: { start: number; end: number } | null;
  private readonly now: () => number;

  constructor(private readonly options: ProactiveTickOptions) {
    this.tickMs = options.tickMs ?? PROACTIVE_TICK_MS;
    this.minGapMs = options.minGapMs ?? PROACTIVE_MIN_GAP_MS;
    this.quiet = parseQuietHours(options.quietHours ?? PROACTIVE_QUIET_HOURS);
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer || this.options.enabled === false) return;
    this.timer = setInterval(() => void this.check(), this.tickMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Feed from the inbox's quiet saves. Keeps the last few. */
  noteRemembered(text: string): void {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, NOTE_CHARS);
    if (!clean) return;
    this.notes.push({ text: clean, at: this.now() });
    if (this.notes.length > MAX_NOTES) this.notes.splice(0, this.notes.length - MAX_NOTES);
  }

  /** One tick. Returns true when it gave the avatar a note. Never throws. */
  async check(): Promise<boolean> {
    try {
      return await this.run();
    } catch (error) {
      this.options.logger?.warn('Proactive tick failed.', { message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }

  private async run(): Promise<boolean> {
    const now = this.now();
    const { presence } = this.options;
    const snap = presence.snapshot(now);
    const faceAt = snap.secondsSinceFaceSeen === null ? null : now - snap.secondsSinceFaceSeen * 1000;
    const assistantAt = snap.secondsSinceAssistantSpoke === null ? null : now - snap.secondsSinceAssistantSpoke * 1000;

    // Arrival: a face is in view now, and the sighting before it was long ago.
    let awayMs = 0;
    if (faceAt !== null && snap.secondsSinceFaceSeen !== null && snap.secondsSinceFaceSeen * 1000 <= this.tickMs) {
      if (this.lastFaceSeenAt !== null && faceAt - this.lastFaceSeenAt >= PROACTIVE_AWAY_MS) awayMs = faceAt - this.lastFaceSeenAt;
    }
    if (faceAt !== null) this.lastFaceSeenAt = faceAt;

    // Saves from before the avatar last spoke are old news.
    if (assistantAt !== null) this.notes = this.notes.filter((note) => note.at > assistantAt);

    if (snap.doNotDisturb) return false;
    if (BUSY_PHASES.includes(snap.voicePhase)) return false;
    if (snap.secondsSinceUserSpoke !== null && snap.secondsSinceUserSpoke * 1000 < PROACTIVE_RECENT_SPEECH_MS) return false;
    if (snap.secondsSinceAssistantSpoke !== null && snap.secondsSinceAssistantSpoke * 1000 < PROACTIVE_RECENT_SPEECH_MS) return false;
    if (inQuietHours(this.quiet, new Date(now).getHours())) return false;
    if (this.lastProactiveAt !== null && now - this.lastProactiveAt < this.minGapMs) return false;

    const reasons: ProactiveReason[] = [];
    if (awayMs > 0) reasons.push('arrival');
    if (this.notes.length > 0) reasons.push('noted');
    if (reasons.length === 0) return false;

    const client = this.options.makeClient();
    if (!client) return false;
    const name = this.options.avatarName?.() ?? 'Echo';
    const awayMinutes = Math.round(awayMs / 60_000);
    const criteria: Record<string, string> = { nothing: 'Say nothing now.' };
    if (reasons.includes('arrival')) criteria.arrival = 'Greet Kevin, who just came back after being away.';
    if (reasons.includes('noted')) criteria.noted = 'Mention something that was noted quietly while Kevin was busy.';
    const state = {
      kevin: {
        secondsSinceHeLastSpoke: snap.secondsSinceUserSpoke,
        secondsSinceFaceSeen: snap.secondsSinceFaceSeen,
        secondsSinceAvatarSpoke: snap.secondsSinceAssistantSpoke,
        microphoneOn: snap.listening,
        localTime: snap.localTime,
      },
      reasons: {
        ...(reasons.includes('arrival') ? { cameBackAfterMinutes: awayMinutes } : {}),
        ...(reasons.includes('noted') ? { notedItems: this.notes.slice(-3).map((note) => note.text) } : {}),
      },
    };
    let act = 0;
    let what: Record<string, number> = {};
    let acted = false;
    let chosen: string | null = null;
    try {
      const answers = await client.ask(state, {
        act: { type: 'noul', instructions: `Is this a good moment for ${name} to say something to Kevin unprompted?` },
        what: { type: 'choice', instructions: `What should ${name} say something about?`, criteria },
      });
      act = answers.act;
      what = answers.what;
    } catch (error) {
      this.options.logger?.warn('Proactive check: Quick decisions failed; staying quiet.', { message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    let best: { key: string; p: number } | null = null;
    for (const [key, p] of Object.entries(what)) if (!best || p > best.p) best = { key, p };
    if (act >= PROACTIVE_ACT_THRESHOLD && best && best.key !== 'nothing' && best.p >= PROACTIVE_WHAT_THRESHOLD && reasons.includes(best.key as ProactiveReason)) {
      chosen = best.key;
      acted = this.act(chosen as ProactiveReason, awayMinutes, now);
    }
    this.journal({ reasons, act, what, chosen, acted });
    return acted;
  }

  private act(reason: ProactiveReason, awayMinutes: number, now: number): boolean {
    let text: string;
    if (reason === 'arrival') {
      text = `[Kevin just came back after about ${awayMinutes} minutes away. Greet him in one short line.]`;
    } else {
      const quoted = this.notes.slice(-3).map((note) => `"${note.text}"`).join('; ');
      text = `[Things noted quietly since you last spoke: ${quoted}. If one is worth mentioning now, say it in one short line.]`;
    }
    try {
      this.options.notify(text, { urgent: false, source: 'proactive check' });
    } catch (error) {
      this.options.logger?.warn('Proactive note could not be sent.', { message: error instanceof Error ? error.message : String(error) });
      return false;
    }
    this.lastProactiveAt = now;
    if (reason === 'noted') this.notes = [];
    this.options.logger?.info?.('Proactive line sent to the avatar.', { reason });
    return true;
  }

  /** Fire-and-forget, private; never throws. */
  private journal(payload: Record<string, unknown>): void {
    try {
      const bus = this.options.bus?.();
      if (!bus) return;
      const id = `proactive:${this.now()}`;
      bus.publish({
        type: 'proactive.decision',
        producer: { kind: 'service', id: 'proactive' },
        to: [],
        audience: 'private',
        txn: { id, state: 'done', title: 'Proactive tick' },
        payload,
      });
    } catch {
      // Journaling must never disturb the tick.
    }
  }
}
