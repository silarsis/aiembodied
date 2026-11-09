import { describe, expect, it } from 'vitest';
import {
  extractAnimationTags,
  extractAvatarTags,
  extractMotionTags,
  extractMoveTags,
  extractSceneTags,
} from '../../src/avatar/animation-tags.js';

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

describe('scene tags', () => {
  it('parses every scene tag in the order written, mixed with moves', () => {
    const tags = extractMotionTags(
      'Sure {go:bookshelf}{move:runs a finger along the book spines} then {sit:the sofa}, {stand} {look:lamp} {pick:mug} ' +
        '{put:mug@coffee table} {come}',
    );
    expect(tags).toEqual([
      { type: 'go', object: 'bookshelf' },
      { type: 'move', text: 'runs a finger along the book spines' },
      { type: 'sit', object: 'the sofa' },
      { type: 'stand' },
      { type: 'look', object: 'lamp' },
      { type: 'pick', object: 'mug' },
      { type: 'put', object: 'mug', surface: 'coffee table' },
      { type: 'come' },
    ]);
  });

  it('accepts "put X on Y" as well as "put X@Y"', () => {
    expect(extractSceneTags('{put:the mug on the side table}')).toEqual([
      { type: 'put', object: 'the mug', surface: 'the side table' },
    ]);
    expect(extractSceneTags('{put:mug onto shelf} {put:mug on top of the rug}')).toEqual([
      { type: 'put', object: 'mug', surface: 'shelf' },
      { type: 'put', object: 'mug', surface: 'the rug' },
    ]);
  });

  it('is case-insensitive about the tag name and ignores incomplete tags', () => {
    expect(extractSceneTags('{GO:Bookshelf} {sit:} {go} {stand:now} {come:here} {put:mug} {put:@table} {look:  }')).toEqual([
      { type: 'go', object: 'Bookshelf' },
    ]);
  });

  it('only reports scene tags from extractSceneTags', () => {
    expect(extractSceneTags('{move:waves} {wave} {anim:wave} {stand}')).toEqual([{ type: 'stand' }]);
  });

  it('leaves the move tag parser alone', () => {
    expect(extractMoveTags('{go:bookshelf} {move:waves}')).toEqual([{ type: 'move', text: 'waves' }]);
  });

  it('does not treat scene tags as animation slugs', () => {
    const text = '{stand} {come} {go:bookshelf} {sit:sofa} {wave} {anim:stand}';
    expect(extractAvatarTags(text)).toEqual([
      { type: 'anim', slug: 'wave' },
      { type: 'anim', slug: 'stand' },
    ]);
    expect(extractAnimationTags('{stand} {come} {wave}')).toEqual(['wave']);
  });
});
