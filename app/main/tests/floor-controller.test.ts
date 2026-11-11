import { describe, expect, it, vi } from 'vitest';
import { FloorController, HEAR_CHATTER_KEY, chatterNote } from '../src/floor/index.js';
import type { FloorBid } from '../src/floor/floor-manager.js';
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../src/local-voice/types.js';
import type { SwitchboardEventInput } from '../src/switchboard/types.js';
import { avatarIdForName, ensureExtraAvatars, parseExtraAvatarNames, defaultPersonaPrompt } from '../src/avatars/extra-avatars.js';
import { AvatarRegistry } from '../src/avatars/avatar-registry.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
  { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
  { id: 'rex', name: 'Rex', vrmModelId: 'm1' },
];

function harness(options: { replies?: Record<string, string[]>; bids?: FloorBid[]; hear?: boolean; profiles?: typeof PROFILES } = {}) {
  const kv = new Map<string, string>();
  if (options.hear) kv.set(HEAR_CHATTER_KEY, '1');
  const published: SwitchboardEventInput[] = [];
  const turns: Array<{ avatarId: string; request: LocalVoiceRespondRequest }> = [];
  const saved: Array<{ speaker: string; content: string }> = [];
  const forwarded: LocalVoiceEvent[] = [];
  const cancelled: string[] = [];
  const replies = new Map(Object.entries(options.replies ?? {}));
  const gates = new Map<string, () => void>();
  const hold = new Set<string>();

  const respond = (avatarId: string) => async (request: LocalVoiceRespondRequest, emit: (event: LocalVoiceEvent) => void): Promise<LocalVoiceRespondResult> => {
    turns.push({ avatarId, request });
    emit({ requestId: request.requestId, type: 'sentence', index: 0, text: 'x', wav: new Uint8Array(request.silent ? 0 : 3) });
    if (hold.has(avatarId)) await new Promise<void>((resolve) => gates.set(avatarId, resolve));
    const text = replies.get(avatarId)?.shift() ?? '';
    return { requestId: request.requestId, text, cancelled: false };
  };
  const controller = new FloorController({
    registry: { list: () => options.profiles ?? PROFILES, get: (id) => (options.profiles ?? PROFILES).find((p) => p.id === id) ?? null },
    store: { getValue: (key) => kv.get(key) ?? null, setValue: (key, value) => void kv.set(key, value) },
    voice: (avatarId) => ({ respond: respond(avatarId), cancel: () => void cancelled.push(avatarId) }),
    runPersonTurn: (avatarId, request) => respond(avatarId)(request, () => undefined),
    emitChatter: (_id, event) => void forwarded.push(event),
    saveLine: (line) => void saved.push(line),
    instructionsFor: (avatarId) => `You are ${avatarId}.`,
    bus: () => ({ publish: (event) => (published.push(event), null), subscribe: () => () => undefined, connected: () => false }),
    bid: async () => options.bids ?? [],
    now: () => 1_000,
  });
  return { controller, kv, published, turns, saved, forwarded, cancelled, hold, gates };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
const types = (published: SwitchboardEventInput[]) => published.map((e) => e.type);

describe('FloorController', () => {
  it('stores the Hear avatar chatter setting, off by default', () => {
    const { controller, kv } = harness();
    expect(controller.hearChatter()).toBe(false);
    expect(controller.setHearChatter(true)).toBe(true);
    expect(kv.get(HEAR_CHATTER_KEY)).toBe('1');
    expect(controller.setHearChatter(false)).toBe(false);
  });

  it('is not multi with one avatar', () => {
    expect(harness({ profiles: [PROFILES[0]] }).controller.isMulti()).toBe(false);
    expect(harness().controller.isMulti()).toBe(true);
  });

  it('runs the named avatar for Kevin and journals the decision in the turn txn', async () => {
    const h = harness({ replies: { sage: ['I think so.'] } });
    const result = await h.controller.respondToPerson({ requestId: 'r1', text: 'Sage, what do you think?' });
    expect(result.text).toBe('I think so.');
    expect(h.turns.map((t) => [t.avatarId, t.request.avatarId, t.request.requestId])).toEqual([['sage', 'sage', 'r1']]);
    const decision = h.published.find((e) => e.type === 'floor.decision');
    expect(decision).toMatchObject({ audience: 'private', to: [], txn: { id: 'turn:r1' } });
    expect(decision?.txn?.state).toBeUndefined();
    expect(decision?.payload).toMatchObject({ channel: 'aloud', speakers: [{ avatarId: 'sage', reason: 'addressed' }] });
    expect((decision?.payload.trace as string[]).length).toBeGreaterThan(0);
    expect(h.published.find((e) => e.type === 'floor.grant')?.payload).toMatchObject({ avatar: 'sage', reason: 'addressed' });
  });

  it('runs the first named avatar now and queues the rest in order, each with its own request id', async () => {
    const h = harness({ replies: { rex: ['Rex here.'] } });
    h.hold.add('rex');
    const first = h.controller.respondToPerson({ requestId: 'r1', text: 'Rex and Sage, settle this' });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['rex']);
    h.hold.delete('rex');
    h.gates.get('rex')?.();
    await first;
    await settle();
    expect(h.turns.map((t) => [t.avatarId, t.request.requestId])).toEqual([['rex', 'r1'], ['sage', 'r1:sage']]);
    expect(types(h.published)).toContain('floor.release');
  });

  it('with several speakers named, never runs two at once', async () => {
    const h = harness();
    h.hold.add('echo');
    h.hold.add('sage');
    const done = h.controller.respondToPerson({ requestId: 'r1', text: 'you two' });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo']);
    h.gates.get('echo')?.();
    await done;
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage']);
    expect(h.controller.manager.state().speaking).toBe('sage');
    h.gates.get('sage')?.();
    await settle();
    expect(h.controller.manager.state().speaking).toBeNull();
  });

  it('runs a silent back-channel turn for the avatar chosen from a reply, and saves the reply line', async () => {
    const h = harness({ replies: { echo: ['Sage, do you agree?'], sage: ['Yes, I do.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, any thoughts?' });
    await settle();
    const chatter = h.turns.find((t) => t.avatarId === 'sage');
    expect(chatter?.request).toMatchObject({
      avatarId: 'sage',
      silent: true,
      text: '[Echo said to you, not Kevin: "Sage, do you agree?"]',
      instructions: 'You are sage.',
    });
    expect(h.saved).toEqual([{ speaker: 'sage', content: 'Yes, I do.', ts: 1_000 }]);
    expect(h.forwarded).toEqual([]);
    const decisions = h.published.filter((e) => e.type === 'floor.decision');
    // Kevin's turn, Echo's line to Sage, and Sage's reply (nobody bids for it).
    expect(decisions).toHaveLength(3);
    expect(decisions[1]).toMatchObject({ txn: { id: expect.stringMatching(/^chatter:/) }, producer: { kind: 'avatar', id: 'echo' } });
    expect(decisions[1].payload).toMatchObject({ channel: 'back', speakers: [{ avatarId: 'sage', reason: 'addressed' }] });
  });

  it('speaks chatter normally when Hear avatar chatter is on, with events carrying the avatar id', async () => {
    const h = harness({ hear: true, replies: { echo: ['Sage, do you agree?'], sage: ['Yes.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, any thoughts?' });
    await settle();
    const chatter = h.turns.find((t) => t.avatarId === 'sage');
    expect(chatter?.request.silent).toBe(false);
    expect(h.forwarded).toEqual([expect.objectContaining({ type: 'sentence', avatarId: 'sage' })]);
    expect((h.forwarded[0] as { wav: Uint8Array }).wav.length).toBeGreaterThan(0);
  });

  it('uses a bid when nobody is named, and says nothing when no bid wins', async () => {
    const won = harness({ replies: { echo: ['Interesting question.'], rex: ['Hm.'] }, bids: [{ avatarId: 'rex', want: 0.9, reason: 'curious' }] });
    await won.controller.respondToPerson({ requestId: 'r1', text: 'what is time?' });
    await settle();
    expect(won.turns.map((t) => t.avatarId)).toEqual(['echo', 'rex']);
    const quiet = harness({ replies: { echo: ['Interesting question.'] }, bids: [{ avatarId: 'rex', want: 0.1, reason: '' }] });
    await quiet.controller.respondToPerson({ requestId: 'r1', text: 'what is time?' });
    await settle();
    expect(quiet.turns.map((t) => t.avatarId)).toEqual(['echo']);
  });

  it('cuts chatter off after the turn budget and journals floor.budget', async () => {
    const h = harness({
      replies: { echo: ['Sage?', 'Sage?', 'Sage?'], sage: ['Echo?', 'Echo?', 'Echo?'] },
    });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, go' });
    await settle();
    await settle();
    // echo (Kevin) then four chatter turns, then silence.
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage', 'echo', 'sage', 'echo']);
    const budget = h.published.filter((e) => e.type === 'floor.budget');
    expect(budget).toHaveLength(1);
    expect(budget[0].payload).toMatchObject({ kind: 'turns', turns: 4 });
    expect(h.controller.manager.state().speaking).toBeNull();
  });

  it('lets Kevin win: his next utterance cancels the speaker, clears the queue and stops old chains', async () => {
    const h = harness({ replies: { echo: ['Done.'], sage: ['Sage says hi.'] } });
    h.hold.add('echo');
    const first = h.controller.respondToPerson({ requestId: 'r1', text: 'you two' });
    await settle();
    h.hold.delete('echo');
    const second = h.controller.respondToPerson({ requestId: 'r2', text: 'Rex, wait' });
    await settle();
    expect(h.cancelled).toEqual(['echo']);
    h.gates.get('echo')?.();
    await Promise.all([first, second]);
    await settle();
    // Sage (queued behind Echo) never ran; Rex answered the interruption.
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'rex']);
    expect(h.controller.manager.state().queue).toEqual([]);
  });

  it('publishes nothing and never throws when the bus is down', async () => {
    const h = harness({ replies: { echo: ['Hello.'] } });
    const controller = new FloorController({
      registry: { list: () => PROFILES, get: (id) => PROFILES.find((p) => p.id === id) ?? null },
      store: { getValue: () => null, setValue: () => undefined },
      voice: () => null,
      runPersonTurn: (avatarId, request) => Promise.resolve({ requestId: request.requestId, text: avatarId, cancelled: false }),
      saveLine: () => undefined,
      bus: () => ({ publish: () => { throw new Error('bus'); }, subscribe: () => () => undefined, connected: () => false }),
    });
    await expect(controller.respondToPerson({ requestId: 'r1', text: 'hello' })).resolves.toMatchObject({ text: 'echo' });
  });
});

describe('chatterNote', () => {
  it('uses the system-note marker style', () => {
    expect(chatterNote('Sage', 'Hello\nthere')).toBe('[Sage said to you, not Kevin: "Hello there"]');
  });
});

describe('extra avatars from the environment', () => {
  it('parses names and ids', () => {
    expect(parseExtraAvatarNames(' Sage, Rex ,,sage')).toEqual(['Sage', 'Rex']);
    expect(parseExtraAvatarNames(undefined)).toEqual([]);
    expect(avatarIdForName('Dr. Who?')).toBe('dr-who');
  });

  it('creates missing profiles on the active VRM with a default persona, once', () => {
    const kv = new Map<string, string>();
    const registry = new AvatarRegistry({
      store: { getValue: (k) => kv.get(k) ?? null, setValue: (k, v) => void kv.set(k, v) },
      activeVrmModelId: () => 'vrm-1',
    });
    const env = { AIEMBODIED_EXTRA_AVATARS: 'Sage,Rex' };
    const made = ensureExtraAvatars(registry, () => 'vrm-1', env);
    expect(made.map((p) => [p.id, p.name, p.vrmModelId])).toEqual([['sage', 'Sage', 'vrm-1'], ['rex', 'Rex', 'vrm-1']]);
    expect(registry.get('sage')?.prompt).toBe(defaultPersonaPrompt('Sage'));
    expect(defaultPersonaPrompt('Sage')).toContain('another AI in the room with Echo and Kevin');
    expect(registry.list().map((p) => p.id)).toEqual(['echo', 'sage', 'rex']);
    expect(ensureExtraAvatars(registry, () => 'vrm-1', env)).toEqual([]);
    expect(registry.peek().find((p) => p.id === 'sage')?.prompt).toContain('Sage');
  });
});
