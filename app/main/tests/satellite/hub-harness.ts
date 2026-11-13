import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PlaceManager } from '../../src/places/place-manager.js';
import { RoomDeviceRegistry } from '../../src/room-hub/room-devices.js';
import { RoomHub } from '../../src/room-hub/room-hub.js';

export const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: null },
  { id: 'sage', name: 'Sage', vrmModelId: null },
];

type Handler = (event: { sender: { send: (channel: string, ...args: unknown[]) => void; isDestroyed(): boolean }; placeId?: string }, ...args: unknown[]) => unknown;

export interface Harness {
  hub: RoomHub;
  places: PlaceManager;
  folder: string;
  handlers: Record<string, Handler>;
  /** Stops the hub and starts a new one on the same port with the same devices. */
  restart(): Promise<void>;
  stop(): Promise<void>;
  url(): string;
  /** Makes a code on the hub, so a satellite can pair. */
  code(placeName?: string): Promise<string>;
  cleanup(): Promise<void>;
}

/** A real RoomHub on 127.0.0.1 with the handlers a test gives it, as main.ts would register them. */
export async function startHarness(
  handlers: Record<string, Handler> = {},
  extra: { onSatelliteMessage?: ConstructorParameters<typeof RoomHub>[0]['onSatelliteMessage'] } = {},
): Promise<Harness> {
  const folder = mkdtempSync(path.join(tmpdir(), 'satellite-test-'));
  const assetRoot = path.join(folder, 'assets');
  mkdirSync(path.join(assetRoot, 'polyhaven', 'chair'), { recursive: true });
  writeFileSync(path.join(assetRoot, 'polyhaven', 'chair', 'chair.glb'), Buffer.from([1, 2, 3, 4, 5]));
  const data = new Map<string, string>();
  const store = { getValue: (key: string) => data.get(key) ?? null, setValue: (key: string, value: string) => void data.set(key, value) };
  const places = new PlaceManager({ store, registry: { list: () => PROFILES }, graceMs: 60_000 });
  const registry = new RoomDeviceRegistry(path.join(folder, 'room-devices.json'));
  let port = 0;
  const make = () =>
    new RoomHub({
      registry,
      places,
      tailscale: { whois: async () => null, self: async () => null },
      assetRoot,
      avatars: () => PROFILES,
      settings: () => ({ wakeWord: { model: 'hey_echo', keywordLabel: 'Hey Echo' }, pushToTalk: null }),
      handlerFor: (channel) => handlers[channel] as never,
      env: {},
      port,
      listenAddresses: () => ['127.0.0.1'],
      helloTimeoutMs: 500,
      onSatelliteMessage: extra.onSatelliteMessage,
    });
  let hub = make();
  await hub.start();
  // The hub only listens when a code is active or a device is paired; the first test call to code() starts it.
  const harness: Harness = {
    hub,
    places,
    folder,
    handlers,
    url: () => `ws://127.0.0.1:${port}`,
    async code(placeName = 'the study') {
      const started = await harness.hub.startPairing(placeName);
      port = harness.hub.port() as number;
      return started.code;
    },
    async stop() {
      await harness.hub.stop();
    },
    async restart() {
      await harness.hub.stop();
      hub = make();
      harness.hub = hub;
      await hub.start();
    },
    async cleanup() {
      await harness.hub.stop();
      rmSync(folder, { recursive: true, force: true });
    },
  };
  return harness;
}

export async function waitFor(check: () => boolean, timeoutMs = 4000, label = 'condition'): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
