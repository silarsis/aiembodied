// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const html = readFileSync(fileURLToPath(new URL('../../index.html', import.meta.url)), 'utf8');

describe('renderer Content-Security-Policy', () => {
  it('lets WebAssembly compile, which the room navmesh and physics need', () => {
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const scriptSrc = policy.split(';').map((part) => part.trim()).find((part) => part.startsWith('script-src')) ?? '';
    expect(scriptSrc).toContain("'wasm-unsafe-eval'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });
});
