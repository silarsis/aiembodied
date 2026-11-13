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

describe('FloorManager: the chat-model intent (fallback for the quick model)', () => {
  it('is asked with the scene, the recent lines, the host and the partner', async () => {
    const { manager, intent } = make({ intent: { addressed: 'sage', wants: 'answer', other: null } });
    manager.listenTo('rex', 0);
    await manager.route(avatar('rex', 'Hi Kevin.', 500));
    const decision = await manager.route(kevin('Not you, Echo. Sage, what do you think?', 60_000));
    expect(intent).toHaveBeenCalledOnce();
    const [input, signal] = intent.mock.calls[0];
    expect(input).toEqual({
      text: 'Not you, Echo. Sage, what do you think?',
      recent: [{ from: 'avatar:rex', text: 'Hi Kevin.' }],
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
    expect(decision.trace.join(' ')).toMatch(/person: no quick intent.*person: chat model decided -> sage answer \(\d+ ms\)/);
  });

  it('gives no partner when the last talk was too long ago', async () => {
    const { manager, intent } = make();
    manager.listenTo('rex', 0);
    await manager.route(kevin(NOT_CLEAR, 10 * 60_000));
    expect(intent.mock.calls[0][0].partnerId).toBeNull();
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
      expect(decision.trace.join(' ')).toMatch(/chat model decided -> echo converse sage/);
      expect(manager.state().talking).toBe(true);
      const reply = await manager.route({ ...avatar('echo', 'Hello over there.', 2_000), toPerson: true });
      expect(ids(reply)).toEqual(['sage']);
      expect(reply.talk).toBe(true);
      expect(reply.channel).toBe('aloud');
    });

    it('converse: the target is never the starter; an unclear listener falls back to the partner, then the host', async () => {
      const unclear: IntentResult = { addressed: 'unclear', wants: 'converse', other: 'sage' };
      const fresh = make({ intent: unclear });
      fresh.manager.listenTo('rex', 0);
      const viaPartner = await fresh.manager.route(kevin(NOT_CLEAR, 1_000));
      expect(viaPartner.converse).toEqual({ starter: 'rex', target: 'sage' });
      expect(viaPartner.speakers[0].reason).toBe('last-partner');
      const targetIsPartner = make({ intent: unclear });
      targetIsPartner.manager.listenTo('sage', 0);
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
      partner.manager.listenTo('sage', 0);
      expect((await partner.manager.route(kevin(NOT_CLEAR, 1_000))).speakers).toEqual([{ avatarId: 'sage', reason: 'last-partner' }]);
      const stale = make({ intent: { addressed: 'unclear', wants: 'answer', other: null } });
      stale.manager.listenTo('sage', 0);
      expect((await stale.manager.route(kevin(NOT_CLEAR, 10 * 60_000))).speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
      const partnerIsOther = make({ intent: { addressed: 'unclear', wants: 'answer', other: 'sage' } });
      partnerIsOther.manager.listenTo('sage', 0);
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

  describe('when the chat model cannot answer', () => {
    it.each([
      ['a timeout', 'hang' as const, /chat model failed \(Intent model timed out\)/],
      ['an error', new Error('server down'), /chat model failed \(server down\)/],
      ['an answer outside the scene', 'garbage' as const, /chat model failed \(Intent model gave an answer that was not usable\)/],
    ])('on %s the host answers (no text analysis)', async (_label, intent, trace) => {
      const { manager } = make({ intent });
      const decision = await manager.route(kevin('Echo, what do you think of Sage?'));
      expect(decision.speakers).toEqual([{ avatarId: 'echo', reason: 'host' }]);
      expect(decision.decidedBy).toBe('default');
      expect(decision.trace.join(' ')).toMatch(trace);
      expect(manager.state().talking).toBe(false);
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
