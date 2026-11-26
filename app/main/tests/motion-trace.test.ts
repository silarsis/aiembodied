import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MotionTraceSink, motionTraceEnvEnabled } from '../src/logging/motion-trace.js';
import { LocalMotionClient } from '../src/avatar/motion/local-motion-client.js';

describe('MotionTraceSink', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'motion-trace-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const read = (name: string) =>
    fs
      .readFileSync(path.join(dir, name), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, unknown>);

  it('writes nothing while disabled', async () => {
    const sink = new MotionTraceSink({ directory: dir, env: {} });
    sink.append([{ avatar: 'echo', kind: 'plan' }]);
    const build = vi.fn(() => ({}));
    sink.log('main', 'service.request', build);
    await sink.flush();
    expect(build).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, 'motion-trace.jsonl'))).toBe(false);
  });

  it('appends JSON lines once enabled by the setting', async () => {
    const sink = new MotionTraceSink({
      directory: dir,
      env: {},
      now: () => new Date('2026-01-02T03:04:05.000Z'),
      clock: () => 12.3456,
    });
    expect(sink.configure(true)).toBe(true);
    sink.append([{ ts: 'x', t: 5, avatar: 'echo', kind: 'plan', label: 'sit' }, 'junk']);
    sink.log('main', 'service.response', () => ({ status: 200 }));
    await sink.flush();
    sink.append([{ avatar: 'echo', kind: 'contact' }]);
    await sink.flush();
    const lines = read('motion-trace.jsonl');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatchObject({ ts: 'x', t: 5, avatar: 'echo', kind: 'plan', label: 'sit' });
    expect(lines[1]).toMatchObject({
      ts: '2026-01-02T03:04:05.000Z',
      t: 12.35,
      avatar: 'main',
      kind: 'service.response',
      status: 200,
    });
    expect(lines[2]).toMatchObject({ kind: 'contact', t: 12.35 });
  });

  it('is enabled by AIEMBODIED_MOTION_TRACE=1 without the setting', async () => {
    expect(motionTraceEnvEnabled({ AIEMBODIED_MOTION_TRACE: '1' })).toBe(true);
    expect(motionTraceEnvEnabled({})).toBe(false);
    const sink = new MotionTraceSink({ directory: dir, env: { AIEMBODIED_MOTION_TRACE: '1' } });
    expect(sink.configure(false)).toBe(true);
    sink.append([{ avatar: 'echo', kind: 'plan' }]);
    await sink.flush();
    expect(read('motion-trace.jsonl')).toHaveLength(1);
  });

  it('rotates to motion-trace.1.jsonl past the size limit and keeps one old file', async () => {
    const sink = new MotionTraceSink({ directory: dir, env: {}, maxBytes: 300 });
    sink.configure(true);
    const big = { avatar: 'echo', kind: 'fill', pad: 'x'.repeat(400) };
    sink.append([big]);
    await sink.flush();
    sink.append([{ avatar: 'echo', kind: 'second' }]);
    await sink.flush();
    expect(read('motion-trace.1.jsonl')[0]).toMatchObject({ kind: 'fill' });
    expect(read('motion-trace.jsonl')).toEqual([expect.objectContaining({ kind: 'second' })]);
    sink.append([big]);
    await sink.flush();
    sink.append([{ avatar: 'echo', kind: 'third' }]);
    await sink.flush();
    expect(read('motion-trace.1.jsonl')[0]).toMatchObject({ kind: 'second' });
    expect(read('motion-trace.jsonl')).toEqual([expect.objectContaining({ kind: 'third' })]);
    expect(fs.readdirSync(dir).sort()).toEqual(['motion-trace.1.jsonl', 'motion-trace.jsonl']);
  });
});

describe('LocalMotionClient tracing', () => {
  it('traces the request body and the response status, and builds nothing without a trace', async () => {
    const fetchFn = vi.fn(
      async () => new Response(JSON.stringify({ error: 'nope' }), { status: 500 }),
    ) as unknown as typeof fetch;
    const seen: Array<[string, Record<string, unknown>]> = [];
    const client = new LocalMotionClient({
      baseUrl: 'http://x',
      fetchFn,
      trace: (kind, build) => seen.push([kind, build()]),
    });
    await expect(client.generateClip({ prompt: 'sit', continueFrom: 's1' })).rejects.toThrow(
      /HTTP 500/,
    );
    expect(seen.map(([kind]) => kind)).toEqual(['service.request', 'service.response']);
    expect(seen[0]![1]).toMatchObject({
      path: '/v1/motion/clip',
      body: { prompt: 'sit', continue_from: 's1' },
    });
    expect(seen[1]![1]).toMatchObject({ status: 500, ok: false });
    const quiet = new LocalMotionClient({ baseUrl: 'http://x', fetchFn });
    await expect(quiet.generateClip({ prompt: 'sit' })).rejects.toThrow();
  });
});
