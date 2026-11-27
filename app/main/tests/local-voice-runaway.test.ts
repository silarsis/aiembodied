import { describe, expect, it } from 'vitest';
import { RUNAWAY_FALLBACK_LINE, isRunawayOutput } from '../src/local-voice/runaway.js';

describe('isRunawayOutput', () => {
  it('catches a short chunk repeated many times', () => {
    expect(isRunawayOutput('2-'.repeat(20))).toBe(true);
    expect(isRunawayOutput(`Sure. ${'2-'.repeat(300)}`)).toBe(true);
    expect(isRunawayOutput('ha'.repeat(25))).toBe(true);
    expect(isRunawayOutput('abcdefgh'.repeat(20))).toBe(true);
    expect(isRunawayOutput('z'.repeat(30))).toBe(true);
  });

  it('lets fewer repeats and longer chunks through', () => {
    expect(isRunawayOutput('2-'.repeat(19))).toBe(false);
    expect(isRunawayOutput('abcdefghi'.repeat(30))).toBe(false);
    expect(isRunawayOutput('ha ha ha ha, that is funny')).toBe(false);
  });

  it('catches text with almost no variety even when no chunk repeats exactly', () => {
    // Three different characters over 400 characters, in an irregular order.
    const text = Array.from({ length: 400 }, (_, i) => 'ab '[(i * i + (i % 7)) % 3]).join('');
    expect(isRunawayOutput(text)).toBe(true);
  });

  it('does not stop ordinary replies, markdown rules or numbers', () => {
    expect(isRunawayOutput('')).toBe(false);
    expect(
      isRunawayOutput(
        'The latest papers this week cover agents, evaluation and a new way of training small models. '.repeat(
          5,
        ),
      ),
    ).toBe(false);
    expect(isRunawayOutput(`Title\n${'-'.repeat(60)}\nBody`)).toBe(false);
    expect(
      isRunawayOutput(
        '1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30',
      ),
    ).toBe(false);
  });

  it('has a short fallback line', () => {
    expect(RUNAWAY_FALLBACK_LINE).toBe('Sorry, I lost my train of thought.');
  });
});
