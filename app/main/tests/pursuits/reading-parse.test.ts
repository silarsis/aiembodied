import { describe, expect, it } from 'vitest';
import {
  firstUrl,
  linkNear,
  parseChoice,
  parseNext,
  parseNote,
  splitChunks,
} from '../../src/pursuits/reading-parse.js';

describe('parseChoice', () => {
  it('reads PICK with a link and a reason', () => {
    expect(
      parseChoice(
        'PICK: Attention Is All You Need | https://example.org/p/1 | It started everything.',
      ),
    ).toEqual({
      kind: 'pick',
      title: 'Attention Is All You Need',
      link: 'https://example.org/p/1',
      why: 'It started everything.',
    });
  });

  it('reads PICK without a link', () => {
    expect(parseChoice('PICK: Scaling laws | the curves are pretty')).toMatchObject({
      kind: 'pick',
      title: 'Scaling laws',
      link: null,
      why: 'the curves are pretty',
    });
  });

  it('reads REFINE and NOTHING', () => {
    expect(parseChoice('REFINE: papers about memory in agents')).toEqual({
      kind: 'refine',
      idea: 'papers about memory in agents',
    });
    expect(parseChoice('NOTHING')).toEqual({ kind: 'nothing' });
    expect(parseChoice('   ')).toEqual({ kind: 'nothing' });
  });

  it('takes an unlabelled first line as the pick', () => {
    expect(parseChoice('"Retrieval and Memory"\nbecause it is short')).toMatchObject({
      kind: 'pick',
      title: 'Retrieval and Memory',
    });
  });

  it('ignores case and bullets', () => {
    expect(parseChoice('- **pick**: A Paper | why not')).toMatchObject({
      kind: 'pick',
      title: 'A Paper',
    });
  });
});

describe('parseNote', () => {
  it('reads the labelled lines', () => {
    const note = parseNote(
      'TAKEAWAY: Memory helps.\nOPINION: I liked it.\nKEVIN: He builds agents.\nQUESTIONS: Does it scale? | Who tested it?',
    );
    expect(note).toEqual({
      takeaway: 'Memory helps.',
      opinion: 'I liked it.',
      connection: 'He builds agents.',
      questions: ['Does it scale?', 'Who tested it?'],
    });
  });

  it('uses the whole reply as the takeaway when there are no labels', () => {
    expect(parseNote('Just some thoughts.\nOn two lines.')).toMatchObject({
      takeaway: 'Just some thoughts. On two lines.',
      questions: [],
    });
  });

  it('drops "none" questions', () => {
    expect(parseNote('TAKEAWAY: x\nQUESTIONS: none').questions).toEqual([]);
  });
});

describe('parseNext', () => {
  it('reads continue and a tell line', () => {
    expect(parseNext('NEXT: continue\nTELL: Kevin, you should see this.')).toEqual({
      go: 'again',
      tell: 'Kevin, you should see this.',
    });
  });
  it('stops on stop, on nonsense, and ignores TELL none', () => {
    expect(parseNext('NEXT: stop\nTELL: none')).toEqual({ go: 'stop', tell: null });
    expect(parseNext('banana')).toEqual({ go: 'stop', tell: null });
  });
});

describe('text helpers', () => {
  it('finds a url without trailing punctuation', () => {
    expect(firstUrl('see https://a.b/c, ok')).toBe('https://a.b/c');
    expect(firstUrl('nothing')).toBeNull();
  });

  it('finds a link near a title in the results', () => {
    expect(linkNear('1. Foo Bar - https://x.y/1\n2. Baz - https://x.y/2', 'baz')).toBe(
      'https://x.y/2',
    );
  });

  it('splits at paragraph ends and covers the whole text', () => {
    const text = `${'a'.repeat(60)}\n\n${'b'.repeat(60)}\n\n${'c'.repeat(30)}`;
    const chunks = splitChunks(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((chunk) => chunk.length <= 100)).toBe(true);
    expect(chunks.join('').replace(/\s/g, '')).toBe(text.replace(/\s/g, ''));
    expect(splitChunks('short', 100)).toEqual(['short']);
  });
});
