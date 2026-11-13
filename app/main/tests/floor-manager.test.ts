import { describe, expect, it, vi } from 'vitest';
import {
  BID_THRESHOLD,
  CHATTER_MAX_MS,
  FloorManager,
  PARTNER_WINDOW_MS,
  QUICK_INTENT_THRESHOLD,
  type AddresseeFunction,
  type AddresseeResult,
  type BidFunction,
  type FloorBid,
  type IntentFunction,
  type IntentResult,
  type QuickIntentFunction,
  type QuickIntentResult,
  type Scene,
} from '../src/floor/floor-manager.js';
import { parseBids } from '../src/floor/bid.js';

const NAMES: Record<string, string> = { echo: 'Echo', sage: 'Sage', rex: 'Rex' };

/** What the fake quick model says for a line; a line not listed makes it fail, so the floor falls to the default. */
const intent = (addressed: string, wants: IntentResult['wants'] = 'answer', other: string | null = null): IntentResult => ({ addressed, wants, other });
const SCRIPT: Record<string, IntentResult> = {
  'Sage, what do you think?': intent('sage'),
  'Sage, hello': intent('sage'),
  'Echo, hello': intent('echo'),
  'Rex, hi': intent('rex'),
  'Echo, tell a story': intent('echo'),
  'Echo and Sage, talk to each other about dinner': intent('echo', 'converse', 'sage'),
  'Echo and Sage, talk to each other': intent('echo', 'converse', 'sage'),
  'Echo, ask Sage what she thinks': intent('echo', 'relay', 'sage'),
  'Sage, ask Echo something': intent('sage', 'relay', 'echo'),
  "Sage, can you ask Echo what they're doing?": intent('sage', 'relay', 'echo'),
  "Ask Echo what she's doing": intent('unclear', 'relay', 'echo'),
  'Sage and Echo, what do you think?': intent('everyone'),
  'you two have a chat': intent('echo', 'converse', 'sage'),
  'have a chat': intent('echo', 'converse', 'sage'),
  'thanks': intent('unclear'),
};

function make(options: { script?: Record<string, IntentResult>; ids?: string[]; bids?: FloorBid[] | Error; hear?: boolean; scene?: Scene; addressee?: AddresseeResult | Error | 'hang' } = {}) {
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
  const script = { ...SCRIPT, ...options.script };
  const quickIntent = vi.fn<QuickIntentFunction>(async (input) => {
    const answer = script[input.text];
    if (!answer) throw new Error('no script for this line');
    return { ...answer, confidence: 0.95 };
  });
  const manager = new FloorManager({
    quickIntent,
    avatarIds: () => ids,
    nameOf: (id) => NAMES[id] ?? id,
    bid,
    addressee: options.addressee === undefined ? undefined : addressee,
    addresseeTimeoutMs: 50,
    hearChatter: () => options.hear === true,
    scene: options.scene ? () => options.scene as Scene : undefined,
  });
  return { manager, bid, addressee, quickIntent };
}
const kevin = (text: string, at = 1_000) => ({ from: 'person:kevin' as const, text, at });
const avatar = (id: string, text: string, at = 1_000) => ({ from: `avatar:${id}` as const, text, at });
const ids = (decision: { speakers: Array<{ avatarId: string }> }) => decision.speakers.map((s) => s.avatarId);

describe('FloorManager: Kevin speaks', () => {
  it('sends the avatar the quick model names the turn', async () => {
    const { manager, quickIntent } = make({ script: { 'what do you think, SAGE': intent('sage') } });
    const decision = await manager.route(kevin('what do you think, SAGE'));
    expect(decision.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
    expect(decision.channel).toBe('aloud');
    expect(decision.decidedBy).toBe('quick');
    expect(decision.trace.join(' ')).toContain('quick intent decided -> sage answer');
    expect(quickIntent.mock.calls[0][0]).toMatchObject({ text: 'what do you think, SAGE', hostId: 'echo', partnerId: null });
    expect(quickIntent.mock.calls[0][0].candidates.map((c) => c.avatarId)).toEqual(['echo', 'sage', 'rex']);
  });

  it('calls every avatar in scene order when the model says everyone', async () => {
    const { manager } = make();
    const decision = await manager.route(kevin('Sage and Echo, what do you think?'));
    expect(ids(decision)).toEqual(['echo', 'sage', 'rex']);
    expect(decision.speakers.every((s) => s.reason === 'all')).toBe(true);
  });

  it('prefers the last partner within the window, then falls back to the host (no model answer)', async () => {
    const { manager } = make();
    await manager.route(kevin('Sage, hello', 0));
    const soon = await manager.route(kevin('and what about lunch?', 60_000));
    expect(soon.speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
    expect(soon.decidedBy).toBe('default');
    const later = await manager.route(kevin('hmm', 60_000 + PARTNER_WINDOW_MS));
    expect(later.speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
    const stale = await manager.route(kevin('anyone?', 60_000 + PARTNER_WINDOW_MS * 2 + 1));
    expect(stale.speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
  });

  it('uses the host when nobody has talked yet, and the scene host when given', async () => {
    expect((await make().manager.route(kevin('hello'))).speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
    const scene: Scene = { id: 's', avatarIds: ['sage', 'rex'], hostId: 'rex' };
    expect((await make({ scene }).manager.route(kevin('hello'))).speakers).toEqual([{ avatarId: 'rex', reason: 'host' }]);
  });

  it('with one avatar always returns it without asking any model', async () => {
    const { manager, quickIntent } = make({ ids: ['echo'] });
    expect(manager.isMulti()).toBe(false);
    for (const text of ['hello', 'Sage?', 'everyone']) {
      const decision = await manager.route(kevin(text));
      expect(ids(decision)).toEqual(['echo']);
      expect(decision.decidedBy).toBe('default');
    }
    expect(quickIntent).not.toHaveBeenCalled();
  });
});

describe('FloorManager: Kevin intent steps', () => {
  const answer = (confidence: number, result: IntentResult = intent('sage')): QuickIntentFunction => async () => ({ ...result, confidence });
  const chat = (result: IntentResult = intent('rex')) => vi.fn<IntentFunction>(async () => result);
  const build = (quickIntent: QuickIntentFunction | undefined, chatIntent: IntentFunction | undefined, extra: Record<string, unknown> = {}) =>
    new FloorManager({ avatarIds: () => ['echo', 'sage', 'rex'], nameOf: (id) => NAMES[id], quickIntent, intent: chatIntent, quickIntentTimeoutMs: 40, intentTimeoutMs: 40, ...extra });

  it('step 1: a confident quick answer decides and the chat model is not asked', async () => {
    const chatIntent = chat();
    const decision = await build(answer(QUICK_INTENT_THRESHOLD), chatIntent).route(kevin('anything'));
    expect(decision.decidedBy).toBe('quick');
    expect(ids(decision)).toEqual(['sage']);
    expect(chatIntent).not.toHaveBeenCalled();
    expect(decision.trace.join(' ')).toMatch(/quick intent decided -> sage answer \(confidence 0\.80, \d+ ms\)/);
  });

  it('step 2: an unsure, failing or slow quick model hands the line to the chat model', async () => {
    const hang: QuickIntentFunction = () => new Promise<QuickIntentResult>(() => undefined);
    const fail: QuickIntentFunction = async () => {
      throw new Error('down');
    };
    for (const quick of [answer(0.5), fail, hang, undefined]) {
      const chatIntent = chat();
      const decision = await build(quick, chatIntent).route(kevin('anything'));
      expect(decision.decidedBy).toBe('model');
      expect(ids(decision)).toEqual(['rex']);
      expect(chatIntent).toHaveBeenCalledOnce();
      expect(decision.trace.join(' ')).toContain('chat model decided -> rex answer');
    }
  });

  it('step 3: when the chat model fails too, the unsure quick answer is used', async () => {
    const failing: IntentFunction = async () => {
      throw new Error('down');
    };
    const hang: IntentFunction = () => new Promise<IntentResult>(() => undefined);
    for (const chatIntent of [failing, hang, undefined]) {
      const decision = await build(answer(0.5), chatIntent).route(kevin('anything'));
      expect(decision.decidedBy).toBe('quick-low');
      expect(ids(decision)).toEqual(['sage']);
      expect(decision.trace.join(' ')).toContain('unsure quick answer');
    }
  });

  it('step 4: with no usable answer the recent partner, else the host, answers', async () => {
    const failing: IntentFunction = async () => {
      throw new Error('down');
    };
    const bad: QuickIntentFunction = async () => ({ ...intent('ghost'), confidence: 1 });
    const manager = build(bad, failing);
    const first = await manager.route(kevin('anything', 0));
    expect(first.decidedBy).toBe('default');
    expect(first.speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
    manager.listenTo('sage', 10);
    const second = await manager.route(kevin('anything', 1_000));
    expect(second.speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
    expect(await build(undefined, undefined).route(kevin('anything'))).toMatchObject({ decidedBy: 'default', speakers: [{ avatarId: 'echo', reason: 'host' }] });
  });

  it('drops a stale answer when Kevin speaks again, from either call', async () => {
    for (const stage of ['quick', 'chat'] as const) {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => (release = resolve));
      const slowQuick: QuickIntentFunction = async () => {
        await gate;
        return { ...intent('sage'), confidence: 0.99 };
      };
      const slowChat: IntentFunction = async () => {
        await gate;
        return intent('sage');
      };
      const unsure = answer(0.1);
      const manager = build(stage === 'quick' ? slowQuick : unsure, stage === 'quick' ? undefined : slowChat, { quickIntentTimeoutMs: 1_000, intentTimeoutMs: 1_000 });
      const first = manager.route(kevin('first line', 0));
      await new Promise((resolve) => setTimeout(resolve, 10));
      // Kevin speaks again: the first answer is dropped.
      const again = manager.route(kevin('second line', 5));
      release();
      const [a, b] = await Promise.all([first, again]);
      expect(a.speakers).toEqual([]);
      expect(a.trace.join(' ')).toContain('Kevin spoke again');
      expect(ids(b)).toEqual(['sage']);
    }
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
    expect(ids(both)).toEqual(['echo', 'sage']);
    expect(both.relay).toBeUndefined();
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

});

describe('FloorManager: addressee check', () => {
  it('is not used for Kevin: his lines go to the quick intent', async () => {
    const { manager, addressee, quickIntent } = make({ addressee: { avatarId: 'sage', confidence: 0.99 } });
    await manager.route(kevin('Sage, hello'));
    await manager.route(kevin('Sage, ask Echo something'));
    await manager.route(kevin('Echo and Sage, talk to each other'));
    expect(quickIntent).toHaveBeenCalledTimes(3);
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

describe('FloorManager: a conversation Kevin asks for', () => {
  type Row = { say: IntentResult; line: string; partner?: 'echo' | 'sage'; wake?: boolean; starter: string; target: string; reason?: string };
  const rows: Row[] = [
    { line: 'strike up a conversation with Sage', say: intent('unclear', 'converse', 'sage'), partner: 'echo', starter: 'echo', target: 'sage', reason: 'last-partner' },
    { line: 'strike up a conversation with Echo', say: intent('unclear', 'converse', 'echo'), partner: 'sage', starter: 'sage', target: 'echo', reason: 'last-partner' },
    { line: 'strike up with Echo (partner is Echo)', say: intent('unclear', 'converse', 'echo'), partner: 'echo', starter: 'sage', target: 'echo', reason: 'host' },
    { line: 'strike up with Echo (nobody yet)', say: intent('unclear', 'converse', 'echo'), starter: 'sage', target: 'echo', reason: 'host' },
    { line: 'I would like you to talk to Sage', say: intent('unclear', 'converse', 'sage'), starter: 'echo', target: 'sage', reason: 'host' },
    { line: 'Echo, talk to Sage', say: intent('echo', 'converse', 'sage'), starter: 'echo', target: 'sage', reason: 'addressed' },
    { line: 'Hey Echo, talk to Sage (partner Sage)', say: intent('echo', 'converse', 'sage'), partner: 'sage', starter: 'echo', target: 'sage', reason: 'addressed' },
    { line: 'talk to Sage (after the wake word)', say: intent('unclear', 'converse', 'sage'), wake: true, starter: 'echo', target: 'sage', reason: 'last-partner' },
    { line: 'Sage, have a chat with Echo', say: intent('sage', 'converse', 'echo'), starter: 'sage', target: 'echo', reason: 'addressed' },
    { line: 'Ask Sage to talk to Echo', say: intent('sage', 'converse', 'echo'), starter: 'sage', target: 'echo', reason: 'addressed' },
  ];

  it.each(rows)('$line (partner $partner, wake $wake) -> $starter starts', async (row) => {
    const { manager, bid, addressee } = make({ ids: ['echo', 'sage'], script: { [row.line]: row.say }, addressee: { avatarId: 'echo', confidence: 0.99 } });
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

  it('treats an inconsistent converse answer as a plain answer', async () => {
    const { manager } = make({ ids: ['echo', 'sage'], script: { 'talk to nobody': intent('sage', 'converse', 'sage') } });
    const decision = await manager.route(kevin('talk to nobody'));
    expect(ids(decision)).toEqual(['sage']);
    expect(decision.converse).toBeUndefined();
    expect(manager.state().talking).toBe(false);
  });

  it('with three avatars the third only overhears a pair conversation', async () => {
    const { manager, bid } = make({ script: { 'Echo, talk to Sage': intent('echo', 'converse', 'sage') } });
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
    const { manager } = make({ ids: ['echo', 'sage', 'rex'], script: { 'talk to Echo': intent('unclear', 'converse', 'echo') } });
    const start = await manager.route(kevin('talk to Echo'));
    expect(start.speakers).toEqual([{ avatarId: 'sage', reason: 'host' }]);
    expect(start.converse).toEqual({ starter: 'sage', target: 'echo' });
  });

  it('ignores a last partner older than the window', async () => {
    const { manager } = make({ ids: ['echo', 'sage', 'rex'], script: { 'talk to Sage': intent('unclear', 'converse', 'sage') } });
    await manager.route(kevin('Rex, hi', 0));
    const stale = await manager.route(kevin('talk to Sage', PARTNER_WINDOW_MS + 1));
    expect(stale.speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
  });
});
