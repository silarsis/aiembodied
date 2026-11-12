import { describe, expect, it, vi } from 'vitest';
import { FloorController, HEAR_CHATTER_KEY, chatterNote, converseNote, relayChatterNote, relayNote } from '../src/floor/index.js';
import type { FloorBid, IntentFunction } from '../src/floor/floor-manager.js';
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../src/local-voice/types.js';
import type { SwitchboardEventInput } from '../src/switchboard/types.js';
import { avatarIdForName } from '../src/avatars/avatar-id.js';
import { AvatarRegistry } from '../src/avatars/avatar-registry.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
  { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
  { id: 'rex', name: 'Rex', vrmModelId: 'm1' },
];

function harness(options: { replies?: Record<string, string[]>; bids?: FloorBid[]; hear?: boolean; profiles?: typeof PROFILES; intent?: IntentFunction } = {}) {
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
    intent: options.intent,
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
      text: chatterNote('Echo', 'Sage, do you agree?'),
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

  it('has no turn cap on chatter and journals no budget stop', async () => {
    const h = harness({
      replies: { echo: Array(20).fill('Sage?'), sage: Array(20).fill('Echo?') },
    });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, go' });
    for (let i = 0; i < 6; i += 1) await settle();
    // echo (Kevin) then chatter until the scripted replies run out: far more than the old four.
    expect(h.turns.length).toBeGreaterThan(30);
    expect(h.published.filter((e) => e.type === 'floor.budget')).toHaveLength(0);
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
  it('says who spoke, to whom, and asks for an answer in own words', () => {
    expect(chatterNote('Sage', 'Hello\nthere')).toBe('[Sage says to you, not Kevin: "Hello there" Answer in your own words; do not repeat what was said.]');
  });

  it('in a chat Kevin asked for, adds the conversation instruction', () => {
    expect(chatterNote('Sage', 'Hello', { talk: true })).toBe(
      '[Sage says to you, not Kevin: "Hello" You are in a conversation with Sage that Kevin asked for. Reply to Sage in your own words in one or two sentences, do not repeat what was said, and keep the conversation moving.]',
    );
  });

  it('drops action tags', () => {
    expect(chatterNote('Sage', 'Hi {move:waves}, there {go:chair}')).toBe('[Sage says to you, not Kevin: "Hi, there" Answer in your own words; do not repeat what was said.]');
  });
});

describe('avatars added through the registry', () => {
  it('makes ids from names', () => {
    expect(avatarIdForName(' Sage ')).toBe('sage');
    expect(avatarIdForName('Dr. Who?')).toBe('dr-who');
  });

  it('keeps scene order and each profile\'s body and prompt', () => {
    const kv = new Map<string, string>();
    const registry = new AvatarRegistry({
      store: { getValue: (k) => kv.get(k) ?? null, setValue: (k, v) => void kv.set(k, v) },
      activeVrmModelId: () => 'vrm-1',
    });
    registry.add({ id: 'sage', name: 'Sage', vrmModelId: 'vrm-1', prompt: 'You are Sage.' });
    registry.add({ id: 'rex', name: 'Rex', vrmModelId: 'vrm-1' });
    expect(registry.list().map((p) => [p.id, p.name, p.vrmModelId])).toEqual([['echo', 'Echo', 'vrm-1'], ['sage', 'Sage', 'vrm-1'], ['rex', 'Rex', 'vrm-1']]);
    expect(registry.get('sage')?.prompt).toBe('You are Sage.');
    expect(registry.peek().find((p) => p.id === 'sage')?.prompt).toContain('Sage');
  });
});

describe('floor with several avatars', () => {
  it('passes Kevin\'s question on: the asker is told to name the target, the target answers aloud and does not open more chatter', async () => {
    const h = harness({ replies: { sage: ['Echo, what are you up to right now?'], echo: ['Just tidying up.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: "Sage, can you ask Echo what they're doing?" });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['sage', 'echo']);
    expect(h.turns[0].request.text).toBe(`Sage, can you ask Echo what they're doing?\n\n${relayNote('Echo')}`);
    expect(h.turns[1].request).toMatchObject({
      avatarId: 'echo',
      silent: false,
      text: relayChatterNote('Sage', 'Echo, what are you up to right now?'),
    });
    expect(h.forwarded.length).toBeGreaterThan(0);
    expect(h.saved).toEqual([{ speaker: 'echo', content: 'Just tidying up.', ts: 1_000 }]);
    expect(h.published.find((e) => e.type === 'floor.decision')?.payload).toMatchObject({ relay: { from: 'sage', to: 'echo' } });
  });

  it('forgets a pending relay when Kevin speaks again', async () => {
    const h = harness({ replies: { sage: ['Echo, what are you up to?'] } });
    h.hold.add('sage');
    const first = h.controller.respondToPerson({ requestId: 'r1', text: 'Sage, ask Echo what they do' });
    await settle();
    await h.controller.respondToPerson({ requestId: 'r2', text: 'Rex, hello' });
    h.hold.delete('sage');
    h.gates.get('sage')?.();
    await first;
    await settle();
    expect(h.turns.map((t) => t.avatarId)).not.toContain('echo');
  });
});

describe('a conversation Kevin asks for', () => {
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await settle();
  };

  it('tells the starter what to do, then routes its reply to the target aloud even with Hear avatar chatter off', async () => {
    const h = harness({
      profiles: PROFILES.slice(0, 2),
      replies: { echo: ['Hello over there, how is your day going?', 'That sounds lovely.'], sage: ['Quiet, thanks. And yours?', 'Yes, it was.'] },
    });
    expect(h.controller.hearChatter()).toBe(false);
    await h.controller.respondToPerson({ requestId: 'r1', text: "I'd like you to talk to Sage." });
    await flush();
    expect(h.turns[0]).toMatchObject({ avatarId: 'echo' });
    expect(h.turns[0].request.text).toBe(`I'd like you to talk to Sage.\n\n${converseNote('Sage')}`);
    expect(converseNote('Sage')).toContain('Kevin wants you to have a conversation with Sage');
    expect(h.turns[1]).toMatchObject({ avatarId: 'sage' });
    expect(h.turns[1].request).toMatchObject({
      silent: false,
      noTools: true,
      text: chatterNote('Echo', 'Hello over there, how is your day going?', { talk: true }),
    });
    expect(h.turns.slice(0, 4).map((t) => t.avatarId)).toEqual(['echo', 'sage', 'echo', 'sage']);
    expect(h.turns[2].request.text).toBe(chatterNote('Sage', 'Quiet, thanks. And yours?', { talk: true }));
    expect(h.forwarded.some((e) => e.avatarId === 'sage')).toBe(true);
    const decisions = h.published.filter((e) => e.type === 'floor.decision');
    expect(decisions[0].payload).toMatchObject({ speakers: [{ avatarId: 'echo', reason: 'host' }] });
    expect(decisions[1].payload).toMatchObject({ channel: 'aloud', speakers: [{ avatarId: 'sage', reason: 'addressed' }] });
  });

  it('does not tell the other avatar anything extra on a plain question', async () => {
    const h = harness({ replies: { sage: ['I think so.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Sage, what do you think?' });
    expect(h.turns[0].request.text).toBe('Sage, what do you think?');
  });

  it('keeps action tags away from the other avatars: routed, overheard and journalled text is clean', async () => {
    const h = harness({
      replies: { echo: ['Hi Sage {move:waves hello}, what is up? {go:sofa}'], sage: ['{static:smile}Nothing much {pose:happy}.'] },
    });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, talk to Sage' });
    await flush();
    expect(h.turns[1].request.text).toBe(chatterNote('Echo', 'Hi Sage, what is up?', { talk: true }));
    const everything = [
      ...h.turns.slice(1).map((t) => t.request.text),
      ...h.heard.map((l) => l.text),
      ...h.published.filter((e) => e.type === 'floor.decision').map((e) => String(e.payload.text)),
    ].join('\n');
    expect(everything).not.toMatch(/[{}]/);
    expect(everything).toContain('Nothing much.');
    // The avatar's own saved line is its own words and is not rewritten here.
    expect(h.saved[0].speaker).toBe('sage');
  });

  it('a third avatar only overhears the pair', async () => {
    const h = harness({ replies: { echo: ['Rex would like this, Sage.', 'Right.'], sage: ['Rex, join us? Hm.', 'Yes.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, talk to Sage' });
    await flush();
    expect(h.turns.map((t) => t.avatarId)).not.toContain('rex');
    expect(h.heard.filter((l) => l.to === 'rex').length).toBeGreaterThan(0);
  });

  it('Kevin speaking ends the conversation: the cancelled speaker is dropped and nobody carries on', async () => {
    const h = harness({
      replies: { echo: ['Hello Sage.', 'Again.'], sage: ['Hello Echo.', 'Again.'], rex: ['Yes Kevin?'] },
    });
    h.hold.add('sage');
    const first = h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, talk to Sage' });
    await first;
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage']);
    expect(h.controller.manager.state().talking).toBe(true);
    await h.controller.respondToPerson({ requestId: 'r2', text: 'Rex, wait' });
    expect(h.cancelled).toContain('sage');
    expect(h.controller.manager.state().talking).toBe(false);
    h.gates.get('sage')?.();
    await flush();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage', 'rex']);
  });
});

describe('lines the intent model decides', () => {
  const flush = async () => {
    for (let i = 0; i < 6; i += 1) await settle();
  };

  it('tells the starter of a model-made conversation what to do, and journals who decided', async () => {
    const intent = vi.fn<IntentFunction>(async () => ({ addressed: 'echo', wants: 'converse', other: 'sage' }));
    const h = harness({
      profiles: PROFILES.slice(0, 2),
      intent,
      replies: { echo: ['Hello over there, how is your day going?'], sage: ['Quiet, thanks.'] },
    });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Hey Eko, have a word with Sage.' });
    await flush();
    expect(intent).toHaveBeenCalledOnce();
    expect(h.turns[0]).toMatchObject({ avatarId: 'echo' });
    expect(h.turns[0].request.text).toBe(`Hey Eko, have a word with Sage.\n\n${converseNote('Sage')}`);
    expect(h.turns[1]).toMatchObject({ avatarId: 'sage' });
    expect(h.turns[1].request).toMatchObject({ silent: false, text: chatterNote('Echo', 'Hello over there, how is your day going?', { talk: true }) });
    const decision = h.published.find((e) => e.type === 'floor.decision');
    expect(decision?.payload).toMatchObject({ decidedBy: 'model', speakers: [{ avatarId: 'echo', reason: 'addressed' }] });
    expect((decision?.payload.trace as string[]).join(' ')).toMatch(/intent model -> echo converse sage \(\d+ ms\)/);
  });

  it('tells the asked avatar of a model-made relay to name the target, then the target answers aloud', async () => {
    const intent = vi.fn<IntentFunction>(async () => ({ addressed: 'sage', wants: 'relay', other: 'echo' }));
    const h = harness({ intent, replies: { sage: ['Echo, what are you up to right now?'], echo: ['Just tidying up.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Not you, Echo. Sage, find out what Echo is doing.' });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['sage', 'echo']);
    expect(h.turns[0].request.text).toBe(`Not you, Echo. Sage, find out what Echo is doing.\n\n${relayNote('Echo')}`);
    expect(h.turns[1].request).toMatchObject({ avatarId: 'echo', silent: false, text: relayChatterNote('Sage', 'Echo, what are you up to right now?') });
    expect(h.published.find((e) => e.type === 'floor.decision')?.payload).toMatchObject({ decidedBy: 'model', relay: { from: 'sage', to: 'echo' } });
  });

  it('does not call the model for a clear line and journals rules', async () => {
    const intent = vi.fn<IntentFunction>(async () => ({ addressed: 'rex', wants: 'answer', other: null }));
    const h = harness({ intent, replies: { sage: ['I think so.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Sage, what do you think?' });
    expect(intent).not.toHaveBeenCalled();
    expect(h.published.find((e) => e.type === 'floor.decision')?.payload).toMatchObject({ decidedBy: 'rules' });
  });

  it('falls back to the rules and journals it when the model fails', async () => {
    const h = harness({ intent: async () => Promise.reject(new Error('down')), replies: { echo: ['Hi.'], sage: ['Hello.'] } });
    await h.controller.respondToPerson({ requestId: 'r1', text: 'Echo, what do you think of Sage?' });
    await settle();
    expect(h.turns.map((t) => t.avatarId)).toEqual(['echo', 'sage']);
    const payload = h.published.find((e) => e.type === 'floor.decision')?.payload;
    expect(payload).toMatchObject({ decidedBy: 'rules-fallback' });
    expect((payload?.trace as string[]).join(' ')).toContain('intent model failed (down) -> rules');
  });

  it('drops a pending intent call when Kevin speaks again: no turn runs for the old line, the new one is unaffected', async () => {
    let release: (value: { addressed: string; wants: 'answer' | 'converse' | 'relay'; other: string | null }) => void = () => undefined;
    let aborted = false;
    const intent = vi.fn<IntentFunction>((input, signal) => {
      if (input.text.startsWith('Tell me')) {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise((resolve) => (release = resolve));
      }
      return Promise.resolve({ addressed: 'unclear', wants: 'answer', other: null });
    });
    const h = harness({ intent, replies: { rex: ['Rex here.'], sage: ['Sage here.'] } });
    const first = h.controller.respondToPerson({ requestId: 'r1', text: 'Tell me about Sage.' });
    await settle();
    expect(intent).toHaveBeenCalledOnce();
    const second = await h.controller.respondToPerson({ requestId: 'r2', text: 'Rex, are you there?' });
    expect(aborted).toBe(true);
    release({ addressed: 'sage', wants: 'converse', other: 'echo' });
    expect(await first).toEqual({ requestId: 'r1', text: '', cancelled: true });
    await flush();
    expect(second.text).toBe('Rex here.');
    expect(h.turns.map((t) => [t.avatarId, t.request.requestId])).toEqual([['rex', 'r2']]);
    // The late answer did not start a conversation or change who Kevin last talked with.
    expect(h.controller.manager.state()).toMatchObject({ talking: false, partner: 'rex' });
    expect(h.published.filter((e) => e.type === 'floor.decision' && e.payload.from === 'person:kevin').map((e) => e.payload.text)).toEqual(['Rex, are you there?']);
  });
});
