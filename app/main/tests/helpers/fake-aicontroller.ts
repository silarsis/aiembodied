import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeLease {
  id: string;
  backend: string;
  client: string;
  state: 'ready' | 'revoked' | 'released';
  url: string;
  error: string | null;
  ttl_s: number;
}

/** Where the fake controller says each backend's server is. */
export const FAKE_BACKEND_URLS: Record<string, string> = {
  'echo-llm': 'http://127.0.0.1:41234/v1',
  'coder-llm': 'http://127.0.0.1:41236/v1',
};

/**
 * A tiny stand-in for aicontroller's HTTP API: /health and the lease calls. Records every request
 * and can revoke a lease the way the controller does when it yields the GPU.
 */
export class FakeAicontroller {
  readonly leases = new Map<string, FakeLease>();
  readonly requests: string[] = [];
  /** Backends whose lease request is refused with 503, as while the GPU is yielded. */
  readonly refuse = new Set<string>();
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
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server = null;
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
    if (method === 'POST' && path === '/v1/leases') {
      const body = JSON.parse(text) as { backend: string; client: string };
      if (this.refuse.has(body.backend)) return send(503, { error: 'GPU needed by game.exe' });
      const lease: FakeLease = {
        id: `L${++this.counter}`,
        backend: body.backend,
        client: body.client,
        state: 'ready',
        url: FAKE_BACKEND_URLS[body.backend] ?? 'http://127.0.0.1:1/v1',
        error: null,
        ttl_s: this.ttlS,
      };
      this.leases.set(lease.id, lease);
      return send(200, lease);
    }
    const match = /^\/v1\/leases\/([^/]+)(\/heartbeat)?$/.exec(path);
    const lease = match ? this.leases.get(match[1]) : undefined;
    if (!match || !lease) return send(404, { error: 'unknown lease' });
    if (method === 'DELETE') {
      if (lease.state === 'ready') lease.state = 'released';
      return send(200, lease);
    }
    if (match[2]) return lease.state === 'ready' ? send(200, lease) : send(410, { error: lease.error ?? 'lease is over' });
    return send(200, lease);
  }
}
