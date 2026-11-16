import { describe, expect, it } from 'vitest';
import { normalizeToolList } from '../../src/mcp/clients/mcp-response.js';

describe('normalizeToolList', () => {
  it('keeps annotations.readOnlyHint when the server sends a boolean', () => {
    const [reads, writes] = normalizeToolList([
      { name: 'search', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } },
      { name: 'save', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false } },
    ]);
    expect(reads.readOnlyHint).toBe(true);
    expect(writes.readOnlyHint).toBe(false);
  });

  it('leaves the hint out when the server said nothing usable', () => {
    const tools = normalizeToolList([
      { name: 'plain', inputSchema: { type: 'object' } },
      { name: 'odd', inputSchema: { type: 'object' }, annotations: { readOnlyHint: 'yes' } },
    ]);
    expect(tools.map((tool) => 'readOnlyHint' in tool)).toEqual([false, false]);
  });
});
