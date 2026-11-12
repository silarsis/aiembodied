import { describe, expect, it, vi } from 'vitest';
import { PresenceTracker } from '../src/presence/presence.js';
import { DELIBERATE_SYSTEM_PROMPT, deliberate, deliberateSystemPrompt, parseDecision } from '../src/switchboard/deliberate.js';
import type { ChatClient } from '../src/local-voice/voice-engines.js';
import type { SwitchboardEvent } from '../src/switchboard/types.js';

const event = (extra: Partial<SwitchboardEvent> = {}): SwitchboardEvent => ({
  id: 'E1', v: 1, at: '2026-11-10T20:00:00Z', type: 'avatar.inbox', producer: { kind: 'service', id: 'app' }, to: ['avatar:echo'],
  priority: 'normal', payload: { text: 'Tests passed', source: 'coding' }, ...extra,
});

function fake(reply: string | Error | 'hang') {
  const calls: Array<{ messages: Array<{ role: string; content: string }>; signal?: AbortSignal }> = [];
  const client = {
    baseUrl: 'x', flavor: 'llama-server', isAvailable: async () => true,
    async *streamChat(messages: never, options: { signal?: AbortSignal }) {
      calls.push({ messages, signal: options.signal });
      if (reply instanceof Error) throw reply;
      if (reply === 'hang') await new Promise(() => undefined);
      yield { type: 'text', text: reply as string };
    },
  } as unknown as ChatClient;
  return { client, calls };
}

describe('parseDecision', () => {
  it('reads plain, fenced and think-wrapped JSON', () => {
    expect(parseDecision('{"action":"say","reason":"he asked"}')).toEqual({ action: 'say', reason: 'he asked' });
    expect(parseDecision('```json\n{"action": "Remember", "reason": "later"}\n```')).toEqual({ action: 'remember', reason: 'later' });
    expect(parseDecision('<think>{"action":"say"}</think>Sure: {"action":"ignore","reason":"noise"} ok')).toEqual({ action: 'ignore', reason: 'noise' });
  });
  it('rejects garbage and unknown actions', () => {
    expect(parseDecision('no json')).toBeNull();
    expect(parseDecision('{"action":"act"}')).toBeNull();
    expect(parseDecision('{"action":')).toBeNull();
  });
});

describe('deliberate', () => {
  const presence = new PresenceTracker();
  presence.update({ listening: true, lastUserSpeechAt: 1_000 });

  it('sends presence and the event, and returns the decision', async () => {
    const { client, calls } = fake('{"action":"say","reason":"he is here"}');
    const result = await deliberate(event(), presence, { clients: [client], now: () => 13_000 });
    expect(result).toEqual({ action: 'say', reason: 'he is here', urgent: false, engine: 'llm' });
    expect(calls[0].messages[0]).toEqual({ role: 'system', content: DELIBERATE_SYSTEM_PROMPT });
    const user = calls[0].messages[1].content;
    expect(user).toContain('Kevin last spoke 12 s ago');
    expect(user).toContain('type: avatar.inbox');
    expect(user).toContain('from: coding');
    expect(user).toContain('priority: normal');
    expect(user).toContain('text: Tests passed');
    expect(DELIBERATE_SYSTEM_PROMPT).toContain('ignore (noise)');
  });

  it('names the deciding avatar in the prompt (Echo by default)', async () => {
    expect(deliberateSystemPrompt()).toContain('You are Echo,');
    expect(deliberateSystemPrompt('Sage')).toContain('You are Sage,');
    const { client, calls } = fake('{"action":"ignore","reason":""}');
    await deliberate(event(), presence, { clients: [client], avatarName: 'Sage' });
    expect(calls[0].messages[0].content).toContain('You are Sage,');
  });

  it('flags urgent events', async () => {
    const { client } = fake('{"action":"say","reason":""}');
    expect((await deliberate(event({ priority: 'urgent' }), presence, { clients: [client] }))?.urgent).toBe(true);
  });

  it('gives null for garbage, thrown errors and no clients', async () => {
    const warn = vi.fn();
    expect(await deliberate(event(), presence, { clients: [fake('hmm').client], logger: { warn } })).toBeNull();
    expect(await deliberate(event(), presence, { clients: [fake(new Error('down')).client], logger: { warn } })).toBeNull();
    expect(await deliberate(event(), presence, { clients: [] })).toBeNull();
    expect(warn).toHaveBeenCalled();
  });

  it('gives null on timeout even if the client ignores the signal', async () => {
    const { client } = fake('hang');
    expect(await deliberate(event(), presence, { clients: [client], timeoutMs: 20, logger: { warn: vi.fn() } })).toBeNull();
  });
});
