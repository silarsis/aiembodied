import { describe, expect, it, vi } from 'vitest';
import type { SystemOneClient } from '../src/decide/system-one.js';
import { PresenceTracker } from '../src/presence/presence.js';
import { ProactiveTick, inQuietHours, parseQuietHours, proactiveSettingsFromEnv } from '../src/presence/proactive-tick.js';

const MIN = 60_000;
// Local noon on a fixed day, so quiet hours (22-7) do not apply.
const NOON = new Date(2026, 10, 12, 12, 0, 0).getTime();

function setup(opts: { answers?: { act: number; what: Record<string, number> } | null; minGapMs?: number; quietHours?: string } = {}) {
  let t = NOON;
  const presence = new PresenceTracker();
  // By default the model likes whichever reason was offered.
  const ask = vi.fn(async (_state: unknown, questions: { what: { criteria: Record<string, string> } }) => {
    if (opts.answers) return opts.answers;
    const what: Record<string, number> = {};
    for (const key of Object.keys(questions.what.criteria)) what[key] = key === 'nothing' ? 0.1 : 0.8;
    return { act: 0.9, what };
  });
  const notify = vi.fn();
  const publish = vi.fn();
  let client: SystemOneClient | null = { ask } as unknown as SystemOneClient;
  const tick = new ProactiveTick({
    presence, notify, now: () => t, makeClient: () => client, bus: () => ({ publish } as never),
    minGapMs: opts.minGapMs, quietHours: opts.quietHours,
  });
  return { tick, presence, ask, notify, publish, advance: (ms: number) => (t += ms), setClient: (c: null) => (client = c), clock: () => t };
}

/** Kevin was seen, leaves for 40 minutes, and is seen again. */
function arrive(s: ReturnType<typeof setup>) {
  s.presence.update({ faceSeenAt: s.clock() });
  return s.tick.check().then(() => {
    s.advance(40 * MIN);
    s.presence.update({ faceSeenAt: s.clock() });
  });
}

describe('quiet hours', () => {
  it('parses and wraps past midnight', () => {
    expect(parseQuietHours('22-7')).toEqual({ start: 22, end: 7 });
    expect(parseQuietHours('nope')).toBeNull();
    expect(parseQuietHours('5-5')).toBeNull();
    const q = parseQuietHours('22-7');
    expect([23, 0, 6, 22].every((h) => inQuietHours(q, h))).toBe(true);
    expect([7, 12, 21].some((h) => inQuietHours(q, h))).toBe(false);
    expect(inQuietHours(parseQuietHours('9-17'), 12)).toBe(true);
    expect(inQuietHours(parseQuietHours('9-17'), 17)).toBe(false);
  });
  it('reads the env', () => {
    expect(proactiveSettingsFromEnv({}).enabled).toBe(true);
    expect(proactiveSettingsFromEnv({ PROACTIVE_ENABLED: '0', PROACTIVE_TICK_MS: '5000' })).toMatchObject({ enabled: false, tickMs: 5000, minGapMs: 20 * MIN });
  });
});

describe('ProactiveTick', () => {
  it('greets on arrival', async () => {
    const s = setup();
    await arrive(s);
    expect(await s.tick.check()).toBe(true);
    expect(s.notify).toHaveBeenCalledWith('[Kevin just came back after about 40 minutes away. Greet him in one short line.]', expect.objectContaining({ urgent: false }));
    expect(s.publish).toHaveBeenCalledWith(expect.objectContaining({ type: 'proactive.decision', audience: 'private', payload: expect.objectContaining({ acted: true, chosen: 'arrival' }) }));
  });
  it('does not greet when the app just started with a face in view', async () => {
    const s = setup();
    s.presence.update({ faceSeenAt: s.clock() });
    expect(await s.tick.check()).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
  });
  it('mentions noted items', async () => {
    const s = setup();
    s.tick.noteRemembered('Build finished');
    s.tick.noteRemembered('Door opened');
    expect(await s.tick.check()).toBe(true);
    expect(s.notify.mock.calls[0][0]).toBe('[Things noted quietly since you last spoke: "Build finished"; "Door opened". If one is worth mentioning now, say it in one short line.]');
  });
  it('clears notes once the avatar has spoken', async () => {
    const s = setup();
    s.tick.noteRemembered('old');
    s.advance(5 * MIN);
    s.presence.update({ lastAssistantSpokeAt: s.clock() - 4 * MIN + 0 });
    s.advance(10 * MIN);
    expect(await s.tick.check()).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
  });
  it.each([
    ['do not disturb', (s: ReturnType<typeof setup>) => s.presence.update({ doNotDisturb: true })],
    ['a voice turn', (s: ReturnType<typeof setup>) => s.presence.update({ voicePhase: 'thinking' })],
    ['Kevin spoke', (s: ReturnType<typeof setup>) => s.presence.update({ lastUserSpeechAt: s.clock() - 30_000 })],
    ['an avatar spoke', (s: ReturnType<typeof setup>) => s.presence.update({ lastAssistantSpokeAt: s.clock() - 30_000 })],
  ])('%s blocks without a model call', async (_name, block) => {
    const s = setup();
    s.tick.noteRemembered('something');
    block(s);
    expect(await s.tick.check()).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
    expect(s.notify).not.toHaveBeenCalled();
  });
  it('quiet hours block', async () => {
    const s = setup({ quietHours: '0-24' });
    s.tick.noteRemembered('something');
    expect(await s.tick.check()).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
  });
  it('does nothing without a reason', async () => {
    const s = setup();
    expect(await s.tick.check()).toBe(false);
    expect(s.ask).not.toHaveBeenCalled();
  });
  it('low probabilities do nothing but are journalled', async () => {
    for (const answers of [
      { act: 0.5, what: { noted: 0.9, nothing: 0.1 } },
      { act: 0.9, what: { noted: 0.5, nothing: 0.5 } },
      { act: 0.9, what: { noted: 0.1, nothing: 0.9 } },
    ]) {
      const s = setup({ answers });
      s.tick.noteRemembered('x');
      expect(await s.tick.check()).toBe(false);
      expect(s.notify).not.toHaveBeenCalled();
      expect(s.publish).toHaveBeenCalledWith(expect.objectContaining({ payload: expect.objectContaining({ acted: false }) }));
    }
  });
  it('does nothing when Quick decisions are off or fail', async () => {
    const s = setup();
    s.tick.noteRemembered('x');
    s.setClient(null);
    expect(await s.tick.check()).toBe(false);
    const f = setup();
    f.tick.noteRemembered('x');
    f.ask.mockRejectedValueOnce(new Error('down'));
    expect(await f.tick.check()).toBe(false);
    expect(f.notify).not.toHaveBeenCalled();
  });
  it('keeps the minimum gap', async () => {
    const s = setup({ minGapMs: 20 * MIN });
    s.tick.noteRemembered('a');
    expect(await s.tick.check()).toBe(true);
    s.advance(5 * MIN);
    s.tick.noteRemembered('b');
    expect(await s.tick.check()).toBe(false);
    s.advance(20 * MIN);
    expect(await s.tick.check()).toBe(true);
    expect(s.notify).toHaveBeenCalledTimes(2);
  });
});
