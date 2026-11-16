import { describe, expect, it, vi } from 'vitest';
import { LocalOnlyBus } from '../../src/switchboard/bus.js';
import { makeEventId } from '../../src/switchboard/client.js';
import { AvatarInbox } from '../../src/switchboard/inbox.js';
import { SwitchboardMirror } from '../../src/switchboard/mirror.js';
import type { Decision } from '../../src/switchboard/deliberate.js';
import { ToolRegistry } from '../../src/tools/tool-registry.js';
import { LocalVoiceService } from '../../src/local-voice/local-voice-service.js';
import { SpeechServiceClient } from '../../src/local-voice/speech-service-client.js';
import { LocalLlmClient } from '../../src/local-voice/local-llm-client.js';

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('a line the character wants to tell Kevin', () => {
  // The same path main uses: mirror.noteQueued(text, false, 'your own reading') -> the avatar's inbox -> the decide step.
  function setup(decision: Decision) {
    const bus = new LocalOnlyBus(makeEventId);
    const mirror = new SwitchboardMirror({ client: bus, avatarId: 'sage' });
    const notify = vi.fn();
    const remember = vi.fn();
    const deliberate = vi.fn(async () => decision);
    new AvatarInbox({ avatarId: 'sage', bus, notify, remember, deliberate, logger: { warn: vi.fn() } }).start();
    return { mirror, notify, remember, deliberate };
  }

  it('goes to the decide step as an update from itself, not from Kevin; saying it queues it for the avatar', async () => {
    const t = setup({ action: 'say', reason: 'Kevin would like it', urgent: false });
    t.mirror.noteQueued('I found a paper on forgetting.', false, 'your own reading');
    await flush();
    await flush();
    expect(t.deliberate).toHaveBeenCalledTimes(1);
    expect(t.notify).toHaveBeenCalledTimes(1);
    expect(t.notify.mock.calls[0][0]).toBe('I found a paper on forgetting.');
    expect(t.notify.mock.calls[0][1]).toMatchObject({ source: 'your own reading' });
  });

  it('may be kept quietly or ignored instead; the pursuit never speaks itself', async () => {
    const kept = setup({ action: 'remember', reason: 'later', urgent: false });
    kept.mirror.noteQueued('A note.', false, 'your own reading');
    await flush();
    await flush();
    expect(kept.remember).toHaveBeenCalledTimes(1);
    expect(kept.remember.mock.calls[0][2]).toBe('your own reading');
    expect(kept.notify).not.toHaveBeenCalled();
  });
});

describe('what the voice offers a pursuit', () => {
  const service = () =>
    new LocalVoiceService({
      llm: new LocalLlmClient({ baseUrl: 'http://x/v1', model: 'm' }),
      speech: new SpeechServiceClient({ baseUrl: 'http://s' }),
    });

  it('hands out its own conversation client', () => {
    const voice = service();
    expect(voice.chat().model).toBe('m');
  });

  it('has no recent lines before any talk', () => {
    expect(service().recentLines(5)).toEqual([]);
  });

  it('gives the last lines of the conversation, without the recalled-memory blocks, clipped', () => {
    const voice = service();
    (voice as unknown as { history: unknown[] }).history = [
      { role: 'user', content: '[Memories: x]\n\nHow was your day?' },
      { role: 'assistant', content: 'Quiet. I tidied the shelf.' },
      { role: 'user', content: 'y'.repeat(500) },
    ];
    const lines = voice.recentLines(2);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe('You: Quiet. I tidied the shelf.');
    expect(lines[1].startsWith('Kevin: yyy')).toBe(true);
    expect(lines[1].length).toBeLessThan(220);
    expect(voice.recentLines(3)[0]).toBe('Kevin: How was your day?');
  });
});

describe('ToolRegistry context', () => {
  it('passes the calling avatar to a tool that wants it, and nothing to one called without', async () => {
    const registry = new ToolRegistry();
    const seen: unknown[][] = [];
    registry.register({
      id: 'builtin:who',
      serverId: 'builtin',
      toolName: 'who',
      description: '',
      inputSchema: { type: 'object' },
      enabled: true,
      confirmationLevel: 'none',
      execute: async (...args: unknown[]) => (seen.push(args), 'ok'),
    });
    await registry.execute('builtin:who', { a: 1 }, { avatarId: 'sage' });
    await registry.execute('builtin:who', { a: 2 });
    expect(seen).toEqual([[{ a: 1 }, { avatarId: 'sage' }], [{ a: 2 }]]);
  });
});
