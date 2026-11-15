import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLease {
  id: string;
  backend: string;
  client: string;
  model: string | null;
  state: 'ready' | 'queued' | 'revoked' | 'released';
  url: string;
  error: string | null;
  ttl_s: number;
}

/** Where the fake controller says each backend's server is. */
export const FAKE_BACKEND_URLS: Record<string, string> = {
  'echo-llm': 'http://127.0.0.1:41234/v1',
  'coder-llm': 'http://127.0.0.1:41236/v1',
  vision: 'http://127.0.0.1:41237/v1',
  motion: 'http://127.0.0.1:48190',
  comfyui: 'http://127.0.0.1:48188',
};

/** A model in the fake controller's catalog (GET /v1/models). */
export interface FakeModel {
  id: string;
  kind: string;
  path: string;
  file_name: string;
  alias: string;
}

/**
 * A tiny stand-in for aicontroller's HTTP API: /health and the lease calls. Records every request
 * and can revoke a lease the way the controller does when it yields the GPU.
 */
export class FakeAicontroller {
  readonly leases = new Map<string, FakeLease>();
  readonly requests: string[] = [];
  /** Backends whose lease request is refused with 503, as while the GPU is yielded. */
  readonly refuse = new Set<string>();
  /** Backends the controller doesn't have: lease requests answer 404 and GET /v1/status leaves them out. */
  readonly unknown = new Set<string>();
  /**
   * Backends whose lease request is held queued (as when the controller lacks memory): the POST stays
   * open, and the lease is cancelled if the client hangs up. `grant(backend)` lets the waiting ones through.
   */
  readonly hold = new Set<string>();
  /** Backends whose lease request answers 200 with state `queued` at once, as when wait_s ran out. */
  readonly stillQueued = new Set<string>();
  private readonly granters: (() => void)[] = [];
  /** Set false to make GET /v1/status fail, as a controller whose backend list can't be read. */
  statusWorks = true;
  /** The models GET /v1/models lists. A lease naming a model not in here answers 404. */
  readonly models: FakeModel[] = [];
  /** Every lease request body, in order. */
  readonly leaseRequests: { backend: string; client: string; model: string | null }[] = [];
  private server: Server | null = null;
  private counter = 0;
  url = '';

  /** Heartbeat TTL handed out in leases (small, so tests see a revoke quickly). */
  constructor(private readonly ttlS = 0.05) {}

  async start(): Promise<this> {
    this.server = createServer((req, res) => void this.handle(req, (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    }));
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server?.address() as AddressInfo).port}`;
    return this;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
  }

  /** Lets the held lease requests (see `hold`) through to ready. */
  grant(): void {
    for (const go of this.granters.splice(0)) go();
  }

  /** Leases on a backend that still exist at the controller: queued or ready. */
  live(backend: string): FakeLease[] {
    return [...this.leases.values()].filter((lease) => lease.backend === backend && (lease.state === 'ready' || lease.state === 'queued'));
  }

  /** Active (not released, not revoked) leases on a backend. */
  active(backend: string): FakeLease[] {
    return [...this.leases.values()].filter((lease) => lease.backend === backend && lease.state === 'ready');
  }

  /** Revoke every active lease: the controller yields the GPU. */
  revokeAll(reason: string): void {
    for (const lease of this.leases.values()) {
      if (lease.state === 'ready') Object.assign(lease, { state: 'revoked', error: reason });
    }
  }

  private async handle(req: IncomingMessage, send: (status: number, body: unknown) => void): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const method = req.method ?? 'GET';
    const path = req.url ?? '/';
    this.requests.push(`${method} ${path}`);
    if (path === '/health') return send(200, { ok: true, name: 'fake' });
    if (method === 'GET' && path === '/v1/status') {
      if (!this.statusWorks) return send(500, { error: 'status unavailable' });
      const ids = Object.keys(FAKE_BACKEND_URLS).filter((id) => !this.unknown.has(id));
      return send(200, { name: 'fake', backends: ids.map((id) => ({ id, state: 'ready' })) });
    }
    if (method === 'GET' && path.startsWith('/v1/models')) return send(200, { models: this.models });
    if (method === 'POST' && path === '/v1/leases') {
      const body = JSON.parse(text) as { backend: string; client: string; model?: string | null };
      this.leaseRequests.push({ backend: body.backend, client: body.client, model: body.model ?? null });
      if (this.unknown.has(body.backend)) return send(404, { error: `unknown backend '${body.backend}'` });
      if (body.model && !this.models.some((entry) => entry.id === body.model || entry.alias === body.model)) return send(404, { error: `unknown model '${body.model}'` });
      if (this.refuse.has(body.backend)) return send(503, { error: 'GPU needed by game.exe' });
      const lease: FakeLease = {
        id: `L${++this.counter}`,
        backend: body.backend,
        client: body.client,
        model: body.model ?? null,
        state: 'ready',
        url: FAKE_BACKEND_URLS[body.backend] ?? 'http://127.0.0.1:1/v1',
        error: null,
        ttl_s: this.ttlS,
      };
      this.leases.set(lease.id, lease);
      if (this.stillQueued.has(body.backend)) {
        lease.state = 'queued';
        return send(200, lease);
      }
      if (this.hold.has(body.backend)) {
        lease.state = 'queued';
        await new Promise<void>((resolve) => {
          const done = () => resolve();
          this.granters.push(done);
          req.socket.once('close', () => {
            if (lease.state === 'queued') lease.state = 'released'; // the waiter hung up: the controller drops it
            resolve();
          });
        });
        if (lease.state !== 'queued') return;
        lease.state = 'ready';
      }
      return send(200, lease);
    }
    const match = /^\/v1\/leases\/([^/]+)(\/heartbeat)?$/.exec(path);
    const lease = match ? this.leases.get(match[1]) : undefined;
    if (!match || !lease) return send(404, { error: 'unknown lease' });
    if (method === 'DELETE') {
      if (lease.state === 'ready' || lease.state === 'queued') lease.state = 'released';
      return send(200, lease);
    }
    if (match[2]) return lease.state === 'ready' ? send(200, lease) : send(410, { error: lease.error ?? 'lease is over' });
    return send(200, lease);
  }
}
