import { describe, expect, it, vi } from 'vitest';
import type { SystemOneClient } from '../src/decide/system-one.js';
import { buildFloorQuestions, buildFloorState, createSystemOneAddressee, createSystemOneBid, createSystemOneIntent } from '../src/floor/system-one-floor.js';

const NAMES: Record<string, string> = { echo: 'Echo', lenha: 'Lenha', sage: 'Sage', rex: 'Rex' };
const fake = (reply: unknown | Error) => {
  const ask = vi.fn(async (_state: unknown, _questions: unknown, _options?: unknown) => {
    if (reply instanceof Error) throw reply;
    return reply;
  });
  return { client: { ask } as unknown as SystemOneClient, ask };
};
const signal = new AbortController().signal;

describe('createSystemOneAddressee', () => {
  it('asks one choice question and maps the best option back to an avatar id', async () => {
    const { client, ask } = fake({ who: { lenha: 0.8, echo: 0.05, kevin: 0.1, everyone: 0.05 } });
    const result = await createSystemOneAddressee(client, (id) => NAMES[id] ?? id)(
      {
        speaker: 'avatar:echo',
        text: 'lenha, what are you up to?',
        recent: Array.from({ length: 6 }, (_, i) => ({ from: 'person:kevin' as const, text: `line ${i} ${'x'.repeat(400)}` })),
        candidates: [{ avatarId: 'lenha', name: 'Lenha' }],
        includePerson: true,
      },
      signal,
    );
    expect(result).toEqual({ avatarId: 'lenha', confidence: 0.8 });
    const [state, questions] = ask.mock.calls[0] as unknown as [{ recent: Array<{ text: string }>; line: { speaker: string } }, Record<string, { criteria: Record<string, string>; instructions: string }>];
    expect(state.recent).toHaveLength(4);
    expect(state.recent[0].text.length).toBeLessThanOrEqual(201);
    expect(state.line.speaker).toBe('Echo');
    expect(questions.who.instructions).toBe('Who is Echo speaking to in their last line?');
    expect(Object.keys(questions.who.criteria)).toEqual(['lenha', 'kevin', 'everyone']);
  });

  it('maps kevin and everyone, leaves Kevin out when he is not a candidate, and passes errors on', async () => {
    const person = fake({ who: { lenha: 0.1, kevin: 0.7, everyone: 0.2 } });
    expect(await createSystemOneAddressee(person.client, (id) => id)({ speaker: 'avatar:echo', text: 'hi', recent: [], candidates: [{ avatarId: 'lenha', name: 'Lenha' }], includePerson: true }, signal)).toEqual({ avatarId: 'person', confidence: 0.7 });
    const all = fake({ who: { echo: 0.2, lenha: 0.2, everyone: 0.6 } });
    const askedAll = await createSystemOneAddressee(all.client, (id) => id)({ speaker: 'person:kevin', text: 'hi', recent: [], candidates: [{ avatarId: 'echo', name: 'Echo' }, { avatarId: 'lenha', name: 'Lenha' }], includePerson: false }, signal);
    expect(askedAll).toEqual({ avatarId: 'all', confidence: 0.6 });
    const criteria = (all.ask.mock.calls[0] as unknown as [unknown, { who: { criteria: object } }])[1].who.criteria;
    expect(Object.keys(criteria)).toEqual(['echo', 'lenha', 'everyone']);
    await expect(createSystemOneAddressee(fake(new Error('down')).client, (id) => id)({ speaker: 'person:kevin', text: 'x', recent: [], candidates: [], includePerson: false }, signal)).rejects.toThrow('down');
  });
});

describe('createSystemOneBid', () => {
  it('asks one score question per candidate in a single call', async () => {
    const { client, ask } = fake({ bid0: 0.9, bid1: 0.1 });
    const bids = await createSystemOneBid(client, (from) => from.replace('avatar:', ''))(
      [{ avatarId: 'echo', name: 'Echo' }, { avatarId: 'lenha', name: 'Lenha' }],
      [{ from: 'avatar:echo', text: 'Anyone fancy a walk?' }],
      signal,
    );
    expect(bids).toEqual([
      { avatarId: 'echo', want: 0.9, reason: 'quick decision' },
      { avatarId: 'lenha', want: 0.1, reason: 'quick decision' },
    ]);
    expect(ask).toHaveBeenCalledOnce();
    const questions = (ask.mock.calls[0] as unknown as [unknown, Record<string, { type: string; instructions: string }>])[1];
    expect(questions.bid1.type).toBe('score');
    expect(questions.bid1.instructions).toContain('Lenha want to reply');
  });

  it('rejects on failure so the caller can fall back', async () => {
    await expect(createSystemOneBid(fake(new Error('down')).client)([{ avatarId: 'echo', name: 'Echo' }], [], signal)).rejects.toThrow('down');
  });
});

describe('the trained floor prompt', () => {
  // The literals below are the output of services/laya/training/floor_prompt.py (build_state, build_questions) for this scene.
  const candidates = [
    { avatarId: 'echo', name: 'Echo' },
    { avatarId: 'sage', name: 'Sage' },
    { avatarId: 'rex', name: 'Rex' },
  ];
  const input = {
    text: 'Not you, Echo. Sage, what do you think?',
    recent: [
      { from: 'person:kevin' as const, text: 'Hello there' },
      { from: 'avatar:echo' as const, text: 'Hi Kevin.' },
      { from: 'person:kevin' as const, text: 'Sage, how are you?' },
      { from: 'avatar:sage' as const, text: 'Fine thanks.' },
      { from: 'person:kevin' as const, text: 'Echo, tell me\n a joke' },
      { from: 'avatar:echo' as const, text: 'x'.repeat(210) },
    ],
    candidates,
    hostId: 'echo',
    partnerId: 'sage',
  };
  const speakerName = (from: string) => (from.startsWith('avatar:') ? (NAMES[from.slice(7)] ?? from.slice(7)) : 'Kevin');

  it('builds the state string exactly as floor_prompt.build_state does', () => {
    expect(buildFloorState(input, (from) => (from === 'avatar:sage' ? 'Sage' : speakerName(from)))).toBe(
      `Avatars in the room: Echo (host), Sage, Rex.\nKevin last spoke with: Sage.\nKevin: Sage, how are you?\nSage: Fine thanks.\nKevin: Echo, tell me a joke\nEcho: ${'x'.repeat(200)}\nKevin: Not you, Echo. Sage, what do you think?`,
    );
    expect(buildFloorState({ ...input, recent: [], partnerId: null, text: 'hi', candidates: candidates.slice(0, 2) }, speakerName)).toBe(
      'Avatars in the room: Echo (host), Sage.\nKevin last spoke with: nobody.\nKevin: hi',
    );
  });

  it('builds the questions exactly as floor_prompt.build_questions does', () => {
    expect(JSON.stringify(buildFloorQuestions(candidates).questions)).toBe(
      '{"addressed":{"type":"choice","instructions":"Which avatar is Kevin speaking to in his last line, the one who should act on it?","criteria":{"echo":"Kevin is speaking to Echo","sage":"Kevin is speaking to Sage","rex":"Kevin is speaking to Rex","everyone":"Kevin is speaking to all the avatars","unclear":"The line does not say which avatar he is speaking to"}},' +
        '"wants":{"type":"choice","instructions":"What does Kevin want that avatar to do?","criteria":{"answer":"reply to Kevin or do what he asks","converse":"go and have a conversation with another avatar","relay":"ask or tell another avatar something for Kevin"}},' +
        '"other":{"type":"choice","instructions":"Which other avatar should they talk to or pass the message to?","criteria":{"echo":"Echo","sage":"Sage","rex":"Rex","none":"no other avatar is involved"}}}',
    );
  });

  it('picks the top option of each question, maps keys to avatars and takes the lowest relevant probability as confidence', async () => {
    const { client, ask } = fake({
      addressed: { echo: 0.02, sage: 0.93, rex: 0.01, everyone: 0.02, unclear: 0.02 },
      wants: { answer: 0.05, converse: 0.9, relay: 0.05 },
      other: { echo: 0.85, sage: 0.05, rex: 0.05, none: 0.05 },
    });
    const result = await createSystemOneIntent(client, (id) => NAMES[id] ?? id)(input, signal);
    expect(result).toEqual({ addressed: 'sage', wants: 'converse', other: 'echo', confidence: 0.85 });
    expect(typeof ask.mock.calls[0][0]).toBe('string');
    expect(ask.mock.calls[0][2]).toEqual({ signal });
    // For a plain answer the "other" question does not count.
    const plain = fake({
      addressed: { echo: 0.1, sage: 0.1, rex: 0.1, everyone: 0.6, unclear: 0.1 },
      wants: { answer: 0.9, converse: 0.05, relay: 0.05 },
      other: { echo: 0.3, sage: 0.3, rex: 0.2, none: 0.2 },
    });
    expect(await createSystemOneIntent(plain.client, (id) => NAMES[id] ?? id)(input, signal)).toEqual({ addressed: 'everyone', wants: 'answer', other: 'echo', confidence: 0.6 });
  });

  it('rejects when the server fails', async () => {
    await expect(createSystemOneIntent(fake(new Error('down')).client, (id) => id)(input, signal)).rejects.toThrow('down');
  });
});
