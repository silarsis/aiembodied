import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SwitchboardClient, makeEventId } from '../src/switchboard/client.js';
import type { SwitchboardEventInput } from '../src/switchboard/types.js';

const input = (n: number): SwitchboardEventInput => ({ type: 'test.event', producer: { kind: 'service', id: 'app' }, payload: { n } });
const ok = () => new Response('{"ids":[]}', { status: 200 });

function sentNumbers(fetchFn: ReturnType<typeof vi.fn>): number[] {
  return fetchFn.mock.calls.flatMap(([, init]) => (JSON.parse(String((init as RequestInit).body)).events as Array<{ payload: { n: number } }>).map((e) => e.payload.n));
}

describe('SwitchboardClient', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('makes 26 character Crockford ids that sort by time', () => {
    const a = makeEventId(1_000_000);
    const b = makeEventId(2_000_000);
    expect(a).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
  });

  it('sets id and time, returns at once, and sends events in one batch', async () => {
    const fetchFn = vi.fn(async () => ok());
    const client = new SwitchboardClient({ baseUrl: 'http://sb/', fetchFn: fetchFn as unknown as typeof fetch });
    const event = client.publish(input(1));
    client.publish(input(2));
    expect(event?.id).toHaveLength(26);
    expect(event?.at).toMatch(/Z$/);
    expect(fetchFn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(String(fetchFn.mock.calls[0][0])).toBe('http://sb/v1/events');
    expect(sentNumbers(fetchFn)).toEqual([1, 2]);
    expect(client.pending()).toBe(0);
  });

  it('keeps order across a failure, retries with backoff, and logs once per outage', async () => {
    let up = false;
    const fetchFn = vi.fn(async () => (up ? ok() : Promise.reject(new Error('refused'))));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const client = new SwitchboardClient({ baseUrl: 'http://sb', fetchFn: fetchFn as unknown as typeof fetch, logger });
    client.publish(input(1));
    await vi.advanceTimersByTimeAsync(250);
    client.publish(input(2));
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(2100);
    expect(client.isDown()).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(client.pending()).toBe(2);
    up = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.pending()).toBe(0);
    const last = JSON.parse(String((fetchFn.mock.calls.at(-1)![1] as RequestInit).body)).events.map((e: { payload: { n: number } }) => e.payload.n);
    expect(last).toEqual([1, 2]);
    expect(logger.info).toHaveBeenCalledTimes(1);
  });

  it('drops the oldest events past maxQueue', async () => {
    const fetchFn = vi.fn(async () => Promise.reject(new Error('down')));
    const client = new SwitchboardClient({ baseUrl: 'http://sb', fetchFn: fetchFn as unknown as typeof fetch, maxQueue: 3 });
    for (let n = 1; n <= 5; n += 1) client.publish(input(n));
    expect(client.pending()).toBe(3);
    fetchFn.mockImplementation(async () => ok());
    await vi.advanceTimersByTimeAsync(200);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sentNumbers(fetchFn)).toEqual([3, 4, 5]);
  });

  it('never throws, even with a broken fetch or odd input', async () => {
    const client = new SwitchboardClient({
      baseUrl: 'http://sb',
      fetchFn: (() => {
        throw new Error('sync boom');
      }) as unknown as typeof fetch,
    });
    expect(() => client.publish(input(1))).not.toThrow();
    expect(() => client.publish(undefined as unknown as SwitchboardEventInput)).not.toThrow();
    await vi.advanceTimersByTimeAsync(300);
    await expect(client.stop()).resolves.toBeUndefined();
    expect(client.publish(input(2))).toBeNull();
  });

  it('drops a batch the server refuses with a 4xx instead of retrying forever', async () => {
    const fetchFn = vi.fn(async () => new Response('bad', { status: 422 }));
    const client = new SwitchboardClient({ baseUrl: 'http://sb', fetchFn: fetchFn as unknown as typeof fetch, logger: { info: vi.fn(), warn: vi.fn() } });
    client.publish(input(1));
    await vi.advanceTimersByTimeAsync(300);
    expect(client.pending()).toBe(0);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('stop() flushes what is queued', async () => {
    const fetchFn = vi.fn(async () => ok());
    const client = new SwitchboardClient({ baseUrl: 'http://sb', fetchFn: fetchFn as unknown as typeof fetch });
    client.publish(input(1));
    await client.stop();
    expect(sentNumbers(fetchFn)).toEqual([1]);
  });
});
