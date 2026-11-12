import { describe, expect, it, vi } from 'vitest';
import {
  BID_THRESHOLD,
  CHATTER_MAX_MS,
  FloorManager,
  PARTNER_WINDOW_MS,
  converseTarget,
  findName,
  relayTargets,
  type AddresseeFunction,
  type AddresseeResult,
  type BidFunction,
  type FloorBid,
  type Scene,
} from '../src/floor/floor-manager.js';
import { parseBids } from '../src/floor/bid.js';

const NAMES: Record<string, string> = { echo: 'Echo', sage: 'Sage', rex: 'Rex' };

function make(options: { ids?: string[]; bids?: FloorBid[] | Error; hear?: boolean; scene?: Scene; addressee?: AddresseeResult | Error | 'hang' } = {}) {
  const ids = options.ids ?? ['echo', 'sage', 'rex'];
  const bid = vi.fn<BidFunction>(async () => {
    if (options.bids instanceof Error) throw options.bids;
    return options.bids ?? [];
  });
  const addressee = vi.fn<AddresseeFunction>(async () => {
    if (options.addressee instanceof Error) throw options.addressee;
    if (options.addressee === 'hang') return new Promise<AddresseeResult>(() => undefined);
    return options.addressee ?? { avatarId: null, confidence: 0 };
  });
  const manager = new FloorManager({
    avatarIds: () => ids,
    nameOf: (id) => NAMES[id] ?? id,
    bid,
    addressee: options.addressee === undefined ? undefined : addressee,
    addresseeTimeoutMs: 50,
    hearChatter: () => options.hear === true,
    scene: options.scene ? () => options.scene as Scene : undefined,
  });
  return { manager, bid, addressee };
}
const kevin = (text: string, at = 1_000) => ({ from: 'person:kevin' as const, text, at });
const avatar = (id: string, text: string, at = 1_000) => ({ from: `avatar:${id}` as const, text, at });
const ids = (decision: { speakers: Array<{ avatarId: string }> }) => decision.speakers.map((s) => s.avatarId);

describe('findName', () => {
  it('matches whole words in any case', () => {
    expect(findName('hey sage, what now', 'Sage')).toBe(4);
    expect(findName('sagely advice', 'Sage')).toBe(-1);
    expect(findName('the sage-like', 'Sage')).toBeGreaterThanOrEqual(0);
    expect(findName('Zoë, hi', 'Zoë')).toBe(0);
    expect(findName('anything', '')).toBe(-1);
  });
});

describe('FloorManager: Kevin speaks', () => {
  it('sends a named avatar the turn, with or without hey / ok', async () => {
    const { manager } = make();
    for (const text of ['Sage, what do you think?', 'hey Sage what do you think', 'OK sage?', 'what do you think, SAGE']) {
      const decision = await manager.route(kevin(text));
      expect(decision.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
      expect(decision.channel).toBe('aloud');
      expect(decision.trace.join(' ')).toContain('addressed by name');
    }
  });

  it('queues every named avatar in the order named', async () => {
    const { manager } = make();
    expect(ids(await manager.route(kevin('Rex and Echo, settle this')))).toEqual(['rex', 'echo']);
    expect(ids(await manager.route(kevin('Echo, then Sage')))).toEqual(['echo', 'sage']);
  });

  it('lets "you two", "both", "everyone" and "all of you" call every avatar in scene order', async () => {
    const { manager } = make();
    for (const text of ['you two, be nice', 'Both of you', 'everyone listen', 'all of you', 'Everybody up']) {
      const decision = await manager.route(kevin(text));
      expect(ids(decision)).toEqual(['echo', 'sage', 'rex']);
      expect(decision.speakers.every((s) => s.reason === 'all')).toBe(true);
    }
  });

  it('prefers the last partner within the window, then falls back to the host', async () => {
    const { manager } = make();
    await manager.route(kevin('Sage, hello', 0));
    const soon = await manager.route(kevin('and what about lunch?', 60_000));
    expect(soon.speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
    // The exchange just now counts from the latest turn with Sage.
    const later = await manager.route(kevin('hmm', 60_000 + PARTNER_WINDOW_MS));
    expect(later.speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
    const stale = await manager.route(kevin('anyone?', 60_000 + PARTNER_WINDOW_MS * 2 + 1));
    expect(stale.speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
    expect(stale.trace.join(' ')).toContain('too long ago');
  });

  it('uses the host when nobody has talked yet, and the scene host when given', async () => {
    expect((await make().manager.route(kevin('hello'))).speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
    const scene: Scene = { id: 's', avatarIds: ['sage', 'rex'], hostId: 'rex' };
    expect((await make({ scene }).manager.route(kevin('hello'))).speakers).toEqual([{ avatarId: 'rex', reason: 'host' }]);
  });

  it('with one avatar always returns it, even when another name is spoken', async () => {
    const { manager } = make({ ids: ['echo'] });
    expect(manager.isMulti()).toBe(false);
    for (const text of ['hello', 'Sage?', 'everyone']) {
      expect(ids(await manager.route(kevin(text)))).toEqual(['echo']);
    }
  });
});

describe('relayTargets', () => {
  const at = (text: string) => relayTargets(text, ['echo', 'sage', 'rex'], (id) => NAMES[id]);
  it('finds names right after a relay phrase, in order', () => {
    expect(at('Can you ask Echo what they are doing?')).toEqual(['echo']);
    expect(at('tell rex and then check with Sage')).toEqual(['rex', 'sage']);
    expect(at('please pass it on to Echo')).toEqual(['echo']);
    expect(at('tell me, Echo')).toEqual([]);
    expect(at('Echo, ask Sagely things')).toEqual([]);
  });
});

describe('FloorManager: relay', () => {
  it('has the asked avatar answer Kevin and pass the question on, then routes its line to the target aloud', async () => {
    const { manager } = make({ ids: ['echo', 'sage'] });
    const decision = await manager.route(kevin("Sage, can you ask Echo what they're doing?"));
    expect(ids(decision)).toEqual(['sage']);
    expect(decision.relay).toEqual({ from: 'sage', to: 'echo' });
    const passed = await manager.route({ ...avatar('sage', 'lenha, what are you up to right now?'), toPerson: true });
    expect(ids(passed)).toEqual(['echo']);
    expect(passed.speakers[0].reason).toBe('addressed');
    expect(passed.channel).toBe('aloud');
    expect(passed.relay).toEqual({ from: 'sage', to: 'echo' });
    const again = await manager.route({ ...avatar('sage', 'lenha, what are you up to right now?'), toPerson: true });
    expect(ids(again)).toEqual([]);
  });

  it('uses the last partner, or the host, when Kevin does not call the asker by name', async () => {
    const a = make({ ids: ['echo', 'sage'] });
    await a.manager.route(kevin('Sage, hello', 1_000));
    const viaPartner = await a.manager.route(kevin("Ask Echo what she's doing", 2_000));
    expect(ids(viaPartner)).toEqual(['sage']);
    expect(viaPartner.relay).toEqual({ from: 'sage', to: 'echo' });
    const b = make({ ids: ['echo', 'sage'] });
    const viaHost = await b.manager.route(kevin("Ask Echo what she's doing"));
    expect(ids(viaHost)).toEqual(['sage']);
    expect(viaHost.relay).toEqual({ from: 'sage', to: 'echo' });
  });

  it('does not relay when everyone is addressed or no relay phrase is used, and a new Kevin turn clears it', async () => {
    const { manager } = make({ ids: ['echo', 'sage'] });
    const both = await manager.route(kevin('Sage and Echo, what do you think?'));
    expect(ids(both)).toEqual(['sage', 'echo']);
    expect(both.relay).toBeUndefined();
    expect((await manager.route(kevin('tell me, Echo'))).relay).toBeUndefined();
    await manager.route(kevin('Sage, ask Echo something'));
    await manager.route(kevin('Rex who?'));
    const late = await manager.route({ ...avatar('sage', 'Echo, hi'), toPerson: true });
    expect(late.relay).toBeUndefined();
    await manager.route(kevin('Sage, ask Echo something'));
    manager.bargeIn();
    expect((await manager.route({ ...avatar('sage', 'Echo, hi'), toPerson: true })).relay).toBeUndefined();
  });
});

describe('FloorManager: avatar chatter', () => {
  it('lets only another avatar of the scene reply, to the one addressed by name', async () => {
    const { manager, bid } = make();
    const decision = await manager.route(avatar('echo', 'Rex, you were right about that.'));
    expect(decision.speakers).toEqual([{ avatarId: 'rex', reason: 'addressed' }]);
    expect(decision.channel).toBe('back');
    expect(bid).not.toHaveBeenCalled();
    // Her own name does not count.
    const self = await make({ bids: [] }).manager.route(avatar('echo', 'Echo is thinking out loud'));
    expect(self.speakers).toEqual([]);
  });

  it('keeps an answer to Kevin to itself unless it names an avatar or Kevin asked them to talk', async () => {
    const { manager, bid } = make({ bids: [{ avatarId: 'rex', want: 0.9, reason: '' }] });
    const quiet = await manager.route({ ...avatar('echo', 'Interesting question.'), toPerson: true });
    expect(quiet.speakers).toEqual([]);
    expect(quiet.trace).toEqual(['avatar: answer to Kevin; others only overhear']);
    expect(bid).not.toHaveBeenCalled();
    const named = await manager.route({ ...avatar('echo', 'Rex, you decide.'), toPerson: true });
    expect(named.speakers).toEqual([{ avatarId: 'rex', reason: 'addressed' }]);
    const other = await manager.route(avatar('echo', 'Interesting question.'));
    expect(other.speakers).toEqual([{ avatarId: 'rex', reason: 'bid' }]);
  });

  it('reports the channel from the Hear avatar chatter setting', async () => {
    expect((await make({ hear: true }).manager.route(avatar('echo', 'Sage?'))).channel).toBe('aloud');
  });

  it('asks for bids from the others only, with the recent lines, and picks the highest above the threshold', async () => {
    const { manager, bid } = make({
      bids: [
        { avatarId: 'sage', want: 0.6, reason: 'has a view' },
        { avatarId: 'rex', want: 0.9, reason: 'strongly disagrees' },
      ],
    });
    await manager.route(kevin('Echo, tell a story', 0));
    const decision = await manager.route(avatar('echo', 'Once upon a time there was a robot.', 10));
    expect(decision.speakers).toEqual([{ avatarId: 'rex', reason: 'bid' }]);
    const [candidates, lines] = bid.mock.calls[0];
    expect(candidates).toEqual([
      { avatarId: 'sage', name: 'Sage' },
      { avatarId: 'rex', name: 'Rex' },
    ]);
    expect(lines).toEqual([
      { from: 'person:kevin', text: 'Echo, tell a story' },
      { from: 'avatar:echo', text: 'Once upon a time there was a robot.' },
    ]);
  });

  it('breaks ties by scene order and accepts a bid exactly at the threshold', async () => {
    const tie = make({ bids: [{ avatarId: 'rex', want: 0.7, reason: '' }, { avatarId: 'sage', want: 0.7, reason: '' }] });
    expect(ids(await tie.manager.route(avatar('echo', 'hmm')))).toEqual(['sage']);
    const edge = make({ bids: [{ avatarId: 'rex', want: BID_THRESHOLD, reason: '' }] });
    expect(ids(await edge.manager.route(avatar('echo', 'hmm')))).toEqual(['rex']);
  });

  it('stays silent when every bid is below the threshold, there are none, or bidding fails', async () => {
    expect((await make({ bids: [{ avatarId: 'sage', want: 0.49, reason: '' }] }).manager.route(avatar('echo', 'hmm'))).speakers).toEqual([]);
    expect((await make({ bids: [] }).manager.route(avatar('echo', 'hmm'))).speakers).toEqual([]);
    const failed = await make({ bids: new Error('model down') }).manager.route(avatar('echo', 'hmm'));
    expect(failed.speakers).toEqual([]);
    expect(failed.trace.join(' ')).toContain('bidding failed');
  });

  it('ignores bids for avatars outside the scene or from the speaker, and clamps wants', async () => {
    const { manager } = make({ bids: [{ avatarId: 'ghost', want: 1, reason: '' }, { avatarId: 'echo', want: 1, reason: '' }, { avatarId: 'sage', want: 7, reason: '' }] });
    expect(ids(await manager.route(avatar('echo', 'hmm')))).toEqual(['sage']);
  });

  it('gives up on a bid that never answers', async () => {
    const hang: BidFunction = () => new Promise(() => undefined);
    const manager = new FloorManager({ avatarIds: () => ['echo', 'sage'], nameOf: (id) => NAMES[id] ?? id, bid: hang, bidTimeoutMs: 20 });
    const decision = await manager.route(avatar('echo', 'hmm'));
    expect(decision.speakers).toEqual([]);
    expect(decision.trace.join(' ')).toContain('timed out');
  });

  it('does nothing from a lone avatar or one outside the scene', async () => {
    expect((await make({ ids: ['echo'] }).manager.route(avatar('echo', 'Sage?'))).speakers).toEqual([]);
    expect((await make().manager.route(avatar('ghost', 'Sage?'))).speakers).toEqual([]);
  });

  it('has no turn cap on spontaneous chatter', async () => {
    const { manager } = make();
    for (let turn = 0; turn < 40; turn += 1) {
      const decision = await manager.route(avatar(turn % 2 ? 'sage' : 'echo', turn % 2 ? 'Echo, your move' : 'Sage, your move', 100 + turn));
      expect(ids(decision)).toEqual([turn % 2 ? 'echo' : 'sage']);
      expect(decision.budget).toBeUndefined();
    }
  });

  it('caps spontaneous chatter by time since it started (5 minutes by default)', async () => {
    expect(CHATTER_MAX_MS).toBe(5 * 60_000);
    const custom = new FloorManager({ avatarIds: () => ['echo', 'sage'], nameOf: (id) => NAMES[id] ?? id, chatterMaxMs: 1_000 });
    await custom.route(avatar('echo', 'Sage?', 0));
    expect((await custom.route(avatar('sage', 'Echo?', 1_000))).budget).toEqual({ kind: 'time', ms: 1_000 });
  });

  it('caps chatter by time since it started', async () => {
    const { manager } = make();
    expect(ids(await manager.route(avatar('echo', 'Sage?', 1_000)))).toEqual(['sage']);
    expect(ids(await manager.route(avatar('sage', 'Echo?', 1_000 + CHATTER_MAX_MS - 1)))).toEqual(['echo']);
    const cut = await manager.route(avatar('echo', 'Sage?', 1_000 + CHATTER_MAX_MS));
    expect(cut.speakers).toEqual([]);
    expect(cut.budget).toEqual({ kind: 'time', ms: CHATTER_MAX_MS });
  });
});

describe('FloorManager: speaking slot', () => {
  it('grants one speaker at a time, queues the rest first in first out, and hands on at release', () => {
    const { manager } = make();
    expect(manager.request('echo')).toBe('granted');
    expect(manager.request('sage')).toBe('queued');
    expect(manager.request('rex')).toBe('queued');
    expect(manager.request('sage')).toBe('duplicate');
    expect(manager.request('echo')).toBe('duplicate');
    expect(manager.state()).toMatchObject({ speaking: 'echo', queue: ['sage', 'rex'] });
    expect(manager.release('echo')).toBe('sage');
    expect(manager.release('sage')).toBe('rex');
    expect(manager.release('rex')).toBeNull();
    expect(manager.state()).toMatchObject({ speaking: null, queue: [] });
  });

  it('ignores a release from an avatar that does not hold the slot, and drops it from the queue', () => {
    const { manager } = make();
    manager.request('echo');
    manager.request('sage');
    expect(manager.release('rex')).toBeNull();
    expect(manager.release('sage')).toBeNull();
    expect(manager.state()).toMatchObject({ speaking: 'echo', queue: [] });
  });

  it('barge-in clears the queue and the budget, and names who to cancel', async () => {
    const { manager } = make();
    manager.request('echo');
    manager.request('sage');
    await manager.route(kevin('you two have a chat'));
    expect(manager.state().talking).toBe(true);
    expect(manager.bargeIn()).toEqual(['echo']);
    expect(manager.state()).toMatchObject({ speaking: null, queue: [], talking: false });
    expect(manager.bargeIn()).toEqual([]);
    expect(manager.request('rex')).toBe('granted');
  });
});

describe('parseBids', () => {
  const candidates = [{ avatarId: 'sage', name: 'Sage' }, { avatarId: 'rex', name: 'Rex' }];
  it('reads bids by id or name, clamps wants, and tolerates fences and think blocks', () => {
    expect(
      parseBids('<think>hm</think>```json\n{"bids":[{"avatar":"sage","want":0.8,"reason":"q"},{"avatar":"REX","want":"2"},{"avatar":"who","want":1}]}\n```', candidates),
    ).toEqual([
      { avatarId: 'sage', want: 0.8, reason: 'q' },
      { avatarId: 'rex', want: 1, reason: '' },
    ]);
  });
  it('gives null for answers without bids', () => {
    expect(parseBids('no idea', candidates)).toBeNull();
    expect(parseBids('{"answer": 1}', candidates)).toBeNull();
  });
});

describe('FloorManager: wake word and talking to each other', () => {
  it('"hey echo" makes the host the listener again, even right after talking with Sage', async () => {
    const { manager } = make({ ids: ['echo', 'sage'] });
    await manager.route(kevin('Sage, what do you think?', 1_000));
    manager.listenTo('echo', 2_000);
    expect(ids(await manager.route(kevin('what is the weather', 3_000)))).toEqual(['echo']);
  });

  it('"talk to each other" starts out loud, passes the turn on without bids, and ends when Kevin speaks', async () => {
    const { manager, bid } = make({ ids: ['echo', 'sage'] });
    const start = await manager.route(kevin('Echo and Sage, talk to each other about dinner', 1_000));
    expect(ids(start)).toEqual(['echo']);
    const reply = await manager.route(avatar('echo', 'What do you fancy for dinner?', 2_000));
    expect(ids(reply)).toEqual(['sage']);
    expect(reply.channel).toBe('aloud');
    expect(bid).not.toHaveBeenCalled();
    expect(ids(await manager.route(avatar('sage', 'Pasta, maybe.', 3_000)))).toEqual(['echo']);
    await manager.route(kevin('thanks', 4_000));
    expect((await manager.route(avatar('echo', 'Anyone?', 5_000))).channel).toBe('back');
  });

  it('a chat Kevin asked for has no turn or time limit and runs until he speaks', async () => {
    const { manager } = make({ ids: ['echo', 'sage'] });
    await manager.route(kevin('have a chat', 1_000));
    for (let i = 0; i < 30; i += 1) {
      const decision = await manager.route(avatar(i % 2 ? 'sage' : 'echo', 'more', 2_000 + i * 600_000));
      expect(ids(decision)).toEqual([i % 2 ? 'echo' : 'sage']);
      expect(decision.channel).toBe('aloud');
      expect(decision.budget).toBeUndefined();
    }
  });

  it('with more than two avatars, "talk to each other" goes round in scene order', async () => {
    const { manager } = make();
    await manager.route(kevin('you three, talk to each other'));
    expect(ids(await manager.route(avatar('echo', 'hi', 2_000)))).toEqual(['sage']);
    expect(ids(await manager.route(avatar('sage', 'hi', 3_000)))).toEqual(['rex']);
    expect(ids(await manager.route(avatar('rex', 'hi', 4_000)))).toEqual(['echo']);
  });
});

describe('FloorManager: addressee check', () => {
  it('is not used for Kevin: two names with no intent model keep both answering', async () => {
    for (const addressee of [{ avatarId: 'sage', confidence: 0.99 }, { avatarId: 'all', confidence: 0.95 }, new Error('down'), 'hang' as const, undefined]) {
      const { manager, addressee: check } = make({ addressee });
      const decision = await manager.route(kevin('Echo and Sage, Sage knows about plants, right?'));
      expect(ids(decision)).toEqual(['echo', 'sage']);
      expect(decision.decidedBy).toBe('rules');
      expect(check).not.toHaveBeenCalled();
    }
  });

  it('is not asked when a rule already decides (one name, relay, group, talk)', async () => {
    const { manager, addressee } = make({ addressee: { avatarId: 'rex', confidence: 0.99 } });
    await manager.route(kevin('Sage, hello'));
    await manager.route(kevin('Sage, ask Echo what he thinks'));
    await manager.route(kevin('Echo and Sage, everyone listen'));
    await manager.route(kevin('Echo and Sage, talk to each other'));
    expect(addressee).not.toHaveBeenCalled();
  });

  it('makes an avatar line without a name go to the avatar it is aimed at', async () => {
    const { manager, addressee, bid } = make({ addressee: { avatarId: 'rex', confidence: 0.8 } });
    const decision = await manager.route(avatar('echo', 'what are you up to?'));
    expect(decision.speakers).toEqual([{ avatarId: 'rex', reason: 'addressed' }]);
    expect(decision.trace.join(' ')).toContain('addressee check -> rex');
    expect(addressee.mock.calls[0][0]).toMatchObject({ speaker: 'avatar:echo', includePerson: true });
    expect(addressee.mock.calls[0][0].candidates.map((c) => c.avatarId)).toEqual(['sage', 'rex']);
    expect(bid).not.toHaveBeenCalled();
  });

  it('ends an avatar line aimed at Kevin when it was an answer to him, else goes on to bids', async () => {
    const toKevin = make({ addressee: { avatarId: 'person', confidence: 0.9 } });
    expect((await toKevin.manager.route({ ...avatar('echo', 'Here you go.'), toPerson: true })).speakers).toEqual([]);
    expect(toKevin.bid).not.toHaveBeenCalled();
    const chatter = make({ addressee: { avatarId: 'person', confidence: 0.9 }, bids: [{ avatarId: 'sage', want: 0.8, reason: 'x' }] });
    expect(ids(await chatter.manager.route(avatar('echo', 'Kevin, what do you think?')))).toEqual(['sage']);
    expect(chatter.bid).toHaveBeenCalled();
  });

  it('falls back to bids when unsure, failing, or when it names an avatar not in the scene', async () => {
    for (const addressee of [{ avatarId: 'rex', confidence: 0.2 }, { avatarId: 'all', confidence: 0.9 }, { avatarId: 'ghost', confidence: 0.9 }, new Error('down'), 'hang' as const]) {
      const { manager, bid } = make({ addressee, bids: [{ avatarId: 'sage', want: 0.8, reason: 'x' }] });
      const decision = await manager.route(avatar('echo', 'what are you up to?'));
      expect(ids(decision)).toEqual(['sage']);
      expect(decision.speakers[0].reason).toBe('bid');
      expect(bid).toHaveBeenCalledOnce();
    }
  });

  it('is skipped for a named line, a pending relay and a chat Kevin asked for', async () => {
    const named = make({ addressee: { avatarId: 'rex', confidence: 0.9 } });
    await named.manager.route(avatar('echo', 'Sage, look at this'));
    const relay = make({ addressee: { avatarId: 'rex', confidence: 0.9 } });
    await relay.manager.route(kevin('Echo, ask Sage what she thinks'));
    await relay.manager.route(avatar('echo', 'Sage, Kevin wants to know'));
    const talk = make({ addressee: { avatarId: 'rex', confidence: 0.9 } });
    await talk.manager.route(kevin('Echo and Sage, talk to each other'));
    await talk.manager.route(avatar('echo', 'so what do you think?'));
    expect(named.addressee).not.toHaveBeenCalled();
    expect(relay.addressee).not.toHaveBeenCalled();
    expect(talk.addressee).not.toHaveBeenCalled();
  });
});

describe('converseTarget', () => {
  const at = (text: string) => converseTarget(text, ['echo', 'sage', 'rex'], (id) => NAMES[id]);
  it('finds the avatar the conversation is with', () => {
    const cases: Array<[string, string | null]> = [
      ['talk to Sage', 'sage'],
      ['TALK WITH sage please', 'sage'],
      ['chat to Echo', 'echo'],
      ['speak with Rex', 'rex'],
      ['converse with Sage', 'sage'],
      ['Can you strike up a conversation with Sage, please?', 'sage'],
      ['start a chat with Echo', 'echo'],
      ['have a nice discussion with Rex', 'rex'],
      ['hold a debate with Sage', 'sage'],
      ['begin a conversation with Echo', 'echo'],
      ['get into a conversation with Sage', 'sage'],
      ['say hi to Sage', 'sage'],
      ['say hello to Rex', 'rex'],
      ['get to know Sage', 'sage'],
      ['introduce yourself to Echo', 'echo'],
      ['you and Sage should talk', 'sage'],
      ['you and Rex chat', 'rex'],
      ['argue with Sage about it', 'sage'],
      ['debate this with Rex', 'rex'],
      ['discuss the plan with Echo', 'echo'],
      ['talk to my friend Sage', 'sage'],
      ['talk to Echo about Sage', 'echo'],
      ["I'd like you to talk to Sage", 'sage'],
      ['I think you should talk to Sage', 'sage'],
      // Not a conversation with an avatar.
      ['talk to me', null],
      ['Sage, talk to me', null],
      ['talk to me, Sage', null],
      ['talk to each other about Sage', null],
      ['tell me about Sage', null],
      ['what do you think of Sage?', null],
      ['Sage, ask Echo what time it is', null],
      ['talk to Sagely things', null],
      // Kevin is the one who wants to talk.
      ['I want to talk to Sage', null],
      ["Can I speak to Sage?", null],
      ["let's chat with Echo", null],
      ['let me say hi to Sage', null],
    ];
    for (const [text, expected] of cases) expect([text, at(text)]).toEqual([text, expected]);
  });
});

describe('FloorManager: a conversation Kevin asks for', () => {
  type Row = { line: string; partner?: 'echo' | 'sage'; wake?: boolean; starter: string; target: string; reason?: string };
  const rows: Row[] = [
    { line: 'Can you strike up a conversation with Sage, please?', partner: 'echo', starter: 'echo', target: 'sage', reason: 'last-partner' },
    { line: 'Can you strike up a conversation with Echo, please?', partner: 'sage', starter: 'sage', target: 'echo', reason: 'last-partner' },
    { line: 'Can you strike up a conversation with Echo, please?', partner: 'echo', starter: 'sage', target: 'echo', reason: 'host' },
    { line: 'Can you strike up a conversation with Echo, please?', starter: 'sage', target: 'echo', reason: 'host' },
    { line: "I'd like you to talk to Sage.", starter: 'echo', target: 'sage', reason: 'host' },
    { line: 'Hey Echo, talk to Sage', starter: 'echo', target: 'sage', reason: 'addressed' },
    { line: 'Hey Echo, talk to Sage', partner: 'sage', starter: 'echo', target: 'sage', reason: 'addressed' },
    { line: 'Echo, talk to Sage', starter: 'echo', target: 'sage', reason: 'addressed' },
    { line: 'talk to Sage', wake: true, starter: 'echo', target: 'sage', reason: 'last-partner' },
    { line: 'Sage, have a chat with Echo', starter: 'sage', target: 'echo', reason: 'addressed' },
    { line: 'Sage, could you chat with Echo', partner: 'echo', starter: 'sage', target: 'echo', reason: 'addressed' },
    { line: 'Ask Sage to talk to Echo', starter: 'sage', target: 'echo', reason: 'addressed' },
    { line: 'you two talk to each other', starter: 'echo', target: 'sage' },
    { line: 'you two have a chat', partner: 'sage', starter: 'sage', target: 'echo' },
  ];

  it.each(rows)('$line (partner $partner, wake $wake) -> $starter starts', async (row) => {
    const { manager, bid, addressee } = make({ ids: ['echo', 'sage'], addressee: { avatarId: 'echo', confidence: 0.99 } });
    if (row.partner) await manager.route(kevin(`${row.partner === 'echo' ? 'Echo' : 'Sage'}, hello`, 0));
    if (row.wake) manager.listenTo('echo', 500);
    const start = await manager.route(kevin(row.line, 1_000));
    expect(start.speakers).toEqual([{ avatarId: row.starter, reason: row.reason ?? expect.any(String) }]);
    expect(start.channel).toBe('aloud');
    expect(start.converse).toEqual({ starter: row.starter, target: row.target });
    expect(manager.state().talking).toBe(true);
    expect(addressee).not.toHaveBeenCalled();
    // Twelve and more turns back and forth, whatever the lines say, hours apart: always the other one, always out loud.
    let speaker = row.starter;
    for (let turn = 0; turn < 16; turn += 1) {
      const other = speaker === 'echo' ? 'sage' : 'echo';
      const text = turn % 3 === 0 ? 'Nice weather.' : turn % 3 === 1 ? 'Rex, what do you think?' : `${speaker === 'echo' ? 'Echo' : 'Sage'} agrees.`;
      const decision = await manager.route({ ...avatar(speaker, text, 2_000 + turn * 3_600_000), ...(turn === 0 ? { toPerson: true } : {}) });
      expect(ids(decision)).toEqual([other]);
      expect(decision.channel).toBe('aloud');
      expect(decision.talk).toBe(true);
      expect(decision.budget).toBeUndefined();
      speaker = other;
    }
    expect(bid).not.toHaveBeenCalled();
    // Kevin speaking ends it.
    await manager.route(kevin('thanks', 99_000_000_000));
    expect(manager.state().talking).toBe(false);
    expect((await manager.route(avatar('echo', 'Anyone?', 99_000_001_000))).channel).toBe('back');
  });

  it('keeps the old rules for lines that are not a conversation with an avatar', async () => {
    const lines: Array<[string, string[], boolean]> = [
      ['Sage, ask Echo what time it is', ['sage'], false],
      // Two names and no rule: both answer unless the intent model picks one (see the intent tests).
      ["Echo, what do you think of Sage?", ['echo', 'sage'], false],
      ['tell me about Sage', ['sage'], false],
      ['Sage, talk to me', ['sage'], false],
      ['talk to me', ['echo'], false],
      ['Sage?', ['sage'], false],
      ['I want to talk to Sage', ['sage'], false],
    ];
    for (const [line, expected, talking] of lines) {
      const { manager } = make({ ids: ['echo', 'sage'] });
      const decision = await manager.route(kevin(line));
      expect([line, ids(decision)]).toEqual([line, expected]);
      expect([line, decision.converse, manager.state().talking]).toEqual([line, undefined, talking]);
    }
    const relay = await make({ ids: ['echo', 'sage'] }).manager.route(kevin('Sage, ask Echo what time it is'));
    expect(relay.relay).toEqual({ from: 'sage', to: 'echo' });
  });

  it('with three avatars the third only overhears a pair conversation', async () => {
    const { manager, bid } = make();
    const start = await manager.route(kevin('Echo, talk to Sage'));
    expect(start.converse).toEqual({ starter: 'echo', target: 'sage' });
    // Lines that name Rex or are aimed at him do not pull him in.
    expect(ids(await manager.route({ ...avatar('echo', 'Rex would like this too.', 2_000), toPerson: true }))).toEqual(['sage']);
    expect(ids(await manager.route(avatar('sage', 'Rex, are you there?', 3_000)))).toEqual(['echo']);
    expect(ids(await manager.route(avatar('echo', 'Sure.', 4_000)))).toEqual(['sage']);
    // Rex speaking is not part of the chat: quiet, back channel, no pull on the pair.
    const rex = await manager.route(avatar('rex', 'Interesting.', 5_000));
    expect(rex.channel).toBe('back');
    expect(rex.talk).toBeUndefined();
    expect(bid).toHaveBeenCalled();
  });

  it('starts with the first other avatar when the host is the target and nobody else fits', async () => {
    const { manager } = make({ ids: ['echo', 'sage', 'rex'] });
    const start = await manager.route(kevin('talk to Echo'));
    expect(start.speakers).toEqual([{ avatarId: 'sage', reason: 'host' }]);
    expect(start.converse).toEqual({ starter: 'sage', target: 'echo' });
  });

  it('ignores a last partner older than the window', async () => {
    const { manager } = make({ ids: ['echo', 'sage', 'rex'] });
    await manager.route(kevin('Rex, hi', 0));
    const stale = await manager.route(kevin('talk to Sage', PARTNER_WINDOW_MS + 1));
    expect(stale.speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
  });
});
