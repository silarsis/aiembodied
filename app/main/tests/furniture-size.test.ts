import { describe, expect, it, vi } from 'vitest';
import { estimateFurniture, fallbackEstimate, parseSizeEstimate } from '../src/furniture/furniture-size.js';

describe('fallback sizes', () => {
  it('uses the most specific word first', () => {
    expect(fallbackEstimate('a velvet armchair')).toMatchObject({ category: 'seating', width: 0.85, depth: 0.85, height: 0.95 });
    expect(fallbackEstimate('oak coffee table')).toMatchObject({ category: 'table', width: 1.1, depth: 0.6, height: 0.45 });
    expect(fallbackEstimate('a tall bookshelf')).toMatchObject({ category: 'storage', height: 1.8 });
    expect(fallbackEstimate('an arc floor lamp')).toMatchObject({ category: 'lighting', height: 1.6 });
    expect(fallbackEstimate('a brass table lamp')).toMatchObject({ height: 0.5 });
  });

  it('matches whole words and plurals only', () => {
    expect(fallbackEstimate('two sofas').category).toBe('seating');
    expect(fallbackEstimate('a bedazzled thing').category).toBe('furniture');
  });

  it('names the piece from the first words and always gives sizes in range', () => {
    const estimate = fallbackEstimate('a very comfortable green velvet sofa with gold feet.');
    expect(estimate.name).toBe('Very comfortable green velvet');
    for (const n of [estimate.width, estimate.depth, estimate.height]) expect(n).toBeGreaterThanOrEqual(0.05);
  });
});

describe('parsing the helper answer', () => {
  const reply = '{"name":"Leather Club Armchair","category":"Seating","width_m":0.9,"depth_m":"0.85","height_m":0.8}';

  it('reads fenced or chatty JSON', () => {
    expect(parseSizeEstimate(`Sure!\n\`\`\`json\n${reply}\n\`\`\``, 'armchair')).toEqual({
      name: 'Leather Club Armchair',
      category: 'seating',
      width: 0.9,
      depth: 0.85,
      height: 0.8,
    });
  });

  it('rejects the whole size when one dimension is out of range', () => {
    expect(parseSizeEstimate(reply.replace('0.8}', '9}'), 'armchair')).toBeNull();
    expect(parseSizeEstimate(reply.replace('"width_m":0.9', '"width_m":0.01'), 'armchair')).toBeNull();
    expect(parseSizeEstimate(reply.replace('"depth_m":"0.85"', '"depth_m":null'), 'armchair')).toBeNull();
    expect(parseSizeEstimate('not json', 'armchair')).toBeNull();
  });

  it('falls back on a missing name or category alone and trims long names to four words', () => {
    const parsed = parseSizeEstimate('{"name":"","category":"!!","width_m":1,"depth_m":1,"height_m":1}', 'a stool');
    expect(parsed).toMatchObject({ name: 'Stool', category: 'seating' });
    expect(parseSizeEstimate('{"name":"one two three four five six","width_m":1,"depth_m":1,"height_m":1}', 'x')?.name).toBe('one two three four');
  });
});

describe('estimateFurniture', () => {
  it('uses the helper when it answers well', async () => {
    const ask = vi.fn().mockResolvedValue('{"name":"Stool","category":"seating","width_m":0.3,"depth_m":0.3,"height_m":0.6}');
    expect(await estimateFurniture('a stool', ask)).toMatchObject({ width: 0.3, height: 0.6 });
    expect(ask).toHaveBeenCalledOnce();
  });

  it('falls back with no helper, a null answer, a bad answer or an error', async () => {
    const expected = fallbackEstimate('a sofa');
    expect(await estimateFurniture('a sofa', undefined)).toEqual(expected);
    expect(await estimateFurniture('a sofa', async () => null)).toEqual(expected);
    expect(await estimateFurniture('a sofa', async () => 'nonsense')).toEqual(expected);
    expect(await estimateFurniture('a sofa', async () => { throw new Error('down'); })).toEqual(expected);
  });

  it('lets a cancel through', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(estimateFurniture('a sofa', async () => { throw new Error('aborted'); }, controller.signal)).rejects.toThrow('aborted');
  });
});

describe('standing desks and clause names', () => {
  it('sizes a standing desk taller than a desk and names it from the first clause', () => {
    const estimate = fallbackEstimate('A standing desk, with monitor and keyboard, in black wood');
    expect(estimate.name).toBe('Standing desk');
    expect(estimate.height).toBeGreaterThan(1);
  });
});
