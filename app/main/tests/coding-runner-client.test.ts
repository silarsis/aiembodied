import { describe, expect, it, vi } from 'vitest';
import { CodingRunnerClient, RunnerError, parseEventBlock, type RunnerEvent } from '../src/coding/runner-client.js';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchFn: unknown) {
  return new CodingRunnerClient({ baseUrl: 'http://127.0.0.1:8195/', fetchFn: fetchFn as typeof fetch });
}

describe('CodingRunnerClient requests', () => {
  it('calls each endpoint with the right method, path and body', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined]);
      return String(url).endsWith('/v1/keys') && init?.method === 'PUT' ? new Response(null, { status: 204 }) : json({ ok: true });
    });
    const runner = client(fetchFn);
    await runner.health();
    await runner.getSettings();
    await runner.putSettings({ local_model: 'm' });
    await runner.getWorkspaces();
    await runner.putWorkspaces([{ id: 'a' }]);
    await runner.getKeys();
    await runner.putKeys({ openai: 'sk', github: null });
    await runner.status();
    await runner.setLocalHold(true, 'Kevin is talking to Echo');
    await runner.capabilities(true);
    await runner.listTasks('review');
    await runner.getTask('20261108-1a2b');
    await runner.createTask({ workspace_id: 'a', goal: 'g' });
    expect(calls).toEqual([
      ['http://127.0.0.1:8195/v1/health', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/settings', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/settings', 'PUT', { local_model: 'm' }],
      ['http://127.0.0.1:8195/v1/workspaces', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/workspaces', 'PUT', [{ id: 'a' }]],
      ['http://127.0.0.1:8195/v1/keys', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/keys', 'PUT', { openai: 'sk', github: null }],
      ['http://127.0.0.1:8195/v1/status', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/local/hold', 'PUT', { hold: true, reason: 'Kevin is talking to Echo' }],
      ['http://127.0.0.1:8195/v1/capabilities?refresh=1', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/tasks?status=review', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/tasks/20261108-1a2b', 'GET', undefined],
      ['http://127.0.0.1:8195/v1/tasks', 'POST', { workspace_id: 'a', goal: 'g' }],
    ]);
  });

  it('reports the runner’s reason, and an unreachable runner, without echoing keys', async () => {
    await expect(client(async () => json({ detail: '"C:\\x" is not a git repository' }, 400)).putWorkspaces([])).rejects.toMatchObject({
      name: 'RunnerError',
      status: 400,
      message: '"C:\\x" is not a git repository',
    });
    const down = client(async () => {
      throw new TypeError('fetch failed sk-secret');
    });
    const error = await down.putKeys({ openai: 'sk-secret' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RunnerError);
    expect((error as Error).message).toBe('The coding runner is not answering at http://127.0.0.1:8195.');
    expect((error as Error).message).not.toContain('sk-secret');
  });
});

describe('CodingRunnerClient task controls', () => {
  it('calls the task endpoints, and reads the diff as text', async () => {
    const calls: Array<[string, string, unknown]> = [];
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      calls.push([String(url), init?.method ?? 'GET', init?.body ? JSON.parse(String(init.body)) : undefined]);
      return String(url).endsWith('/diff') ? new Response('diff --git a/x b/x\n', { status: 200, headers: { 'Content-Type': 'text/plain' } }) : json({ id: 't1', status: 'working' });
    });
    const runner = client(fetchFn);
    expect(await runner.taskDiff('t1')).toBe('diff --git a/x b/x\n');
    await runner.steer('t1', 'use the helper');
    await runner.followUp('t1', 'add a test');
    await runner.answer('t1', { value: '8080', dialog_id: 'a1' });
    await runner.cancel('t1');
    await runner.apply('t1');
    await runner.discard('t1');
    const base = 'http://127.0.0.1:8195/v1/tasks/t1';
    expect(calls).toEqual([
      [`${base}/diff`, 'GET', undefined],
      [`${base}/steer`, 'POST', { message: 'use the helper' }],
      [`${base}/follow_up`, 'POST', { message: 'add a test' }],
      [`${base}/answer`, 'POST', { value: '8080', dialog_id: 'a1' }],
      [`${base}/cancel`, 'POST', undefined],
      [`${base}/apply`, 'POST', { draft: false }],
      [`${base}/discard`, 'POST', undefined],
    ]);
  });
});

describe('server-sent events', () => {
  const encoder = new TextEncoder();
  const stream = (chunks: string[], end = true) =>
    new Response(
      new ReadableStream({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          if (end) controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );

  it('parses data blocks and skips comments', () => {
    expect(parseEventBlock(': keepalive')).toBeNull();
    expect(parseEventBlock('data: not json')).toBeNull();
    expect(parseEventBlock('data: {"task_id":"t","local_model_needed":true}')).toEqual({ task_id: 't', local_model_needed: true });
  });

  it('delivers events split across chunks, then reconnects with a growing wait', async () => {
    const events: RunnerEvent[] = [];
    const waits: number[] = [];
    let opened = 0;
    let closed = 0;
    let call = 0;
    let stop: () => void = () => undefined;
    const done = new Promise<void>((resolve) => {
      const fetchFn = vi.fn(async () => {
        call += 1;
        if (call === 1) return stream([': connected\n\ndata: {"task_id":null,"loc', 'al_model_needed":false}\n\n', 'data: {"task_id":"a","status":"working","local_model_needed":true}\r\n\r\n']);
        if (call === 2) throw new TypeError('refused');
        if (call === 3) return new Response('nope', { status: 500 });
        resolve();
        return stream([], false);
      });
      stop = client(fetchFn).subscribe(
        { onEvent: (event) => events.push(event), onOpen: () => (opened += 1), onClose: () => (closed += 1) },
        { sleep: async (ms) => void waits.push(ms) },
      );
    });
    await done;
    stop();
    expect(events.map((event) => [event.task_id, event.local_model_needed])).toEqual([
      [null, false],
      ['a', true],
    ]);
    // Wait 1 s after the first stream ended, then 2 s, then 4 s as it keeps failing.
    expect(waits).toEqual([1000, 2000, 4000]);
    expect(opened).toBe(1);
    expect(closed).toBe(1);
  });

  it('starts the wait over after a connection that worked, and stops when asked', async () => {
    const waits: number[] = [];
    let call = 0;
    let stop: () => void = () => undefined;
    const finished = new Promise<void>((resolve) => {
      const fetchFn = vi.fn(async () => {
        call += 1;
        if (call === 1) throw new TypeError('refused');
        if (call === 2) throw new TypeError('refused');
        if (call === 3) return stream(['data: {"task_id":null}\n\n']);
        stop();
        resolve();
        throw new TypeError('after stop');
      });
      stop = client(fetchFn).subscribe({ onEvent: () => undefined }, { sleep: async (ms) => void waits.push(ms) });
    });
    await finished;
    expect(waits).toEqual([1000, 2000, 1000]);
  });
});
