import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalLlmClient } from '../src/local-voice/local-llm-client.js';
import { SpeechServiceClient } from '../src/local-voice/speech-service-client.js';
import { LocalVoiceService, SYSTEM_COALESCE_MS, SYSTEM_MIN_GAP_MS, SYSTEM_NOTE_MARKER } from '../src/local-voice/local-voice-service.js';
import { ApprovalBroker } from '../src/tools/approvals.js';
import { ToolRegistry, type RegisteredTool } from '../src/tools/tool-registry.js';

type Delta = { content?: string; tool_calls?: unknown[] };

function sseResponse(deltas: Delta[]): Response {
  const lines = deltas.map((delta) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
  return new Response(new TextEncoder().encode(lines.join('') + 'data: [DONE]\n\n'), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

const startCall: Delta[] = [
  { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'start_coding_task', arguments: '{"workspace":"aiembodied","goal":"Fix X"}' } }] },
];

function tool(name: string, level: RegisteredTool['confirmationLevel'], execute = vi.fn(async () => 'ok')): RegisteredTool {
  return {
    id: `coding:${name}`,
    serverId: 'coding',
    toolName: name,
    description: name,
    inputSchema: { type: 'object' },
    enabled: true,
    confirmationLevel: level,
    describeCall: (p) => `start a coding task: ${(p as { goal?: string }).goal ?? ''}`,
    execute,
  };
}

function setup(rounds: Array<Delta[] | Error>, options: { approvals?: boolean; tools?: RegisteredTool[]; now?: () => number; onSystemReady?: () => void; extra?: string } = {}) {
  const chats: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
  let round = 0;
  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/chat/completions')) {
      chats.push(JSON.parse(String(init?.body)));
      const next = rounds[round++] ?? [{ content: 'Okay.' }];
      if (next instanceof Error) throw next;
      return sseResponse(next);
    }
    if (url.endsWith('/v1/tts')) return new Response(new Uint8Array([1]), { status: 200 });
    throw new Error(`unexpected request ${url}`);
  }) as unknown as typeof fetch;
  const registry = new ToolRegistry();
  const startExecute = vi.fn(async () => 'Started task t1.');
  for (const t of options.tools ?? [tool('start_coding_task', 'confirm', startExecute)]) registry.register(t);
  const broker = new ApprovalBroker({ registry });
  const service = new LocalVoiceService({
    llm: new LocalLlmClient({ baseUrl: 'http://llm/v1', model: 'qwen', fetchFn }),
    speech: new SpeechServiceClient({ baseUrl: 'http://speech', fetchFn }),
    tools: registry,
    ...(options.approvals === false ? {} : { approvals: broker }),
    extraInstructions: () => options.extra ?? null,
    onSystemReady: options.onSystemReady,
    now: options.now,
  });
  return { service, chats, broker, startExecute, registry };
}

afterEach(() => vi.useRealTimers());

describe('LocalVoiceService approvals', () => {
  it('offers confirm tools but not block tools, and keeps confirm hidden without a broker', async () => {
    const tools = [tool('start_coding_task', 'confirm'), tool('wipe', 'block'), tool('look', 'none')];
    const withBroker = setup([[{ content: 'Hi.' }]], { tools });
    await withBroker.service.respond({ requestId: 'r', text: 'hello' }, () => {});
    expect(withBroker.chats[0].tools?.map((t) => t.function.name).sort()).toEqual(['look', 'start_coding_task']);
    const without = setup([[{ content: 'Hi.' }]], { tools, approvals: false });
    await without.service.respond({ requestId: 'r', text: 'hello' }, () => {});
    expect(without.chats[0].tools?.map((t) => t.function.name)).toEqual(['look']);
  });

  it('does not run a confirm tool; the model is told to ask Kevin', async () => {
    const { service, chats, broker, startExecute } = setup([startCall, [{ content: 'Shall I start it?' }]]);
    const result = await service.respond({ requestId: 'r', text: 'fix X please' }, () => {});
    expect(startExecute).not.toHaveBeenCalled();
    expect(broker.list()).toHaveLength(1);
    const toolMessage = chats[1].messages.find((m) => m.role === 'tool');
    expect(toolMessage?.content).toBe('Waiting for Kevin to approve: start a coding task: Fix X. Ask him out loud whether to go ahead.');
    expect(result.text).toBe('Shall I start it?');
  });

  it('settles a pending approval with a spoken yes before the model answers, and tells the model', async () => {
    const { service, chats, broker, startExecute } = setup([startCall, [{ content: 'Asking.' }], [{ content: 'Started it.' }]]);
    await service.respond({ requestId: 'r1', text: 'fix X please' }, () => {});
    const result = await service.respond({ requestId: 'r2', text: 'Yes, go ahead.' }, () => {});
    expect(startExecute).toHaveBeenCalledTimes(1);
    expect(broker.list()).toEqual([]);
    const user = chats[2].messages[chats[2].messages.length - 1];
    expect(user.role).toBe('user');
    expect(user.content).toContain('Yes, go ahead.');
    expect(user.content).toContain('[Approval handled: Kevin approved: start a coding task: Fix X. Done. Result: Started task t1.');
    expect(result.text).toBe('Started it.');
  });

  it('declines on a spoken no, and lets anything else through with the approval still pending', async () => {
    const { service, chats, broker, startExecute } = setup([startCall, [{ content: 'Asking.' }], [{ content: 'Sunny.' }], [{ content: 'Fine.' }]]);
    await service.respond({ requestId: 'r1', text: 'fix X please' }, () => {});
    await service.respond({ requestId: 'r2', text: 'What is the weather like today?' }, () => {});
    expect(broker.list()).toHaveLength(1);
    expect(chats[2].messages[chats[2].messages.length - 1].content).toBe('What is the weather like today?');
    await service.respond({ requestId: 'r3', text: 'No.' }, () => {});
    expect(startExecute).not.toHaveBeenCalled();
    expect(broker.list()).toEqual([]);
    expect(chats[3].messages[chats[3].messages.length - 1].content).toContain('Kevin declined: start a coding task: Fix X.');
  });

  it('adds the coding line to the system prompt only when tools are offered', async () => {
    const { service, chats } = setup([[{ content: 'Hi.' }]], { extra: 'You can hand coding work to the coding agent in: aiembodied (your own code). Use the coding tools.' });
    await service.respond({ requestId: 'r', text: 'hello' }, () => {});
    expect(chats[0].messages[0].content).toContain('You can hand coding work to the coding agent in: aiembodied (your own code).');
  });
});

describe('LocalVoiceService system turns', () => {
  function clock() {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  }

  it('answers a queued update as a marked note, not as a user message, and returns the note', async () => {
    const c = clock();
    const { service, chats } = setup([[{ content: 'Task t1 asks which port.' }]], { now: c.now });
    service.notify('Task t1 asks: "Which port?"', { urgent: true });
    c.advance(SYSTEM_COALESCE_MS);
    const result = await service.respond({ requestId: 's1', text: '', system: true }, () => {});
    const input = chats[0].messages[chats[0].messages.length - 1];
    expect(input.content).toBe(`${SYSTEM_NOTE_MARKER} Task t1 asks: "Which port?"`);
    expect(result.note).toBe(input.content);
    expect(result.text).toBe('Task t1 asks which port.');
    expect(service.systemStatus().pending).toBe(0);
  });

  it('does nothing when no update is waiting or it is too early', async () => {
    const c = clock();
    const { service, chats } = setup([], { now: c.now });
    expect(await service.respond({ requestId: 's1', text: '', system: true }, () => {})).toMatchObject({ cancelled: true, text: '' });
    service.notify('a');
    expect(await service.respond({ requestId: 's2', text: '', system: true }, () => {})).toMatchObject({ cancelled: true });
    expect(chats).toHaveLength(0);
    expect(service.systemStatus()).toMatchObject({ pending: 1, ready: false });
  });

  it('joins updates that arrive within five seconds into one turn', async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const { service, chats } = setup([[{ content: 'Two things.' }]], { now: () => Date.now(), onSystemReady: ready });
    service.notify('First update.');
    await vi.advanceTimersByTimeAsync(3000);
    service.notify('Second update.');
    await vi.advanceTimersByTimeAsync(SYSTEM_COALESCE_MS - 3000 - 1);
    expect(ready).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(ready).toHaveBeenCalledTimes(1);
    await service.respond({ requestId: 's', text: '', system: true }, () => {});
    expect(chats[0].messages[chats[0].messages.length - 1].content).toBe(`${SYSTEM_NOTE_MARKER} First update. Second update.`);
  });

  it('allows one system turn per 20 seconds, except for a question', async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const { service } = setup([[{ content: 'One.' }], [{ content: 'Two.' }], [{ content: 'Three.' }]], { now: () => Date.now(), onSystemReady: ready });
    service.notify('first');
    await vi.advanceTimersByTimeAsync(SYSTEM_COALESCE_MS);
    await service.respond({ requestId: 's1', text: '', system: true }, () => {});
    ready.mockClear();

    service.notify('second, routine');
    await vi.advanceTimersByTimeAsync(SYSTEM_COALESCE_MS + 100);
    expect(ready).not.toHaveBeenCalled();
    expect(service.systemStatus().ready).toBe(false);
    await vi.advanceTimersByTimeAsync(SYSTEM_MIN_GAP_MS);
    expect(ready).toHaveBeenCalledTimes(1);
    await service.respond({ requestId: 's2', text: '', system: true }, () => {});
    ready.mockClear();

    service.notify('a question', { urgent: true });
    await vi.advanceTimersByTimeAsync(SYSTEM_COALESCE_MS + 100);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it('puts the notes back when the system turn fails, and drops them once a turn completes', async () => {
    const c = clock();
    const { service, chats } = setup([new Error('llm down'), [{ content: 'Heads up.' }]], { now: c.now });
    service.notify('Task done.');
    c.advance(SYSTEM_COALESCE_MS);
    await expect(service.respond({ requestId: 's1', text: '', system: true }, () => {})).rejects.toThrow();
    expect(service.systemStatus()).toMatchObject({ pending: 1, ready: true, texts: ['Task done.'] });
    const result = await service.respond({ requestId: 's2', text: '', system: true }, () => {});
    expect(result.note).toBe(`${SYSTEM_NOTE_MARKER} Task done.`);
    expect(chats).toHaveLength(2);
    expect(service.systemStatus().pending).toBe(0);
  });

  it('puts the notes back at the front and re-arms the timer when the system turn is cancelled', async () => {
    vi.useFakeTimers();
    const ready = vi.fn();
    const { service } = setup([[{ content: 'Never heard.' }]], { now: () => Date.now(), onSystemReady: ready });
    service.notify('first');
    await vi.advanceTimersByTimeAsync(SYSTEM_COALESCE_MS);
    ready.mockClear();
    const turn = service.respond({ requestId: 's1', text: '', system: true }, () => {});
    service.notify('second');
    service.cancel();
    expect(await turn).toMatchObject({ cancelled: true });
    expect(service.systemStatus().texts).toEqual(['first', 'second']);
    await vi.advanceTimersByTimeAsync(SYSTEM_COALESCE_MS + SYSTEM_MIN_GAP_MS);
    expect(ready).toHaveBeenCalled();
  });

  it('keeps the note in the history as a marked, non-Kevin message', async () => {
    const c = clock();
    const { service, chats } = setup([[{ content: 'Heads up.' }], [{ content: 'Sure.' }]], { now: c.now });
    service.notify('Task done.');
    c.advance(SYSTEM_COALESCE_MS);
    await service.respond({ requestId: 's', text: '', system: true }, () => {});
    await service.respond({ requestId: 'u', text: 'Thanks' }, () => {});
    const history = chats[1].messages.slice(1, -1);
    expect(history[0]).toEqual({ role: 'user', content: `${SYSTEM_NOTE_MARKER} Task done.` });
    expect(history[1]).toEqual({ role: 'assistant', content: 'Heads up.' });
  });
});
