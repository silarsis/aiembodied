import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CompanionHub, decodeDataUrl, lanAddresses, type CompanionVoice } from '../src/companion/companion-hub.js';
import {
  CompanionRegistry,
  cleanDeviceName,
  formatPairingCode,
  generatePairingCode,
  normalizePairingCode,
} from '../src/companion/companion-registry.js';
import type { CompanionScene, CompanionStreamEvent } from '../src/companion/types.js';
import type { LocalVoiceEvent } from '../src/local-voice/types.js';

const scene: CompanionScene = {
  avatar: { id: 'vrm-1', name: 'Echo', fileSha: 'abc' },
  background: { id: 'garden', groundY: 0.8 },
  animations: [{ id: 'anim-1', name: 'Happy Wave' }],
  poses: [{ id: 'pose-1', name: 'Power Stance' }],
  motionReady: false,
};

function fakeVoice(): CompanionVoice & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    transcribe: vi.fn(async (wav: Uint8Array) => {
      calls.push(`transcribe:${wav.length}`);
      return { text: wav.length > 100 ? 'what time is it' : '', timings: {} };
    }),
    respond: vi.fn(async (request, emit: (event: LocalVoiceEvent) => void) => {
      calls.push(`respond:${request.text}:${request.instructions ?? ''}`);
      emit({ requestId: request.requestId, type: 'sentence', index: 0, text: 'It is noon. {anim:happy-wave}', wav: new Uint8Array([1, 2, 3]) });
      return { requestId: request.requestId, text: 'It is noon. {anim:happy-wave}', cancelled: false };
    }),
    cancel: vi.fn((requestId?: string) => {
      calls.push(`cancel:${requestId ?? ''}`);
    }),
    speak: vi.fn(async (requestId: string, text: string, emit: (event: LocalVoiceEvent) => void) => {
      calls.push(`speak:${text}`);
      emit({ requestId, type: 'sentence', index: 0, text, wav: new Uint8Array([9]) });
    }),
  };
}

function wav(bytes: number): Uint8Array {
  const data = new Uint8Array(bytes);
  data.set(new TextEncoder().encode('RIFF'), 0);
  return data;
}

async function readLines(response: Response): Promise<CompanionStreamEvent[]> {
  const text = await response.text();
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as CompanionStreamEvent);
}

/** Read NDJSON events from a stream that stays open, until `until` matches one. */
async function readUntil(
  response: Response,
  until: (event: CompanionStreamEvent) => boolean,
): Promise<CompanionStreamEvent[]> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  const events: CompanionStreamEvent[] = [];
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf('\n');
    while (newline >= 0) {
      const event = JSON.parse(buffer.slice(0, newline)) as CompanionStreamEvent;
      buffer = buffer.slice(newline + 1);
      events.push(event);
      if (until(event)) {
        await reader.cancel();
        return events;
      }
      newline = buffer.indexOf('\n');
    }
  }
  return events;
}

describe('pairing codes', () => {
  it('generates readable codes and normalises what is typed', () => {
    const code = generatePairingCode();
    expect(code).toMatch(/^[2-9A-HJKMNP-Z]{12}$/);
    expect(formatPairingCode('abcdefghjkmn')).toBe('ABCD-EFGH-JKMN');
    expect(normalizePairingCode(' abcd-efgh jkmn ')).toBe('ABCDEFGHJKMN');
  });

  it('cleans device names', () => {
    expect(cleanDeviceName('  Pixel\u0007 9 ', 'Phone')).toBe('Pixel 9');
    expect(cleanDeviceName('', 'Phone')).toBe('Phone');
    expect(cleanDeviceName('x'.repeat(100), 'Phone')).toHaveLength(60);
  });

  it('decodes background data URLs', () => {
    const image = decodeDataUrl(`data:image/webp;base64,${Buffer.from('img').toString('base64')}`);
    expect(image.mime).toBe('image/webp');
    expect(image.data.toString()).toBe('img');
  });

  it('lists only external IPv4 addresses', () => {
    expect(
      lanAddresses({
        lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, netmask: '', mac: '', cidr: null }],
        eth0: [
          { address: '192.168.1.20', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null },
          { address: 'fe80::1', family: 'IPv6', internal: false, netmask: '', mac: '', cidr: null, scopeid: 1 },
        ],
        tailscale0: [{ address: '100.101.102.103', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
        wifi: [{ address: '169.254.3.4', family: 'IPv4', internal: false, netmask: '', mac: '', cidr: null }],
      }),
    ).toEqual(['192.168.1.20', '100.101.102.103']);
  });
});

describe('CompanionHub', () => {
  let directory: string;
  let registry: CompanionRegistry;
  let hub: CompanionHub;
  let voice: ReturnType<typeof fakeVoice>;
  let base: string;
  let headers: Record<string, string>;
  const transcripts: Array<{ role: string; text: string }> = [];

  beforeEach(async () => {
    directory = await mkdtemp(path.join(os.tmpdir(), 'companion-'));
    await mkdir(path.join(directory, 'dist', 'assets'), { recursive: true });
    await writeFile(path.join(directory, 'dist', 'companion.html'), '<html>phone</html>');
    await writeFile(path.join(directory, 'dist', 'assets', 'app.js'), 'console.log(1)');
    await writeFile(path.join(directory, 'secret.txt'), 'nope');
    registry = new CompanionRegistry(path.join(directory, 'devices.json'));
    await registry.load();
    voice = fakeVoice();
    transcripts.length = 0;
    hub = new CompanionHub({
      registry,
      staticDirectory: path.join(directory, 'dist'),
      getScene: async () => scene,
      loadAvatar: async () => new Uint8Array([7, 7, 7]),
      loadBackground: async () => `data:image/png;base64,${Buffer.from('png').toString('base64')}`,
      loadAnimation: async () => new Uint8Array([5]),
      loadPose: async (id) => ({ id, hips: { rotation: [0, 0, 0, 1] } }),
      getVoice: () => voice,
      getInstructions: () => 'You are Echo.',
      getMotion: () => async (request, onChunk) => {
        onChunk({ streamId: request.streamId, index: 0, start: 0, name: 'm', duration: 1, data: 'AAAA' });
        return { streamId: request.streamId, chunks: 1, firstChunkMs: 5, totalMs: 10 };
      },
      onTranscript: (entry) => transcripts.push(entry),
    });
    await hub.apply({ enabled: true, port: 0 });
    base = `http://127.0.0.1:${hub.listeningPort}`;
    headers = {
      Authorization: `Bearer ${formatPairingCode(registry.pairingCode).toLowerCase()}`,
      'X-Companion-Device': 'phone-1234',
      'X-Companion-Name': encodeURIComponent('Kevin’s Pixel'),
    };
  });

  afterEach(async () => {
    await hub.stop();
    await rm(directory, { recursive: true, force: true });
  });

  it('serves the phone page and its assets without a code, and nothing else', async () => {
    expect(await (await fetch(`${base}/`)).text()).toBe('<html>phone</html>');
    const asset = await fetch(`${base}/assets/app.js`);
    expect(asset.headers.get('content-type')).toContain('javascript');
    expect((await fetch(`${base}/assets/../../secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/assets/%2e%2e/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${base}/secret.txt`)).status).toBe(404);
  });

  it('refuses API calls without the pairing code and locks out guessing', async () => {
    expect((await fetch(`${base}/api/scene`)).status).toBe(401);
    for (let i = 0; i < 9; i += 1) {
      await fetch(`${base}/api/scene`, { headers: { Authorization: 'Bearer WRONG' } });
    }
    const locked = await fetch(`${base}/api/scene`, { headers });
    expect(locked.status).toBe(429);
  });

  it('needs a device id', async () => {
    const response = await fetch(`${base}/api/scene`, { headers: { Authorization: headers.Authorization } });
    expect(response.status).toBe(400);
  });

  it('registers the device and serves the scene and its files', async () => {
    expect(await (await fetch(`${base}/api/scene`, { headers })).json()).toEqual(scene);
    expect(registry.get('phone-1234')?.name).toBe('Kevin’s Pixel');
    expect(new Uint8Array(await (await fetch(`${base}/api/avatar/vrm-1`, { headers })).arrayBuffer())).toEqual(new Uint8Array([7, 7, 7]));
    const background = await fetch(`${base}/api/background/garden`, { headers });
    expect(background.headers.get('content-type')).toBe('image/png');
    expect(await background.text()).toBe('png');
    expect(await (await fetch(`${base}/api/poses/pose-1`, { headers })).json()).toEqual({ id: 'pose-1', hips: { rotation: [0, 0, 0, 1] } });
    expect((await fetch(`${base}/api/animations/anim-1`, { headers })).status).toBe(200);
    // Remembered across restarts.
    const reloaded = new CompanionRegistry(path.join(directory, 'devices.json'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await reloaded.load();
    expect(reloaded.get('phone-1234')).toBeTruthy();
    expect(reloaded.pairingCode).toBe(registry.pairingCode);
    expect(JSON.parse(await readFile(path.join(directory, 'devices.json'), 'utf8')).devices).toHaveLength(1);
  });

  it('runs a spoken turn through the desktop pipeline with the desktop prompt', async () => {
    const response = await fetch(`${base}/api/turn`, { method: 'POST', headers: { ...headers, 'Content-Type': 'audio/wav' }, body: wav(2000) });
    expect(response.status).toBe(200);
    const events = await readLines(response);
    expect(events.map((event) => event.type)).toEqual(['transcript', 'sentence', 'done']);
    expect(events[0]).toMatchObject({ text: 'what time is it' });
    expect(events[1]).toMatchObject({ text: 'It is noon. {anim:happy-wave}', wav: Buffer.from([1, 2, 3]).toString('base64') });
    expect(voice.calls).toContain('respond:what time is it:You are Echo.');
    expect(transcripts).toEqual([
      { role: 'user', text: 'what time is it', deviceId: 'phone-1234' },
      { role: 'assistant', text: 'It is noon. {anim:happy-wave}', deviceId: 'phone-1234' },
    ]);
  });

  it('ends a turn with nothing heard without asking the model', async () => {
    const events = await readLines(await fetch(`${base}/api/turn`, { method: 'POST', headers, body: wav(60) }));
    expect(events.map((event) => event.type)).toEqual(['transcript', 'done']);
    expect(voice.calls.some((call) => call.startsWith('respond'))).toBe(false);
  });

  it('streams live motion chunks', async () => {
    const events = await readLines(
      await fetch(`${base}/api/motion`, { method: 'POST', headers, body: JSON.stringify({ streamId: 's1', prompt: 'shrugs' }) }),
    );
    expect(events[0]).toMatchObject({ type: 'motion', streamId: 's1', index: 0, data: 'AAAA' });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('pushes the scene and desktop messages to connected phones', async () => {
    const statuses: boolean[] = [];
    const push = await fetch(`${base}/api/events`, { headers });
    expect(push.status).toBe(200);
    const received = readUntil(push, (event) => event.type === 'done');
    await vi.waitFor(() => expect(hub.getStatus().devices[0]?.connected).toBe(true));
    statuses.push(true);

    const result = await hub.say({ text: 'Your tea is ready.' });
    expect(result.delivered).toEqual(['phone-1234']);
    const events = await received;
    expect(events.map((event) => event.type)).toEqual(['ping', 'scene', 'say', 'sentence', 'done']);
    expect(events[3]).toMatchObject({ text: 'Your tea is ready.', wav: Buffer.from([9]).toString('base64') });
    await vi.waitFor(() => expect(hub.getStatus().devices[0]?.connected).toBe(false));
  });

  it('says nothing when no phone is connected', async () => {
    expect(await hub.say({ text: 'Hello?' })).toEqual({ delivered: [] });
    expect(voice.calls).toEqual([]);
  });

  it('accepts say requests over HTTP for other programs', async () => {
    const response = await fetch(`${base}/api/say`, { method: 'POST', headers, body: JSON.stringify({ text: 'Hi' }) });
    expect(await response.json()).toEqual({ delivered: [] });
  });

  it('drops phones when the pairing code changes', async () => {
    const push = await fetch(`${base}/api/events`, { headers });
    const closed = readUntil(push, () => false);
    await vi.waitFor(() => expect(hub.getStatus().devices[0]?.connected).toBe(true));
    const old = headers.Authorization;
    const status = await hub.rotatePairingCode();
    await closed;
    expect(status.pairingCode).not.toBe(old);
    expect((await fetch(`${base}/api/scene`, { headers })).status).toBe(401);
  });

  it('reports a port that is taken instead of throwing', async () => {
    const other = new CompanionHub({
      registry,
      staticDirectory: null,
      getScene: async () => scene,
      loadAvatar: async () => new Uint8Array(),
      loadBackground: async () => '',
      loadAnimation: async () => new Uint8Array(),
      loadPose: async () => null,
      getVoice: () => null,
      getInstructions: () => undefined,
    });
    await other.apply({ enabled: true, port: hub.listeningPort ?? 0 });
    expect(other.getStatus()).toMatchObject({ running: false, error: expect.stringContaining('already in use') });
    await other.stop();
  });
});

describe('LocalVoiceService.speak', () => {
  it('speaks a pushed message sentence by sentence and remembers it', async () => {
    const { LocalVoiceService } = await import('../src/local-voice/local-voice-service.js');
    const synthesized: string[] = [];
    const service = new LocalVoiceService({
      llm: {} as never,
      speech: {} as never,
      stt: {} as never,
      tts: {
        synthesize: async (text: string) => {
          synthesized.push(text);
          return new Uint8Array([text.length]);
        },
        status: () => ({ provider: 'kokoro', available: true, ready: true, model: null, voice: null, error: null }),
      },
    });
    const events: LocalVoiceEvent[] = [];
    await service.speak('r1', 'Your tea is ready now. {anim:happy-wave} Come and get it!', (event) => events.push(event));
    expect(events.map((event) => event.type === 'sentence' && event.text)).toEqual([
      'Your tea is ready now.',
      '{anim:happy-wave} Come and get it!',
    ]);
    expect(synthesized).toEqual(['Your tea is ready now.', 'Come and get it!']);
    expect((service as unknown as { history: unknown[] }).history).toEqual([
      { role: 'assistant', content: 'Your tea is ready now. {anim:happy-wave} Come and get it!' },
    ]);
  });
});

describe('companion settings', () => {
  it('is off by default and can be turned on from the environment', async () => {
    const { resolveProviderSettings } = await import('../src/config/provider-settings.js');
    expect(resolveProviderSettings({}).companion).toEqual({ enabled: false, port: 8790 });
    expect(resolveProviderSettings({ COMPANION_ENABLED: '1', COMPANION_PORT: '9001' }).companion).toEqual({ enabled: true, port: 9001 });
    expect(resolveProviderSettings({ COMPANION_PORT: '80' }).companion.port).toBe(8790);
    expect(resolveProviderSettings({}, { companion: { enabled: true } }).companion).toEqual({ enabled: true, port: 8790 });
  });
});
