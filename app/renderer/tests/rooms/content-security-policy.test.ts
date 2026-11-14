// @vitest-environment node
import { existsSync, readFileSync, statSync } from 'node:fs';
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

  it('needs nothing new for camera presence: the model and the WASM come from the app itself, never a CDN', () => {
    const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1] ?? '';
    const directive = (name: string) => policy.split(';').map((part) => part.trim()).find((part) => part.startsWith(name)) ?? '';
    // The tasks-vision loader script is a script from 'self'; its WASM compiles under 'wasm-unsafe-eval'.
    expect(directive('script-src')).toBe("script-src 'self' 'wasm-unsafe-eval'");
    expect(directive('connect-src')).not.toMatch(/jsdelivr|googleapis|unpkg|cdn/);
    expect(directive('default-src')).toBe("default-src 'self'");
  });

  it('ships the face model and has the tasks-vision WASM files to copy', () => {
    const model = fileURLToPath(new URL('../../public/models/blaze_face_short_range.tflite', import.meta.url));
    expect(existsSync(model)).toBe(true);
    expect(statSync(model).size).toBeGreaterThan(100_000);
    const wasm = fileURLToPath(new URL('../../node_modules/@mediapipe/tasks-vision/wasm/vision_wasm_internal.wasm', import.meta.url));
    expect(existsSync(wasm)).toBe(true);
  });
});
