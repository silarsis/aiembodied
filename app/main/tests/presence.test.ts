import { describe, expect, it } from 'vitest';
import { PRESENCE_DND_KEY, PresenceTracker } from '../src/presence/presence.js';

function store(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { data, getValue: (k: string) => data.get(k) ?? null, setValue: (k: string, v: string) => void data.set(k, v) };
}

describe('PresenceTracker', () => {
  const now = new Date(2026, 10, 10, 21, 40, 0).getTime(); // Tue 21:40 local

  it('snapshots ages in seconds and describes them', () => {
    const p = new PresenceTracker();
    p.update({ listening: true, voicePhase: 'waiting', lastUserSpeechAt: now - 12_000, faceSeenAt: now - 300_000 });
    const snap = p.snapshot(now);
    expect(snap).toMatchObject({ listening: true, voicePhase: 'waiting', secondsSinceUserSpoke: 12, secondsSinceAssistantSpoke: null, secondsSinceFaceSeen: 300, doNotDisturb: false, localTime: 'Tue 21:40' });
    const text = p.describe(now);
    expect(text).toContain('Kevin last spoke 12 s ago');
    expect(text).toContain('microphone on');
    expect(text).toContain('camera saw a face 5 min ago');
    expect(text).toContain('do not disturb: off');
    expect(text).toContain('local time Tue 21:40');
    expect(text).toContain('Echo has not spoken yet');
  });

  it('ignores invalid updates', () => {
    const p = new PresenceTracker();
    p.update({ voicePhase: 'bogus' as never, listening: 'yes' as never, lastUserSpeechAt: Number.NaN });
    expect(p.snapshot(now)).toMatchObject({ voicePhase: 'off', listening: false, secondsSinceUserSpoke: null });
  });

  it('persists do-not-disturb and hydrates late', () => {
    const s = store();
    const p = new PresenceTracker(s);
    p.update({ doNotDisturb: true });
    expect(s.data.get(PRESENCE_DND_KEY)).toBe('1');
    expect(new PresenceTracker(s).doNotDisturb).toBe(true);
    p.update({ doNotDisturb: false });
    expect(s.data.get(PRESENCE_DND_KEY)).toBe('0');
    let ready = false;
    const late = new PresenceTracker({ getValue: () => (ready ? '1' : null), setValue: () => undefined });
    expect(late.doNotDisturb).toBe(false);
    ready = true;
    late.hydrate();
    expect(late.doNotDisturb).toBe(true);
  });

  it('survives a failing store', () => {
    const p = new PresenceTracker({ getValue: () => { throw new Error('x'); }, setValue: () => { throw new Error('x'); } });
    p.update({ doNotDisturb: true });
    expect(p.doNotDisturb).toBe(true);
  });
});
