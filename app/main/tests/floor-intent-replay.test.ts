import { describe, expect, it, vi } from 'vitest';
import { FloorManager, type FloorDecision, type IntentFunction } from '../src/floor/floor-manager.js';
import { INTENT_CASES, type IntentCase } from './fixtures/floor-intent-cases.js';

const accepted = (value: string | string[]): string[] => (Array.isArray(value) ? value : [value]);

function run(c: IntentCase, withModel: boolean) {
  const ids = c.scene.map((name) => name.toLowerCase());
  const nameOf = (id: string) => c.scene.find((name) => name.toLowerCase() === id) ?? id;
  const truth = {
    addressed: accepted(c.speaker)[0],
    wants: accepted(c.intent)[0] as 'answer' | 'converse' | 'relay',
    other: accepted(c.target)[0] === 'none' ? null : accepted(c.target)[0],
  };
  const intent = vi.fn<IntentFunction>(async () => truth);
  const manager = new FloorManager({ avatarIds: () => ids, nameOf, intent: withModel ? intent : undefined });
  if (c.last) manager.listenTo(c.last.toLowerCase(), 1_000);
  return { manager, intent, ids, c };
}

function outcome(decision: FloorDecision, sceneSize: number) {
  const speakers = decision.speakers.map((s) => s.avatarId);
  const speaker = decision.converse?.starter ?? decision.relay?.from ?? (speakers.length === sceneSize && sceneSize > 1 ? 'everyone' : speakers.join('+'));
  const intent = decision.converse ? 'converse' : decision.relay ? 'relay' : 'answer';
  const target = decision.converse?.target ?? decision.relay?.to ?? 'none';
  return { speaker, intent, target };
}

const right = (c: IntentCase, got: ReturnType<typeof outcome>): boolean =>
  accepted(c.speaker).includes(got.speaker) && accepted(c.intent).includes(got.intent) && accepted(c.target).includes(got.target);

/**
 * Which of the 54 lines (index in the table) the rules cannot decide and the intent model is asked about.
 * Everything else is decided by code alone ("clear").
 */
const GOES_TO_MODEL = [
  21, // Echo, what do you think of Sage?  (two names, no pattern)
  22, // Tell me about Sage.  (one name, not the opener)
  31, // What does Sage think about this?  (debatable)
  32, // Rex, say something to Echo.
  34, // Echo, I don't want to hear from Sage right now, just tell me the time.
  35, // Not you, Echo. Sage, what do you think?
  37, // I was telling Sage earlier about my trip. Anyway Echo, what's on my calendar?
  38, // Echo, would you mind getting Sage's opinion on the sofa colour ...  (opener plus a second name)
  39, // My friend Sage from work is coming over later.  (debatable)
  42, // Could somebody who isn't Echo answer this one ...
  45, // I'd love to hear the two of you discuss ... Sage, you start.
  49, // Hey Eko, have a word with Sage.
  50, // Echo, stop talking to Sage and talk to me.
  51, // Rex, forget Echo for a second, what's the capital of France?
  52, // Sage, I'm not asking Echo, I'm asking you: will it rain?
];

/**
 * Clear lines where the rules are wrong. These are real misses, not hidden:
 * todo 33 "Let Rex and Sage talk for a while." (debatable): "let Rex" reads as a question to pass on to Rex.
 * todo 43 "Go on then, the pair of you, argue it out." (debatable): no name and no group word, so the last partner or host answers alone.
 * todo 44 "Ask her yourself." names nobody, so it stays with the rules; the answer is the partner, not a relay.
 * todo 53 "Tell her I said thanks." (debatable): same, "her" is not a name.
 */
const CLEAR_BUT_WRONG = [33, 43, 44, 53];

const SCORED_MODEL_CALLS = 13;

describe('the 54 lines of the intent check, replayed through the hybrid router', () => {
  it('has the same table as the script: 54 lines, 7 of them debatable', () => {
    expect(INTENT_CASES).toHaveLength(54);
    expect(INTENT_CASES.filter((c) => c.debatable)).toHaveLength(7);
  });

  it('asks the model about exactly the expected lines and nobody else', async () => {
    const asked: number[] = [];
    for (const [index, c] of INTENT_CASES.entries()) {
      const { manager, intent } = run(c, true);
      const decision = await manager.route({ from: 'person:kevin', text: c.text, at: 2_000 });
      if (intent.mock.calls.length > 0) asked.push(index);
      expect([index, c.text, decision.decidedBy]).toEqual([index, c.text, GOES_TO_MODEL.includes(index) ? 'model' : 'rules']);
    }
    expect(asked).toEqual(GOES_TO_MODEL);
    expect(asked.filter((index) => !INTENT_CASES[index].debatable)).toHaveLength(SCORED_MODEL_CALLS);
  });

  it('is right on every clear line except the recorded misses, with the rules alone', async () => {
    for (const [index, c] of INTENT_CASES.entries()) {
      if (GOES_TO_MODEL.includes(index)) continue;
      const { manager } = run(c, false);
      const got = outcome(await manager.route({ from: 'person:kevin', text: c.text, at: 2_000 }), c.scene.length);
      expect([index, c.text, right(c, got)]).toEqual([index, c.text, !CLEAR_BUT_WRONG.includes(index)]);
    }
  });

  it('with a model that knows the truth, gets 46 of the 47 scored lines (the miss is "Ask her yourself.")', async () => {
    let scored = 0;
    let correct = 0;
    const wrong: number[] = [];
    for (const [index, c] of INTENT_CASES.entries()) {
      const { manager } = run(c, true);
      const got = outcome(await manager.route({ from: 'person:kevin', text: c.text, at: 2_000 }), c.scene.length);
      if (c.debatable) continue;
      scored += 1;
      if (right(c, got)) correct += 1;
      else wrong.push(index);
    }
    expect({ scored, correct, wrong }).toEqual({ scored: 47, correct: 46, wrong: [44] });
  });

  it('without a model, falls back to the rules on the lines it would have asked about', async () => {
    const { manager } = run(INTENT_CASES[35], false);
    const decision = await manager.route({ from: 'person:kevin', text: INTENT_CASES[35].text, at: 2_000 });
    expect(decision.speakers.map((s) => s.avatarId)).toEqual(['echo', 'sage']);
    expect(decision.decidedBy).toBe('rules');
  });
});
