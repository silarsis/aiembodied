import { describe, it, expect } from 'vitest';
import { chooseToolName, isValidToolName, sanitizeToolName, serverSlug } from '../../src/mcp/tool-names.js';

describe('tool names', () => {
  it('sanitises invalid characters', () => {
    expect(sanitizeToolName('a.b c/d')).toBe('a_b_c_d');
    expect(sanitizeToolName('')).toBe('tool');
    expect(isValidToolName(sanitizeToolName('héllo wörld'))).toBe(true);
  });

  it('makes a slug from the server name', () => {
    expect(serverSlug('DAIR Academy papers')).toBe('dair_academy_papers');
    expect(serverSlug('!!!')).toBe('server');
  });

  it('keeps a free name, prefixes a taken one, and numbers as a last resort', () => {
    expect(chooseToolName('search', 'DAIR', new Set())).toBe('search');
    expect(chooseToolName('search', 'DAIR', new Set(['search']))).toBe('dair__search');
    expect(chooseToolName('search', 'DAIR', new Set(['search', 'dair__search']))).toBe('dair__search_2');
  });

  it('never goes over 64 characters', () => {
    const long = 'a'.repeat(100);
    const name = chooseToolName(long, 'Some Server', new Set(['a'.repeat(64)]));
    expect(name.length).toBeLessThanOrEqual(64);
    expect(isValidToolName(name)).toBe(true);
    const numbered = chooseToolName(long, 'Some Server', new Set(['a'.repeat(64), name]));
    expect(numbered.length).toBeLessThanOrEqual(64);
    expect(numbered).not.toBe(name);
  });
});
