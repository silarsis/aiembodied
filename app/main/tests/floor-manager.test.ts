import { describe, expect, it, vi } from 'vitest';
import {
  BID_THRESHOLD,
  CHATTER_MAX_MS,
  CHATTER_MAX_TURNS,
  FloorManager,
  PARTNER_WINDOW_MS,
  findName,
  relayTargets,
  type BidFunction,
  type FloorBid,
  type Scene,
} from '../src/floor/floor-manager.js';
import { parseBids } from '../src/floor/bid.js';

const NAMES: Record<string, string> = { echo: 'Echo', sage: 'Sage', rex: 'Rex' };

function make(options: { ids?: string[]; bids?: FloorBid[] | Error; hear?: boolean; scene?: Scene } = {}) {
  const ids = options.ids ?? ['echo', 'sage', 'rex'];
  const bid = vi.fn<BidFunction>(async () => {
    if (options.bids instanceof Error) throw options.bids;
    return options.bids ?? [];
  });
  const manager = new FloorManager({ avatarIds: () => ids, nameOf: (id) => NAMES[id] ?? id, bid, hearChatter: () => options.hear === true, scene: options.scene ? () => options.scene as Scene : undefined });
  return { manager, bid };
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

  it('caps consecutive chatter turns until Kevin speaks again', async () => {
    const { manager } = make();
    for (let turn = 0; turn < CHATTER_MAX_TURNS; turn += 1) {
      expect(ids(await manager.route(avatar('echo', 'Sage, your move', 100 + turn)))).toEqual(['sage']);
    }
    const cut = await manager.route(avatar('sage', 'Echo, your move', 200));
    expect(cut.speakers).toEqual([]);
    expect(cut.budget).toMatchObject({ kind: 'turns', turns: CHATTER_MAX_TURNS });
    await manager.route(kevin('carry on', 300));
    expect(ids(await manager.route(avatar('echo', 'Sage?', 310)))).toEqual(['sage']);
  });

  it('caps chatter by time since it started', async () => {
    const { manager } = make();
    expect(ids(await manager.route(avatar('echo', 'Sage?', 1_000)))).toEqual(['sage']);
    expect(ids(await manager.route(avatar('sage', 'Echo?', 1_000 + CHATTER_MAX_MS - 1)))).toEqual(['echo']);
    const cut = await manager.route(avatar('echo', 'Sage?', 1_000 + CHATTER_MAX_MS));
    expect(cut.speakers).toEqual([]);
    expect(cut.budget?.kind).toBe('time');
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
    await manager.route(avatar('echo', 'Sage?'));
    expect(manager.state().chatterTurns).toBe(1);
    expect(manager.bargeIn()).toEqual(['echo']);
    expect(manager.state()).toMatchObject({ speaking: null, queue: [], chatterTurns: 0 });
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

  it('a talk chat stops at the longer turn budget', async () => {
    const { manager } = make({ ids: ['echo', 'sage'] });
    await manager.route(kevin('have a chat', 1_000));
    let last = await manager.route(avatar('echo', 'hi', 2_000));
    for (let i = 0; i < 8; i += 1) last = await manager.route(avatar(i % 2 ? 'echo' : 'sage', 'more', 3_000 + i));
    expect(last.speakers).toEqual([]);
    expect(last.budget?.kind).toBe('turns');
  });
});
