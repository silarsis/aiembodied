import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Controller, LEASE_REQUEST_WAIT_S } from '../src/aicontroller/client.js';
import { FakeAicontroller } from './helpers/fake-aicontroller.js';

describe('Controller.lease waits longer than one request can', () => {
  let fake: FakeAicontroller;
  beforeEach(async () => {
    // A long ttl so the lease's own heartbeat timer stays out of the way.
    fake = await new FakeAicontroller(60).start();
  });
  afterEach(async () => {
    await fake.stop();
  });

  const controller = (extra: ConstructorParameters<typeof Controller>[0] = {}) =>
    new Controller({ url: fake.url, client: 'test', autostart: false, leasePollMs: 10, ...extra });

  it('asks the controller to hold one request for at most LEASE_REQUEST_WAIT_S, under fetch’s 300 s limit', async () => {
    expect(LEASE_REQUEST_WAIT_S).toBeLessThan(300);
    const lease = await controller().lease('echo-llm', { waitS: 900 });
    expect(fake.leaseRequests[0]?.waitS).toBe(LEASE_REQUEST_WAIT_S);
    await lease.release();
    const short = await controller().lease('echo-llm', { waitS: 30 });
    expect(fake.leaseRequests[1]?.waitS).toBe(30);
    await short.release();
  });

  it('keeps a lease that is still queued and polls it until it is ready', async () => {
    fake.stillQueued.add('echo-llm');
    const pending = controller().lease('echo-llm', { waitS: 30 });
    // The model finishes loading a little later.
    await new Promise((resolve) => setTimeout(resolve, 60));
    const queued = fake.live('echo-llm');
    expect(queued).toHaveLength(1);
    queued[0]!.state = 'ready';
    const lease = await pending;
    expect(lease.state).toBe('ready');
    expect(lease.id).toBe(queued[0]!.id);
    // One lease request: the place in the queue is kept, not asked for again.
    expect(fake.leaseRequests).toHaveLength(1);
    expect(fake.requests.some((request) => request.endsWith('/heartbeat'))).toBe(true);
    await lease.release();
  });

  it('says the lease is still queued (not that the controller is down) when the whole wait runs out, and gives it back', async () => {
    fake.stillQueued.add('echo-llm');
    await expect(controller().lease('echo-llm', { waitS: 0.1 })).rejects.toThrow(
      /still queued after waiting 0\.1s .*loading the model or waiting for memory/,
    );
    expect(fake.live('echo-llm')).toHaveLength(0);
    expect(fake.requests.some((request) => request.startsWith('DELETE /v1/leases/'))).toBe(true);
  });

  it('reports a lease that ended while it waited', async () => {
    fake.stillQueued.add('echo-llm');
    const pending = controller().lease('echo-llm', { waitS: 30 });
    await new Promise((resolve) => setTimeout(resolve, 30));
    fake.live('echo-llm')[0]!.state = 'revoked';
    await expect(pending).rejects.toThrow(/ended while it waited/);
  });

  it('stops polling and gives the lease back when aborted', async () => {
    fake.stillQueued.add('echo-llm');
    const abort = new AbortController();
    const pending = controller().lease('echo-llm', { waitS: 30, signal: abort.signal });
    await new Promise((resolve) => setTimeout(resolve, 30));
    abort.abort();
    await expect(pending).rejects.toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(fake.live('echo-llm')).toHaveLength(0);
  });
});

describe('Controller.request', () => {
  it('says the controller did not answer in time, rather than that it cannot be reached', async () => {
    const hang = ((_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      })) as typeof fetch;
    const c = new Controller({ url: 'http://127.0.0.1:1', autostart: false, fetch: hang });
    await expect(c.request('GET', '/v1/status', { timeoutMs: 20 })).rejects.toThrow(
      /did not answer GET \/v1\/status within 0s/,
    );
  });

  it('still says it cannot connect when the connection fails', async () => {
    const refuse = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const c = new Controller({ url: 'http://127.0.0.1:1', autostart: false, fetch: refuse });
    await expect(c.request('GET', '/v1/status')).rejects.toThrow(
      /cannot connect to the controller/,
    );
  });
});
