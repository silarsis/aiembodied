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
  host?: string;
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
/** A peer machine the fake routes leases to (the controller's `routes`). */
export interface FakePeer {
  /** Basenames of the model files it has. */
  files: Set<string>;
  online: boolean;
  url: string;
}

/** A model file on a machine, as GET /v1/models?scope=all lists it. */
export interface FakeHostModel {
  host: string;
  state: string;
  kind: string;
  subfolder: string | null;
  file_name: string;
}

export class FakeAicontroller {
  /** Peers a lease with `needs` goes to when they are online and have every file, in order; else it stays here. */
  readonly peers = new Map<string, FakePeer>();
  /** Extra models GET /v1/models?scope=all lists (other machines', and this one's). */
  readonly hostModels: FakeHostModel[] = [];
  /** Every POST /v1/models/download body. */
  readonly downloadRequests: Record<string, unknown>[] = [];
  /** Download jobs, by id; tests change `bytes_done`/`state` to show progress. */
  readonly downloads = new Map<string, Record<string, unknown>>();
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
  readonly leaseRequests: { backend: string; client: string; model: string | null; needs: string[]; host: string | null; waitS?: number }[] = [];
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
      return send(200, { name: 'fake', peers: [...this.peers.keys()].map((name) => ({ name })), backends: ids.map((id) => ({ id, state: 'ready' })) });
    }
    if (method === 'POST' && path === '/v1/models/download') {
      const body = JSON.parse(text) as Record<string, unknown>;
      this.downloadRequests.push(body);
      const host = body.host === 'auto' ? 'acrasia' : (body.host as string | null) ?? 'fake';
      const id = `${host}:D${this.downloadRequests.length}`;
      const job = { id, state: 'downloading', bytes_done: 0, bytes_total: 1000, error: null, model_id: null, kind: body.kind ?? null, file_name: 'model.gguf', host };
      this.downloads.set(id, job);
      return send(202, job);
    }
    const download = /^\/v1\/downloads\/([^/]+)$/.exec(path);
    if (download) {
      const job = this.downloads.get(decodeURIComponent(download[1]));
      if (!job) return send(404, { error: 'unknown download' });
      if (method === 'DELETE') job.state = 'cancelled';
      return send(200, job);
    }
    if (method === 'GET' && path.startsWith('/v1/models')) {
      const all = new URL(path, 'http://x').searchParams.get('scope') === 'all';
      return send(200, { models: all ? [...this.models, ...this.hostModels] : this.models });
    }
    if (method === 'POST' && path === '/v1/leases') {
      const body = JSON.parse(text) as { backend: string; client: string; model?: string | null; needs?: string[]; host?: string | null; wait_s?: number };
      const needs = body.needs ?? [];
      this.leaseRequests.push({ backend: body.backend, client: body.client, model: body.model ?? null, needs, host: body.host ?? null, waitS: body.wait_s });
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
      const peer = needs.length && !body.host
        ? [...this.peers].find(([, entry]) => entry.online && needs.every((file) => entry.files.has(file.split(/[\\/]/).pop() ?? file)))
        : undefined;
      if (peer) Object.assign(lease, { id: `${peer[0]}:${lease.id}`, url: peer[1].url, host: peer[0] });
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
    const match = /^\/v1\/leases\/([^/]+)(\/heartbeat)?$/.exec(path.replace(/%3A/gi, ':'));
    const lease = match ? this.leases.get(match[1]) : undefined;
    if (!match || !lease) return send(404, { error: 'unknown lease' });
    if (method === 'DELETE') {
      if (lease.state === 'ready' || lease.state === 'queued') lease.state = 'released';
      return send(200, lease);
    }
    // Like the real controller, a heartbeat keeps a queued lease too, and answers with its state.
    if (match[2]) return lease.state === 'ready' || lease.state === 'queued' ? send(200, lease) : send(410, { error: lease.error ?? 'lease is over' });
    return send(200, lease);
  }
}
