import { describe, expect, it } from 'vitest';
import { formatBrief, formatRecalled } from '../src/memory-engine/voice-memory.js';
import type { MemoryEngineBrief } from '../src/memory-engine/client.js';
import type { MemoryEngineSearchResult } from '../src/shared/memory-engine/client-types.js';

describe('recalled memories without body tags', () => {
  const now = new Date('2026-11-17T11:00:00Z');

  it('strips {move:}/{pick:} tags from recalled lines so old replies are not copied as moves', () => {
    const item = {
      id: 'm1',
      kind: 'exchange',
      text: 'Kevin: Go, sit down.\nEcho: Here, have a little something. {pick: mug}{move:sits on a space on the couch with both hands on the mug}',
      period_start: '2026-11-16T10:04:00Z',
    } as unknown as MemoryEngineSearchResult;
    const block = formatRecalled([item], now);
    expect(block).toContain('Here, have a little something.');
    expect(block).not.toContain('{');
    expect(block).not.toContain('sits on a space');
  });

  it('strips them from the last conversation in the brief too', () => {
    const brief = {
      facts: [],
      recent_days: [],
      last_session: {
        last_at: '2026-11-16T10:05:00Z',
        agent: 'echo',
        summary: null,
        turns: ['Echo: Sure. {sit:onu}'],
      },
    } as unknown as MemoryEngineBrief;
    const text = formatBrief(brief, now);
    expect(text).toContain('- Echo: Sure.');
    expect(text).not.toContain('{sit');
  });
});
