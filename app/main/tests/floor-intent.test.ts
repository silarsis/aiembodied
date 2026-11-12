import { describe, expect, it, vi } from 'vitest';
import { FloorManager, type IntentFunction, type IntentResult, type Scene } from '../src/floor/floor-manager.js';

const NAMES: Record<string, string> = { echo: 'Echo', sage: 'Sage', rex: 'Rex' };

function make(options: { ids?: string[]; intent?: IntentResult | Error | 'hang' | 'garbage'; timeoutMs?: number; scene?: Scene } = {}) {
  const ids = options.ids ?? ['echo', 'sage', 'rex'];
  const intent = vi.fn<IntentFunction>(async () => {
    if (options.intent instanceof Error) throw options.intent;
    if (options.intent === 'hang') return new Promise<IntentResult>(() => undefined);
    if (options.intent === 'garbage') return { addressed: 'ghost', wants: 'answer', other: null };
    return options.intent ?? { addressed: 'unclear', wants: 'answer', other: null };
  });
  const manager = new FloorManager({
    avatarIds: () => ids,
    nameOf: (id) => NAMES[id] ?? id,
    intent,
    intentTimeoutMs: options.timeoutMs ?? 50,
    scene: options.scene ? () => options.scene as Scene : undefined,
  });
  return { manager, intent };
}
const kevin = (text: string, at = 1_000) => ({ from: 'person:kevin' as const, text, at });
const avatar = (id: string, text: string, at = 1_000) => ({ from: `avatar:${id}` as const, text, at });
const ids = (decision: { speakers: Array<{ avatarId: string }> }) => decision.speakers.map((s) => s.avatarId);
const NOT_CLEAR = 'Tell me about Sage.';

describe('FloorManager: the intent model', () => {
  it('is asked about lines the rules are not sure of, with the scene, the recent lines, the host and the partner', async () => {
    const { manager, intent } = make({ intent: { addressed: 'sage', wants: 'answer', other: null } });
    await manager.route(kevin('Rex, hello', 0));
    await manager.route(avatar('rex', 'Hi Kevin.', 500));
    const decision = await manager.route(kevin('Not you, Echo. Sage, what do you think?', 60_000));
    expect(intent).toHaveBeenCalledOnce();
    const [input, signal] = intent.mock.calls[0];
    expect(input).toEqual({
      text: 'Not you, Echo. Sage, what do you think?',
      recent: [
        { from: 'person:kevin', text: 'Rex, hello' },
        { from: 'avatar:rex', text: 'Hi Kevin.' },
      ],
      candidates: [
        { avatarId: 'echo', name: 'Echo' },
        { avatarId: 'sage', name: 'Sage' },
        { avatarId: 'rex', name: 'Rex' },
      ],
      hostId: 'echo',
      partnerId: 'rex',
    });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(decision.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
    expect(decision.decidedBy).toBe('model');
    expect(decision.trace.join(' ')).toMatch(/person: intent model -> sage answer \(\d+ ms\)/);
  });

  it('gives no partner when the last talk was too long ago', async () => {
    const { manager, intent } = make();
    await manager.route(kevin('Rex, hello', 0));
    await manager.route(kevin(NOT_CLEAR, 10 * 60_000));
    expect(intent.mock.calls[0][0].partnerId).toBeNull();
  });

  it('is not asked about clear lines, and says the rules decided', async () => {
    const { manager, intent } = make();
    const lines = [
      'Sage, what time is it?',
      'Hey Echo, how are you?',
      'What is the weather like?',
      'You two, introduce yourselves.',
      'Hello everybody.',
      'Both of you, say hello.',
      'Everyone, what do you think?',
      'Echo and Sage, talk to each other',
      'Sage, ask Echo what time it is.',
      'Echo, talk to Sage.',
      'I want to talk to Sage.',
      'Sage, tell Echo she should talk to Rex.',
    ];
    for (const line of lines) {
      const decision = await manager.route(kevin(line));
      expect([line, decision.decidedBy, decision.trace[0]]).toEqual([line, 'rules', expect.stringContaining('person: clear rule')]);
    }
    expect(intent).not.toHaveBeenCalled();
  });

  it('has its own trace line when Kevin talks to the avatar himself', async () => {
    const { manager } = make();
    const decision = await manager.route(kevin('I want to talk to Sage.'));
    expect(decision.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
    expect(decision.trace).toEqual(['person: clear rule (Kevin talks to the avatar himself)', 'person: Kevin wants to talk to sage himself -> sage answers Kevin']);
  });

  it('lets the opening avatar pass a question on even when the line also says "talk to"', async () => {
    const { manager } = make();
    const decision = await manager.route(kevin('Sage, tell Echo she should talk to Rex.'));
    expect(decision.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
    expect(decision.relay).toEqual({ from: 'sage', to: 'echo' });
    expect(decision.converse).toBeUndefined();
    expect(manager.state().talking).toBe(false);
  });

  it('is not asked with one avatar in the scene', async () => {
    const { manager, intent } = make({ ids: ['echo'] });
    const decision = await manager.route(kevin('Tell me about Sage.'));
    expect(ids(decision)).toEqual(['echo']);
    expect(intent).not.toHaveBeenCalled();
  });

  describe('turns the answer into a decision', () => {
    it('answer: the addressed avatar answers Kevin', async () => {
      const { manager } = make({ intent: { addressed: 'echo', wants: 'answer', other: null } });
      const decision = await manager.route(kevin('Echo, what do you think of Sage?'));
      expect(decision.speakers).toEqual([{ avatarId: 'echo', reason: 'addressed' }]);
      expect(decision.converse).toBeUndefined();
      expect(decision.relay).toBeUndefined();
      expect(manager.state()).toMatchObject({ talking: false, partner: 'echo' });
    });

    it('converse: exactly what the conversation rule does, the pair alternates aloud', async () => {
      const { manager } = make({ ids: ['echo', 'sage'], intent: { addressed: 'echo', wants: 'converse', other: 'sage' } });
      const decision = await manager.route(kevin('Hey Eko, have a word with Sage.'));
      expect(decision.speakers).toEqual([{ avatarId: 'echo', reason: 'addressed' }]);
      expect(decision.converse).toEqual({ starter: 'echo', target: 'sage' });
      expect(decision.channel).toBe('aloud');
      expect(decision.decidedBy).toBe('model');
      expect(decision.trace.join(' ')).toMatch(/intent model -> echo converse sage/);
      expect(manager.state().talking).toBe(true);
      const reply = await manager.route({ ...avatar('echo', 'Hello over there.', 2_000), toPerson: true });
      expect(ids(reply)).toEqual(['sage']);
      expect(reply.talk).toBe(true);
      expect(reply.channel).toBe('aloud');
    });

    it('converse: the target is never the starter; an unclear listener falls back to the partner, then the host', async () => {
      const unclear: IntentResult = { addressed: 'unclear', wants: 'converse', other: 'sage' };
      const fresh = make({ intent: unclear });
      await fresh.manager.route(kevin('Rex, hi', 0));
      const viaPartner = await fresh.manager.route(kevin(NOT_CLEAR, 1_000));
      expect(viaPartner.converse).toEqual({ starter: 'rex', target: 'sage' });
      expect(viaPartner.speakers[0].reason).toBe('last-partner');
      const targetIsPartner = make({ intent: unclear });
      await targetIsPartner.manager.route(kevin('Sage, hi', 0));
      const viaHost = await targetIsPartner.manager.route(kevin(NOT_CLEAR, 1_000));
      expect(viaHost.converse).toEqual({ starter: 'echo', target: 'sage' });
      expect(viaHost.speakers[0].reason).toBe('host');
      const hostIsTarget = make({ intent: { addressed: 'unclear', wants: 'converse', other: 'echo' } });
      const viaFirst = await hostIsTarget.manager.route(kevin(NOT_CLEAR));
      expect(viaFirst.converse).toEqual({ starter: 'sage', target: 'echo' });
    });

    it('relay: the addressed avatar answers and passes the question on, then the target answers aloud', async () => {
      const { manager } = make({ ids: ['echo', 'sage'], intent: { addressed: 'sage', wants: 'relay', other: 'echo' } });
      const decision = await manager.route(kevin('Not you, Echo. Sage, find out what Echo is up to.'));
      expect(decision.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
      expect(decision.relay).toEqual({ from: 'sage', to: 'echo' });
      expect(decision.decidedBy).toBe('model');
      const passed = await manager.route({ ...avatar('sage', 'Echo, what are you up to?', 2_000), toPerson: true });
      expect(ids(passed)).toEqual(['echo']);
      expect(passed.relay).toEqual({ from: 'sage', to: 'echo' });
      expect(passed.channel).toBe('aloud');
    });

    it('everyone: all avatars in scene order', async () => {
      const { manager } = make({ intent: { addressed: 'everyone', wants: 'answer', other: null } });
      const decision = await manager.route(kevin('I wonder what you both think of the new sofa in the living room'));
      expect(ids(decision)).toEqual(['echo', 'sage', 'rex']);
      expect(decision.speakers.every((s) => s.reason === 'all')).toBe(true);
      expect(decision.decidedBy).toBe('model');
    });

    it('unclear: the partner if recent, else the host, never the other avatar', async () => {
      const partner = make({ intent: { addressed: 'unclear', wants: 'answer', other: null } });
      await partner.manager.route(kevin('Sage, hi', 0));
      expect((await partner.manager.route(kevin(NOT_CLEAR, 1_000))).speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
      const stale = make({ intent: { addressed: 'unclear', wants: 'answer', other: null } });
      await stale.manager.route(kevin('Sage, hi', 0));
      expect((await stale.manager.route(kevin(NOT_CLEAR, 10 * 60_000))).speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
      const partnerIsOther = make({ intent: { addressed: 'unclear', wants: 'answer', other: 'sage' } });
      await partnerIsOther.manager.route(kevin('Sage, hi', 0));
      expect((await partnerIsOther.manager.route(kevin(NOT_CLEAR, 1_000))).speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
      const hostIsOther = make({ intent: { addressed: 'unclear', wants: 'answer', other: 'echo' } });
      expect((await hostIsOther.manager.route(kevin(NOT_CLEAR))).speakers).toEqual([{ avatarId: 'sage', reason: 'host' }]);
    });

    it('an answer that does not hang together counts as a plain answer by the addressed avatar', async () => {
      const answers: IntentResult[] = [
        { addressed: 'sage', wants: 'converse', other: null },
        { addressed: 'sage', wants: 'relay', other: null },
        { addressed: 'sage', wants: 'converse', other: 'sage' },
        { addressed: 'sage', wants: 'relay', other: 'sage' },
      ];
      for (const answer of answers) {
        const { manager } = make({ intent: answer });
        const decision = await manager.route(kevin(NOT_CLEAR));
        expect([answer.wants, answer.other, ids(decision), decision.converse, decision.relay]).toEqual([answer.wants, answer.other, ['sage'], undefined, undefined]);
        expect(manager.state().talking).toBe(false);
        expect(decision.decidedBy).toBe('model');
      }
      const everyone = make({ intent: { addressed: 'everyone', wants: 'relay', other: null } });
      expect(ids(await everyone.manager.route(kevin(NOT_CLEAR)))).toEqual(['echo', 'sage', 'rex']);
    });
  });

  describe('falls back to the rules', () => {
    it.each([
      ['a timeout', 'hang' as const, /intent model failed \(Intent model timed out\) -> rules/],
      ['an error', new Error('server down'), /intent model failed \(server down\) -> rules/],
      ['an answer outside the scene', 'garbage' as const, /intent model failed \(The intent answer was not usable\) -> rules/],
    ])('on %s', async (_label, intent, trace) => {
      const { manager } = make({ intent });
      const decision = await manager.route(kevin('Echo, what do you think of Sage?'));
      expect(ids(decision)).toEqual(['echo', 'sage']);
      expect(decision.decidedBy).toBe('rules-fallback');
      expect(decision.trace.join(' ')).toMatch(trace);
      expect(manager.state().talking).toBe(false);
    });

    it('uses the old rules for a buried group word and for a name inside the line', async () => {
      const { manager } = make({ intent: new Error('down') });
      expect(ids(await manager.route(kevin('I wonder what you both think of the new sofa in the living room')))).toEqual(['echo', 'sage', 'rex']);
      expect(ids(await manager.route(kevin(NOT_CLEAR)))).toEqual(['sage']);
    });

    it('does not wait longer than the timeout', async () => {
      const { manager } = make({ intent: 'hang', timeoutMs: 30 });
      const started = Date.now();
      await manager.route(kevin(NOT_CLEAR));
      expect(Date.now() - started).toBeLessThan(1_000);
    });
  });

  describe('when Kevin speaks again while the model is thinking', () => {
    it('drops the old line: no speakers, no state change, the call is aborted', async () => {
      let resolve: (result: IntentResult) => void = () => undefined;
      let aborted = false;
      const intent = vi.fn<IntentFunction>((_input, signal) => {
        signal.addEventListener('abort', () => (aborted = true));
        return new Promise<IntentResult>((r) => (resolve = r));
      });
      const manager = new FloorManager({ avatarIds: () => ['echo', 'sage', 'rex'], nameOf: (id) => NAMES[id] ?? id, intent, intentTimeoutMs: 5_000 });
      const pending = manager.route(kevin('Hey Eko, have a word with Sage.'));
      await Promise.resolve();
      expect(intent).toHaveBeenCalledOnce();
      manager.bargeIn();
      expect(aborted).toBe(true);
      resolve({ addressed: 'echo', wants: 'converse', other: 'sage' });
      const decision = await pending;
      expect(decision.speakers).toEqual([]);
      expect(decision.trace.join(' ')).toContain('Kevin spoke again');
      expect(manager.state()).toMatchObject({ talking: false, partner: null });
    });

    it('keeps the newer line when the older answer arrives late', async () => {
      const resolvers: Array<(result: IntentResult) => void> = [];
      const intent = vi.fn<IntentFunction>(() => new Promise<IntentResult>((r) => resolvers.push(r)));
      const manager = new FloorManager({ avatarIds: () => ['echo', 'sage'], nameOf: (id) => NAMES[id] ?? id, intent, intentTimeoutMs: 5_000 });
      const first = manager.route(kevin('Hey Eko, have a word with Sage.', 1_000));
      await Promise.resolve();
      const second = manager.route(kevin('Tell me about Sage.', 2_000));
      await Promise.resolve();
      resolvers[1]({ addressed: 'sage', wants: 'answer', other: null });
      resolvers[0]({ addressed: 'echo', wants: 'converse', other: 'sage' });
      const [older, newer] = [await first, await second];
      expect(older.speakers).toEqual([]);
      expect(newer.speakers).toEqual([{ avatarId: 'sage', reason: 'addressed' }]);
      expect(manager.state()).toMatchObject({ talking: false, partner: 'sage' });
    });
  });
});
