import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createBridge } from '../../src/bridge/create-bridge.js';
import { requestPairing } from '../../src/satellite/pairing.js';
import { satelliteConfig, EMPTY_LOCAL_ANSWERS } from '../../src/satellite/local-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const preload = readFileSync(path.resolve(here, '../../src/preload.ts'), 'utf8');

describe('the shared bridge list', () => {
  it('is built by the preload from ipcRenderer, which keeps no channel list of its own', () => {
    expect(preload).toContain('createBridge(');
    // The only channel the preload names itself is its one-way diagnostics message.
    const own = [...preload.matchAll(/'([a-z][a-z0-9-]*(?::[a-z0-9-]+)+)'/g)].map((match) => match[1]).filter((name) => name !== 'preload:bridge-exposed');
    expect([...new Set(own)]).toEqual(['diagnostics:preload-log']);
  });

  it('turns a call into one invoke with its arguments, and an event into a listener without the event object', async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const listeners = new Map<string, (...args: unknown[]) => void>();
    const off = vi.fn();
    const api = createBridge({
      invoke,
      on: (channel, listener) => {
        listeners.set(channel, listener);
        return off;
      },
    });
    await api.config.getSecret('realtimeApiKey');
    expect(invoke).toHaveBeenCalledWith('config:get-secret', 'realtimeApiKey');
    const heard: unknown[] = [];
    const stop = api.places?.onChanged((snapshot) => heard.push(snapshot));
    listeners.get('places:changed')?.({ localPlaceId: 'study' });
    expect(heard).toEqual([{ localPlaceId: 'study' }]);
    stop?.();
    expect(off).toHaveBeenCalled();
    // A voice event with extra fields keeps only the payload.
    const voice: unknown[] = [];
    api.localVoice?.onEvent((event) => voice.push(event));
    listeners.get('local-voice:event')?.({ type: 'x' });
    expect(voice).toEqual([{ type: 'x' }]);
  });

  it('copies a binary answer the way the preload always did, and reports a payload it cannot read', async () => {
    const logError = vi.fn();
    const api = createBridge({ invoke: async () => new Uint8Array([1, 2, 3]), on: () => () => undefined }, { logError });
    expect(Array.from(new Uint8Array((await api.avatar?.loadModelBinary('m')) as ArrayBuffer))).toEqual([1, 2, 3]);
    const bad = createBridge({ invoke: async () => 'nope', on: () => () => undefined }, { logError });
    await expect(bad.avatar?.loadModelBinary('m')).rejects.toThrow('Unexpected VRM binary payload');
    expect(logError).toHaveBeenCalledWith('Unexpected VRM binary payload received from main process.', { id: 'm', payloadType: 'string' });
  });
});

describe('shared satellite answers', () => {
  it('builds the satellite config, marking a browser when asked', () => {
    expect(satelliteConfig({})).toMatchObject({ role: 'satellite', wakeWord: { keywordLabel: 'Hey Echo' } });
    expect(satelliteConfig({})).not.toHaveProperty('satelliteKind');
    expect(satelliteConfig({ kind: 'browser', keyword: 'Hey Sage', audioPreferences: { audioOutputDeviceId: 's' } })).toMatchObject({
      role: 'satellite',
      satelliteKind: 'browser',
      audioOutputDeviceId: 's',
      wakeWord: { keywordLabel: 'Hey Sage' },
    });
  });

  it('answers the always-empty channels the same way for both satellites', () => {
    expect(Object.keys(EMPTY_LOCAL_ANSWERS).sort()).toEqual(['approvals:list', 'metrics:observe-latency', 'rooms:making', 'wake-word:list', 'wake-word:set-listening']);
    expect(EMPTY_LOCAL_ANSWERS['wake-word:list']([])).toEqual([]);
  });
});

describe('requestPairing', () => {
  const ok = (body: unknown, status = 200) => vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status }));

  it('posts the code and the kind and reads the token', async () => {
    const fetchFn = ok({ deviceId: 'room-1', token: 't', placeId: 'study' });
    const result = await requestPairing({ hubUrl: 'bija', code: '123 456', defaultDeviceName: 'host', kind: 'browser', fetchFn: fetchFn as never });
    expect(fetchFn).toHaveBeenCalledWith('http://bija:8791/v1/pair', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body)).toEqual({ code: '123456', deviceName: 'host', placeName: 'the study', kind: 'browser' });
    expect(result).toMatchObject({ hub: { ws: 'ws://bija:8791' }, body: { deviceId: 'room-1', token: 't', placeId: 'study' } });
  });

  it('sends no kind from the desktop app, and explains each refusal', async () => {
    const fetchFn = ok({ deviceId: 'd', token: 't', placeId: 'p' });
    await requestPairing({ hubUrl: 'bija', code: '123456', defaultDeviceName: 'host', fetchFn: fetchFn as never });
    expect(JSON.parse((fetchFn.mock.calls[0][1] as { body: string }).body)).not.toHaveProperty('kind');
    await expect(requestPairing({ hubUrl: 'bija', code: '123456', defaultDeviceName: 'h', fetchFn: ok({}, 401) as never })).rejects.toThrow('wrong or has expired');
    await expect(requestPairing({ hubUrl: 'bija', code: '123456', defaultDeviceName: 'h', fetchFn: ok({}, 403) as never })).rejects.toThrow('does not trust');
    await expect(requestPairing({ hubUrl: 'bija', code: '12', defaultDeviceName: 'h' })).rejects.toThrow('6 digits');
    await expect(requestPairing({ hubUrl: '', code: '123456', defaultDeviceName: 'h' })).rejects.toThrow('not a hub address');
    await expect(requestPairing({ hubUrl: 'bija', code: '123456', defaultDeviceName: 'h', fetchFn: ok({ nope: 1 }) as never })).rejects.toThrow('does not understand');
  });
});
