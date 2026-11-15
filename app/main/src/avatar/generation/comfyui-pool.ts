/**
 * Picks which ComfyUI server runs an image or 3D job, from the servers Models and servers lists
 * for that stage: the first one that answers, or (with "spread") whichever answers with the
 * shortest queue. This PC's ComfyUI is started on demand, as before; other machines must already
 * be running.
 *
 * With the model controller (aicontroller) in use, this PC's server is the controller's comfyui
 * backend instead: each request holds a shared lease and talks to the lease's URL, and the app
 * neither starts nor kills ComfyUI. Other machines' servers are never touched. A controller without a
 * comfyui backend leaves everything as above.
 */
import { routeTargets, type ModelRouting, type ModelServer } from '../../config/model-routing.js';
import { comfyQueueLength } from '../../config/model-server-probe.js';
import type { SharedLeases } from '../../aicontroller/bridge.js';
import { ComfyUIClient } from './comfyui-client.js';
import { ComfyUIRuntime } from './comfyui-runtime.js';

export type ComfyStage = 'image' | 'mesh';

interface Entry {
  url: string;
  /** Leased from the model controller. */
  leased: boolean;
  client: ComfyUIClient;
  runtime?: ComfyUIRuntime;
}

export interface ComfyUIPoolOptions {
  routing: () => ModelRouting;
  logDirectory: string;
  fetchFn?: typeof fetch;
  /** Builds the on-demand launcher for this PC's server; tests replace it. */
  createRuntime?: (client: ComfyUIClient) => ComfyUIRuntime;
  logger?: Pick<Console, 'warn' | 'info'>;
  /** The model controller, when this app has one. */
  leases?: SharedLeases;
}

export class ComfyUIPool {
  private readonly entries = new Map<string, Entry>();
  /** Servers whose ComfyUI the controller runs (it has a comfyui backend), found when they were last made ready. */
  private readonly leasedIds = new Set<string>();

  constructor(private readonly options: ComfyUIPoolOptions) {}

  /** The client for a server, reused while its address stays the same. */
  clientFor(server: ModelServer): ComfyUIClient {
    return this.entry(server).client;
  }

  /** The first ComfyUI server of a stage, whether or not it is running (for model discovery). */
  primary(stage: ComfyStage): ModelServer | undefined {
    return routeTargets(this.options.routing(), stage)[0]?.server;
  }

  /** Start this PC's server for a stage if it is the first choice and not running yet. */
  async ensurePrimaryReady(stage: ComfyStage): Promise<void> {
    const server = this.primary(stage);
    if (server) await this.ready(server);
  }

  async pick(stage: ComfyStage): Promise<ComfyUIClient> {
    const routing = this.options.routing();
    const servers = routeTargets(routing, stage).map((target) => target.server);
    if (!servers.length) throw new Error('No ComfyUI server is set for this step. Choose one in Models and servers.');
    const spread = routing.routes[stage].spread === true && servers.length > 1;

    if (spread) {
      const loads = await Promise.all(
        servers.map(async (server) => {
          // Probing would lease (start) the controller's ComfyUI; it is chosen below, with the others.
          if (this.viaController(server)) return null;
          const entry = this.entry(server);
          if (!(await entry.client.isAvailable())) return null;
          return { server, entry, queue: await this.queue(entry) };
        }),
      );
      const running = loads.filter((load): load is NonNullable<typeof load> => load !== null);
      if (running.length) {
        running.sort((a, b) => a.queue - b.queue);
        this.options.logger?.info('ComfyUI server chosen by queue length.', {
          stage,
          server: running[0].server.name,
          queue: running[0].queue,
        });
        return running[0].entry.client;
      }
    }

    const failures: string[] = [];
    for (const server of servers) {
      try {
        await this.ready(server);
        return this.entry(server).client;
      } catch (error) {
        failures.push(`${server.name}: ${error instanceof Error ? error.message : String(error)}`);
        this.options.logger?.warn('ComfyUI server unavailable; trying the next one.', { stage, server: server.name });
      }
    }
    throw new Error(
      servers.length === 1 ? failures[0].replace(/^[^:]+: /, '') : `No ComfyUI server answered. ${failures.join(' ')}`,
    );
  }

  /** This PC's own server, with the model controller in use: the controller may run it. */
  private viaController(server: ModelServer): boolean {
    return server.managed && this.options.leases?.inUse() === true;
  }

  private async ready(server: ModelServer): Promise<void> {
    if (this.viaController(server)) {
      // Leasing starts ComfyUI (the controller may need to make room first) and says where it is.
      const handle = await this.options.leases?.acquire('comfyui');
      if (handle) {
        handle.done(); // the client holds it again for each request
        this.leasedIds.add(server.id);
        return;
      }
    }
    this.leasedIds.delete(server.id);
    const entry = this.entry(server);
    if (entry.runtime) {
      await entry.runtime.ensureReady();
    }
    if (!(await entry.client.isAvailable())) {
      throw new Error(`ComfyUI isn't reachable at ${server.url}. Start it on that machine and try again.`);
    }
  }

  private async queue(entry: Entry): Promise<number> {
    try {
      const response = await (this.options.fetchFn ?? fetch)(`${entry.url}/queue`, { signal: AbortSignal.timeout(3000) });
      return response.ok ? comfyQueueLength(await response.json()) : Number.POSITIVE_INFINITY;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  }

  private entry(server: ModelServer): Entry {
    const leased = this.leasedIds.has(server.id);
    const existing = this.entries.get(server.id);
    if (existing && existing.url === server.url && existing.leased === leased) return existing;
    const leases = this.options.leases;
    const client = new ComfyUIClient({
      baseUrl: server.url,
      fetchFn: this.options.fetchFn,
      ...(leased && leases
        ? {
            lease: {
              acquire: async () => {
                const handle = await leases.acquire('comfyui');
                if (!handle) throw new Error('The model controller no longer has a comfyui backend.');
                return handle;
              },
            },
          }
        : {}),
    });
    const runtime = server.managed && !leased
      ? (this.options.createRuntime ?? ((c) => new ComfyUIRuntime({ client: c, logDirectory: this.options.logDirectory })))(client)
      : undefined;
    const entry = { url: server.url, leased, client, runtime };
    this.entries.set(server.id, entry);
    return entry;
  }
}
