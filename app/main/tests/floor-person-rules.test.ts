import { describe, expect, it } from 'vitest';
import { classifyPersonLine } from '../src/floor/person-rules.js';

const NAMES: Record<string, string> = { echo: 'Echo', sage: 'Sage', rex: 'Rex' };
const nameOf = (id: string) => NAMES[id] ?? id;
const classify = (text: string, ids = ['echo', 'sage']) => classifyPersonLine(text, ids, nameOf);
const summary = (text: string, ids?: string[]) => {
  const rule = classify(text, ids);
  return [rule.kind, rule.clear] as const;
};

describe('classifyPersonLine: clear lines (no model needed)', () => {
  it('names nobody: the partner or host answers', () => {
    expect(summary("What's the weather like?")).toEqual(['no-name', true]);
    expect(summary('Thanks, that was really helpful.')).toEqual(['no-name', true]);
    expect(summary('Ask her yourself.')).toEqual(['no-name', true]);
  });

  it('is a group call only when the group word opens the line or the line is short, with no avatar named', () => {
    for (const line of ['You two, introduce yourselves.', 'Hello everybody.', 'Both of you, say hello.', 'Everyone, what do you think?', 'hey everyone', 'Both of you please settle which of the two plans is better for the weekend']) {
      expect(summary(line)).toEqual(['group', true]);
    }
  });

  it('is a vocative call when the line starts with the name, after at most a filler word', () => {
    for (const line of ['Sage, what time is it?', 'Hey Echo, how are you?', 'echo tell me a joke', 'Hi Sage!', 'ok, so Sage what now', 'Sage, talk to me.', 'Hey Echo, tell me about your day']) {
      const rule = classify(line);
      expect([line, rule.kind, rule.clear]).toEqual([line, 'vocative', true]);
    }
  });

  it('treats talk to each other, a question to pass on and a conversation with a named avatar as explicit rules', () => {
    expect(summary('Echo and Sage, talk to each other')).toEqual(['talk-each-other', true]);
    expect(summary('Sage, ask Echo what time it is.')).toEqual(['relay', true]);
    expect(summary('Tell Sage I said hello.')).toEqual(['relay', true]);
    expect(summary('Could one of you find out from Sage what she had planned today?')).toEqual(['relay', true]);
    expect(summary('Echo, talk to Sage.')).toEqual(['converse', true]);
    expect(summary('hey echo um can you like talk to sage for a bit')).toEqual(['converse', true]);
    expect(classify('Echo, talk to Sage.').converse).toBe('sage');
  });

  it('makes "Kevin talks to the avatar himself" an explicit rule', () => {
    for (const line of ['I want to talk to Sage.', 'can I speak to Sage', "let's chat with Sage"]) {
      const rule = classify(line);
      expect([line, rule.kind, rule.clear, rule.kevinWants]).toEqual([line, 'kevin-talks-to', true, 'sage']);
    }
  });

  it('lets a relay phrase right after the opening name win over a conversation phrase', () => {
    const rule = classify('Sage, tell Echo she should talk to Rex.', ['echo', 'sage', 'rex']);
    expect([rule.kind, rule.clear, rule.vocative, rule.relayed]).toEqual(['relay', true, 'sage', ['echo']]);
    expect(summary('Hey Sage, could you ask Echo to talk to Rex?', ['echo', 'sage', 'rex'])).toEqual(['relay', true]);
    // A relay phrase later in the line does not take over from the conversation rule.
    expect(summary('Echo, now talk to Sage and tell Rex hi', ['echo', 'sage', 'rex'])).toEqual(['converse', true]);
  });
});

describe('classifyPersonLine: lines for the model', () => {
  it('has two or more names and no explicit rule', () => {
    for (const line of ['Not you, Echo. Sage, what do you think?', 'Echo, what do you think of Sage?', "I was telling Sage earlier about my trip. Anyway Echo, what's on my calendar?", "Echo, would you mind getting Sage's opinion on the sofa colour?"]) {
      expect([line, ...summary(line)]).toEqual([line, 'multi-named', false]);
    }
  });

  it('has one name that is not the opener', () => {
    for (const line of ['Tell me about Sage.', 'Hey Eko, have a word with Sage.', "Could somebody who isn't Echo answer this one: what's two plus two?", 'My friend Sage from work is coming over later.']) {
      expect([line, ...summary(line)]).toEqual([line, 'named-inside', false]);
    }
  });

  it('has a group word buried in a longer line', () => {
    expect(summary('I wonder what you both think of the new sofa in the living room')).toEqual(['group', false]);
    expect(summary('Sage, I wonder what you both think of the new sofa')).toEqual(['group', false]);
    expect(summary('Everyone, what does Sage think?')).toEqual(['group', false]);
  });

  it('reports every name it found, in the order named', () => {
    const rule = classify('Not you, Echo. Sage, what do you think?');
    expect(rule.named).toEqual(['echo', 'sage']);
    expect(rule.vocative).toBeNull();
  });
});
