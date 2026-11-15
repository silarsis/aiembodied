/**
 * Vendored from silarsis/aicontroller, clients/typescript/src/index.ts (commit 00bc054).
 * Kept as upstream wrote it apart from lint fixes (Record<string, any> became Record<string, unknown>; a non-null assertion removed);
 * resync from there rather than editing it. The client has no runtime dependencies.
 */
import { claimLaunchLock, DEFAULT_URL, findHome, isLoopback, launchDetached, startService } from "./launcher.js";
import type { Launcher, ServiceStarter } from "./launcher.js";

export { launchDetached, startService } from "./launcher.js";
export type { Launcher, ServiceStarter } from "./launcher.js";

// Symbol.asyncDispose is missing before Node 20.
(Symbol as { asyncDispose?: symbol }).asyncDispose ??= Symbol.for("Symbol.asyncDispose");

export class ControllerError extends Error {
  constructor(message: string, public status?: number) {
    super(message);
    this.name = "ControllerError";
  }
}
/** The controller took the lease back (for example the GPU is needed by a game). */
export class LeaseRevoked extends ControllerError {
  constructor(message: string, status = 410) {
    super(message, status);
    this.name = "LeaseRevoked";
  }
}
/** The controller cannot be reached or started and no fallback was given. */
export class ControllerUnavailable extends ControllerError {
  constructor(message: string) {
    super(message);
    this.name = "ControllerUnavailable";
  }
}

export interface LeaseData {
  id: string;
  backend: string;
  client?: string;
  model?: string | null;
  state: string;
  url: string | null;
  ttl_s?: number;
  error?: string | null;
  host?: string | null;
  [k: string]: unknown;
}

export interface LeaseOptions {
  model?: string;
  host?: string;
  /** Seconds to wait for the lease to become ready (default 900). */
  waitS?: number;
  /** Lease time-to-live in seconds (default 120); heartbeats every ttlS/3. */
  ttlS?: number;
  allowAskFirst?: boolean;
  /** Aborting releases the lease (and cancels a pending request). */
  signal?: AbortSignal;
}

export interface ModelsOptions {
  kind?: string;
  scope?: "all" | "local";
}

export interface DownloadSource {
  type: "huggingface" | "civitai" | "url";
  repo?: string;
  file?: string;
  revision?: string;
  url?: string;
  version_id?: number | string;
}
export interface DownloadOptions {
  kind?: string;
  subfolder?: string;
  fileName?: string;
  sha256?: string;
  host?: string;
}

export interface ControllerOptions {
  /** Default: AICONTROLLER_URL, else http://127.0.0.1:8200. */
  url?: string;
  /** Name sent as the lease `client`. */
  client?: string;
  /** Default: AICONTROLLER_TOKEN. */
  token?: string;
  /** Request timeout in ms (default 30000). */
  timeoutMs?: number;
  /** Default on; AICONTROLLER_AUTOSTART=0 turns it off. Only loopback URLs are ever started. */
  autostart?: boolean;
  /** Controller checkout, used when AICONTROLLER_HOME is unset. */
  home?: string;
  /** Config file for the launched controller (default AICONTROLLER_CONFIG or <home>/config.yaml). */
  config?: string;
  /** Seconds to wait for a started controller (default 20). */
  startTimeoutS?: number;
  /** Minimum seconds between availability re-checks while unavailable (default 60). */
  recheckS?: number;
  /** Direct mode: returns the URL the app would use without the controller. */
  fallback?: (backend: string, model?: string) => string | undefined | Promise<string | undefined>;
  /** Injectable for tests. */
  serviceStarter?: ServiceStarter;
  launcher?: Launcher;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A held lease (or a direct-mode stand-in with `direct = true`). */
export class Lease {
  data: LeaseData;
  /** Set when the controller revoked the lease; `check()` throws it. */
  revoked?: LeaseRevoked;
  lost = false;
  private timer?: ReturnType<typeof setInterval>;
  private released = false;
  private onAbort?: () => void;

  constructor(private ctl: Controller | undefined, data: LeaseData, readonly direct = false, private signal?: AbortSignal) {
    this.data = data;
    if (ctl && !direct) {
      const ms = Math.max(((data.ttl_s ?? 120) * 1000) / 3, 20);
      this.timer = setInterval(() => void this.beat(), ms);
      this.timer.unref?.();
      if (signal) {
        this.onAbort = () => void this.release();
        if (signal.aborted) this.onAbort();
        else signal.addEventListener("abort", this.onAbort, { once: true });
      }
    }
  }

  get id(): string { return this.data.id; }
  get url(): string | null { return this.data.url; }
  get backend(): string { return this.data.backend; }
  get model(): string | null | undefined { return this.data.model; }
  get state(): string { return this.data.state; }

  private async beat(): Promise<void> {
    if (this.released || !this.ctl) return;
    try {
      this.data = await this.ctl.request<LeaseData>("POST", `/v1/leases/${this.id}/heartbeat`);
      if (this.data.state === "revoked") await this.noteEnd();
    } catch (e) {
      if (e instanceof ControllerError && (e.status === 404 || e.status === 410)) {
        this.lost = true;
        await this.noteEnd();
      } // anything else is transient: the lease survives until its ttl
    }
  }

  private async noteEnd(): Promise<void> {
    this.stopTimer();
    try {
      if (this.ctl) this.data = await this.ctl.request<LeaseData>("GET", `/v1/leases/${this.id}`);
    } catch { /* keep what we have */ }
    if (this.data.state === "revoked") {
      this.revoked = new LeaseRevoked(`lease on '${this.data.backend}' was revoked: ${this.data.error}`);
    }
  }

  /** Throws LeaseRevoked if the controller took the lease back (call between work steps). */
  check(): void {
    if (this.revoked) throw this.revoked;
  }

  /** Stop heartbeating and release (safe to call twice). */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    this.stopTimer();
    if (this.onAbort) this.signal?.removeEventListener("abort", this.onAbort);
    if (!this.ctl || this.direct) return;
    try {
      await this.ctl.request("DELETE", `/v1/leases/${this.id}`);
    } catch { /* idempotent; the ttl cleans up */ }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.release();
  }
}

export class Controller {
  readonly url: string;
  /** null until the first check; false means direct mode. */
  available: boolean | null = null;
  private readonly o: ControllerOptions;
  private readonly token?: string;
  private readonly fetchFn: typeof fetch;
  private checkedAt = 0;
  private warned = false;
  private ensuring?: Promise<boolean>;

  constructor(options: ControllerOptions = {}) {
    this.o = options;
    this.url = (options.url ?? process.env.AICONTROLLER_URL ?? DEFAULT_URL).replace(/\/+$/, "");
    this.token = options.token ?? process.env.AICONTROLLER_TOKEN;
    this.fetchFn = options.fetch ?? globalThis.fetch;
  }

  private get autostart(): boolean {
    if (this.o.autostart !== undefined) return this.o.autostart;
    return !["0", "false", "no", "off"].includes((process.env.AICONTROLLER_AUTOSTART ?? "1").trim().toLowerCase());
  }

  /** Low-level JSON request; throws ControllerError (status set for HTTP errors). */
  async request<T = unknown>(method: string, path: string, opts: { body?: unknown; query?: Record<string, string | undefined>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const u = new URL(this.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) if (v !== undefined) u.searchParams.set(k, v);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? this.o.timeoutMs ?? 30_000);
    const onAbort = () => ac.abort();
    if (opts.signal?.aborted) ac.abort();
    else opts.signal?.addEventListener("abort", onAbort, { once: true });
    const headers: Record<string, string> = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (opts.body !== undefined) headers["Content-Type"] = "application/json";
    let r: Response;
    try {
      r = await this.fetchFn(u, {
        method, headers, signal: ac.signal,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch (e) {
      if (opts.signal?.aborted) throw e;
      throw new ControllerError(`cannot connect to the controller at ${this.url}; is it running?`);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    }
    const text = await r.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : undefined; } catch { json = undefined; }
    if (r.status >= 400) {
      const j = json as { error?: string; detail?: unknown } | undefined;
      const msg = j?.error ?? (j?.detail !== undefined ? JSON.stringify(j.detail) : text);
      throw new ControllerError(`${method} ${path}: ${msg}`, r.status);
    }
    return json as T;
  }

  private async healthy(): Promise<boolean> {
    try {
      await this.request("GET", "/health", { timeoutMs: 2000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Find the controller, starting it if allowed. Re-checks an unavailable controller at most every `recheckS`. */
  ensureController(): Promise<boolean> {
    this.ensuring ??= this.doEnsure().finally(() => { this.ensuring = undefined; });
    return this.ensuring;
  }

  private async doEnsure(): Promise<boolean> {
    if (this.available && (await this.healthy())) return true;
    if (this.available === false && Date.now() - this.checkedAt < (this.o.recheckS ?? 60) * 1000) return false;
    const ok = (await this.healthy()) || (this.autostart && isLoopback(this.url) && (await this.start()));
    this.checkedAt = Date.now();
    this.available = ok;
    if (!ok && !this.warned) {
      this.warned = true;
      console.warn(`aicontroller not available at ${this.url}; using direct mode`);
    }
    return ok;
  }

  private async start(): Promise<boolean> {
    const timeoutS = this.o.startTimeoutS ?? 20;
    let started = false;
    try { started = await (this.o.serviceStarter ?? startService)(); } catch { /* fall through to launch */ }
    if (!started) {
      const home = findHome(this.o.home);
      if (!home) return false;
      try {
        if (claimLaunchLock(home, timeoutS)) await (this.o.launcher ?? launchDetached)({ home, config: this.o.config });
      } catch {
        return false;
      }
    }
    const deadline = Date.now() + timeoutS * 1000;
    for (;;) {
      if (await this.healthy()) return true;
      if (Date.now() >= deadline) return false;
      await sleep(500);
    }
  }

  private async require(): Promise<void> {
    if (!(await this.ensureController())) {
      throw new ControllerUnavailable(`cannot connect to the controller at ${this.url}; is it running?`);
    }
  }

  async health(): Promise<{ ok: boolean; name?: string }> {
    return this.request("GET", "/health", { timeoutMs: 2000 });
  }

  async status(): Promise<Record<string, unknown>> {
    await this.require();
    return this.request("GET", "/v1/status");
  }

  async models(opts: ModelsOptions = {}): Promise<Record<string, unknown>[]> {
    await this.require();
    const r = await this.request<{ models: Record<string, unknown>[] }>("GET", "/v1/models", {
      query: { kind: opts.kind, scope: opts.scope ?? "all" },
    });
    return r.models;
  }

  async download(source: DownloadSource, opts: DownloadOptions = {}): Promise<Record<string, unknown>> {
    await this.require();
    return this.request("POST", "/v1/models/download", {
      body: {
        source, kind: opts.kind ?? null, subfolder: opts.subfolder ?? null, file_name: opts.fileName ?? null,
        sha256: opts.sha256 ?? null, host: opts.host ?? null,
      },
    });
  }

  async downloadStatus(id: string): Promise<Record<string, unknown>> {
    await this.require();
    return this.request("GET", `/v1/downloads/${id}`);
  }

  /** Request a lease; resolves when ready. Direct mode returns a lease with `direct = true`. */
  async lease(backend: string, opts: LeaseOptions = {}): Promise<Lease> {
    if (!(await this.ensureController())) {
      if (!this.o.fallback) {
        throw new ControllerUnavailable(`cannot connect to the controller at ${this.url}; is it running?`);
      }
      const url = (await this.o.fallback(backend, opts.model)) ?? null;
      return new Lease(undefined, { id: "direct", backend, model: opts.model ?? null, state: "ready", url }, true);
    }
    const waitS = opts.waitS ?? 900;
    const data = await this.request<LeaseData>("POST", "/v1/leases", {
      body: {
        backend, client: this.o.client ?? "typescript", model: opts.model ?? null, host: opts.host ?? null,
        wait_s: waitS, ttl_s: opts.ttlS ?? 120, allow_ask_first: opts.allowAskFirst ?? false,
      },
      timeoutMs: waitS * 1000 + (this.o.timeoutMs ?? 30_000),
      signal: opts.signal,
    });
    const lease = new Lease(this, data, false, opts.signal);
    if (data.state !== "ready") {
      await lease.release();
      if (data.state === "queued" || data.state === "starting") {
        throw new ControllerError(`lease for '${backend}' is still ${data.state} after waiting ${waitS}s; try a larger waitS`);
      }
      throw new ControllerError(`lease for '${backend}' ${data.state}: ${data.error}`);
    }
    return lease;
  }

  /** Run `fn(lease)` and always release the lease. */
  async withLease<T>(backend: string, opts: LeaseOptions, fn: (lease: Lease) => Promise<T> | T): Promise<T> {
    const lease = await this.lease(backend, opts);
    try {
      const out = await fn(lease);
      lease.check(); // work that ended on a revoked lease did not really finish
      return out;
    } finally {
      await lease.release();
    }
  }
}
