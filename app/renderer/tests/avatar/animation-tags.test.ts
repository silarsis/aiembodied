import { describe, expect, it } from 'vitest';
import { extractAnimationTags } from '../../src/avatar/animation-tags.js';

describe('extractAnimationTags', () => {
  it('extracts multiple tags in order', () => {
    const tags = extractAnimationTags('Say hi {wave} then {happy-wave}.', {
      allowedSlugs: ['wave', 'happy-wave'],
    });

    expect(tags).toEqual(['wave', 'happy-wave']);
  });

  it('ignores malformed or unknown tags', () => {
    const tags = extractAnimationTags('Use {Wave} {bad slug} {} {jump} {wave}', {
      allowedSlugs: ['wave'],
    });

    expect(tags).toEqual(['wave']);
  });

  it('preserves duplicates in sequence', () => {
    const tags = extractAnimationTags('Combo {wave} then {wave} and {nod}.', {
      allowedSlugs: ['wave', 'nod'],
    });

    expect(tags).toEqual(['wave', 'wave', 'nod']);
  });
});
