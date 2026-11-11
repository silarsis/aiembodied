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
  const heard: Array<{ to: string; from: string; text: string }> = [];
  const bidCalls = vi.fn();
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
    voice: (avatarId) => ({
      respond: respond(avatarId),
      cancel: () => void cancelled.push(avatarId),
      overhear: (line) => void heard.push({ to: avatarId, ...line }),
    }),
    runPersonTurn: (avatarId, request) => respond(avatarId)(request, () => undefined),
    emitChatter: (_id, event) => void forwarded.push(event),
    saveLine: (line) => void saved.push(line),
    instructionsFor: (avatarId) => `You are ${avatarId}.`,
    bus: () => ({ publish: (event) => (published.push(event), null), subscribe: () => () => undefined, connected: () => false }),
    bid: async () => (bidCalls(), options.bids ?? []),
    now: () => 1_000,
  });
  return { controller, kv, published, turns, saved, forwarded, cancelled, hold, gates, heard, bidCalls };
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

  it('uses a bid for chatter when nobody is named, and says nothing when no bid wins', async () => {
    const won = harness({ replies: { echo: ['Sage, what is time?'], sage: ['Interesting question.'], rex: ['Hm.'] }, bids: [{ avatarId: 'rex', want: 0.9, reason: 'curious' }] });
    await won.controller.respondToPerson({ requestId: 'r1', text: 'Echo, what is time?' });
    await settle();
    expect(won.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage', 'rex']);
    const quiet = harness({ replies: { echo: ['Sage, what is time?'], sage: ['Interesting question.'] }, bids: [{ avatarId: 'rex', want: 0.1, reason: '' }] });
    await quiet.controller.respondToPerson({ requestId: 'r1', text: 'Echo, what is time?' });
    await settle();
    expect(quiet.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage']);
  });

  it('does not open chatter or ask for bids after an answer to Kevin that names nobody', async () => {
    const h = harness({ replies: { echo: ['Interesting question.'] }, bids: [{ avatarId: 'rex', want: 0.9, reason: '' }] });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'what is time?' });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo']);
    expect(h.bidCalls).not.toHaveBeenCalled();
    const decisions = h.published.filter((e) => e.type === 'floor.decision');
    expect(decisions[1].payload.trace).toContain('avatar: answer to Kevin; others only overhear');
  });

  it('still lets an answer to Kevin that names another avatar reach that avatar', async () => {
    const h = harness({ replies: { echo: ['Rex, what do you think?'], rex: ['Fine.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'what is time?' });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'rex']);
  });

  it('gives chatter turns no tools', async () => {
    const h = harness({ replies: { echo: ['Sage, do you agree?'], sage: ['Yes.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, any thoughts?' });
    await settle();
    expect(h.turns.find((t) => t.avatarId === 'sage')?.request.noTools).toBe(true);
    expect(h.turns.find((t) => t.avatarId === 'echo')?.request.noTools).toBeUndefined();
  });

  it('lets the other avatars overhear Kevin and the answer, but not the addressee twice', async () => {
    const h = harness({ replies: { sage: ['I think so.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Sage, what do you think?' });
    await settle();
    expect(h.heard).toEqual([
      { to: 'echo', from: 'Kevin (to Sage)', text: 'Sage, what do you think?' },
      { to: 'rex', from: 'Kevin (to Sage)', text: 'Sage, what do you think?' },
      { to: 'echo', from: 'Sage', text: 'I think so.' },
      { to: 'rex', from: 'Sage', text: 'I think so.' },
    ]);
  });

  it('does not overhear cancelled or empty replies', async () => {
    const h = harness({ replies: { sage: [''] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Sage, hello' });
    await settle();
    expect(h.heard).toEqual([]);
  });

  it('chatter: bystanders hear both lines; the sender hears the reply unless it gets it as input', async () => {
    const h = harness({ replies: { echo: ['Sage, do you agree?'], sage: ['Yes, I do.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, any thoughts?' });
    await settle();
    const toRex = h.heard.filter((l) => l.to === 'rex').map((l) => `${l.from}: ${l.text}`);
    expect(toRex).toEqual([
      'Kevin (to Echo): Echo, any thoughts?',
      'Echo: Sage, do you agree?',
      'Echo (to Sage): Sage, do you agree?',
      'Sage: Yes, I do.',
    ]);
    // Echo gets Sage's reply only as overheard text (nobody is named in it, so no chatter input).
    expect(h.heard.filter((l) => l.to === 'echo').map((l) => l.from)).toEqual(['Sage']);
    expect(h.heard.some((l) => l.to === 'sage' && l.from.startsWith('Echo'))).toBe(false);
  });

  it('chatter: the sender does not overhear a reply that comes back to it as its own input', async () => {
    const h = harness({ replies: { echo: ['Sage, agree?', 'Fine.'], sage: ['Echo, yes.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, any thoughts?' });
    await settle();
    expect(h.heard.some((l) => l.to === 'echo' && l.from === 'Sage')).toBe(false);
  });

  it('heard() skips the speaker and the addressee and ignores empty text', () => {
    const h = harness();
    h.controller.heard('echo', '  ', 'sage');
    h.controller.heard('echo', 'a  b', 'sage');
    expect(h.heard).toEqual([{ to: 'rex', from: 'Echo (to Sage)', text: 'a b' }]);
  });

  it('interrupt() during a person turn leaves that turn\'s own result intact', async () => {
    const h = harness({ replies: { echo: ['Done.'] } });
    h.hold.add('echo');
    const pending = h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, hi' });
    await settle();
    h.controller.interrupt();
    h.gates.get('echo')?.();
    await expect(pending).resolves.toMatchObject({ text: 'Done.' });
    await settle();
    expect(h.controller.manager.state().speaking).toBeNull();
    expect(h.heard).toEqual([]);
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
