import { describe, expect, it } from 'vitest';
import { appearanceWords, buildObjectImagePrompt, colourWordForHex, OBJECT_IMAGE_NEGATIVE } from '../src/rooms/asset-library/generated-prompt.js';

const chair = { name: 'Rocking chair', search: 'rocking chair wooden', category: 'seat' as const, color: 'walnut' };

describe('buildObjectImagePrompt', () => {
  it('asks for one isolated object on white, seen from the front', () => {
    expect(buildObjectImagePrompt(chair)).toBe(
      'a single rocking chair, walnut, wooden, product photo, isolated on plain white background, full object in frame, straight-on front view, no people, no text',
    );
  });

  it('adds search words the name lacks, but not colours or materials twice', () => {
    const prompt = buildObjectImagePrompt({ name: 'armchair', search: 'mid century lounge armchair leather', category: 'seat', color: '#7a5233' });
    expect(prompt.startsWith('a single armchair, mid century lounge, ')).toBe(true);
    expect(prompt).toContain('brown, leather,');
    expect(prompt.match(/leather/g)).toHaveLength(1);
  });

  it('works without a colour', () => {
    expect(buildObjectImagePrompt({ name: 'Floor lamp', search: 'floor lamp', category: 'lamp', color: null })).toBe(
      'a single floor lamp, product photo, isolated on plain white background, full object in frame, straight-on front view, no people, no text',
    );
  });

  it('has a negative prompt that rules out clutter', () => {
    expect(OBJECT_IMAGE_NEGATIVE).toContain('multiple objects');
  });
});

describe('colour words', () => {
  it('names hex colours', () => {
    expect(colourWordForHex('#ffffff')).toBe('white');
    expect(colourWordForHex('#222222')).toBe('black');
    expect(colourWordForHex('#3c6cb0')).toBe('blue');
    expect(colourWordForHex('#a8372f')).toBe('red');
    expect(colourWordForHex('#4f8a52')).toBe('green');
    expect(colourWordForHex('nonsense')).toBeNull();
  });

  it('collects colour and material words, at most four', () => {
    expect(appearanceWords({ name: 'sofa', search: 'blue velvet sofa metal legs', color: 'grey' })).toEqual(['grey', 'blue', 'velvet', 'metal']);
  });
});
