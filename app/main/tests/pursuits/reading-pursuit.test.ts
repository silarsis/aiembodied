import { describe, expect, it, vi } from 'vitest';
import { runPursuit } from '../../src/pursuits/pursuit.js';
import { LlmGate, PursuitLlm } from '../../src/pursuits/pursuit-llm.js';
import { CHUNK_CHARS, MAX_CHUNKS, ReadingPursuit, readingGuidance, type ReadingPursuitDeps } from '../../src/pursuits/reading-pursuit.js';
import { FakeChat, MemoryNotes, executorFor, libraryTool, type Reply, type SeenCall } from './fakes.js';

const PAPER_LINK = 'https://academy.example/papers/memory-agents';

/** The character's side of a normal session: answers each kind of question the way a real one would. */
function script(options: { paperText?: string; next?: string } = {}) {
  return (call: SeenCall): Reply => {
    const last = call.messages[call.messages.length - 1];
    const user = [...call.messages].reverse().find((m) => m.role === 'user');
    const text = user && 'content' in user ? user.content : '';
    const afterTool = last?.role === 'tool';
    if (text.includes('What do you feel like reading about')) return { text: 'I want to read about how agents keep memories.' };
    if (text.includes('Look in the library now')) {
      return afterTool ? { text: 'Found a few.' } : { calls: [{ name: 'search_papers', arguments: { query: 'agent memory' } }] };
    }
    if (text.includes('Choose ONE thing')) return { text: `PICK: Memory for Agents | ${PAPER_LINK} | It is about exactly what I wonder about.` };
    if (text.includes('Fetch its full text')) {
      return afterTool ? { text: 'Got it.' } : { calls: [{ name: 'get_paper', arguments: { url: PAPER_LINK } }] };
    }
    if (text.includes('Write your notes')) {
      return { text: 'TAKEAWAY: Agents need forgetting too.\nOPINION: Convincing.\nKEVIN: Kevin is building a memory engine.\nQUESTIONS: How do they decide what fades? | Is it cheap?' };
    }
    if (text.includes('Do you want to read more')) return { text: options.next ?? 'NEXT: stop\nTELL: Kevin, there is a paper on forgetting you would like.' };
    return { text: 'summary so far' };
  };
}

function setup(options: { paperText?: string; next?: string; respond?: (call: SeenCall, index: number) => Reply; toolCalls?: number } = {}) {
  const chat = new FakeChat(options.respond ?? script(options));
  const searches: unknown[] = [];
  const tools = [
    libraryTool('search_papers', (params) => {
      searches.push(params);
      return `1. Memory for Agents ${PAPER_LINK}\n2. Other Paper https://academy.example/papers/other`;
    }),
    libraryTool('get_paper', () => options.paperText ?? 'The full text about memory. '.repeat(10)),
  ];
  const notes = new MemoryNotes();
  const told: string[] = [];
  const saved: string[] = [];
  let calls = 0;
  const llm = new PursuitLlm({
    chat: () => chat,
    gate: new LlmGate(1),
    system: () => `Sage persona.\n\n${readingGuidance('Sage', 'bookshelf')}`,
    execute: executorFor(tools),
    allowToolCall: () => (calls < (options.toolCalls ?? 30) ? ((calls += 1), true) : false),
  });
  const deps: ReadingPursuitDeps = {
    avatarId: 'sage',
    avatarName: 'Sage',
    stationId: 'station-1',
    objectName: 'bookshelf',
    llm,
    tools,
    habits: 'Likes quiet corners.',
    recentLines: () => ['Kevin: I am working on memory.', 'You: Sounds hard.'],
    memory: { brief: async () => 'Kevin builds embodied assistants.' },
    notes,
    saveToMemory: (note) => saved.push(note.title),
    tell: (text) => told.push(text),
  };
  const pursuit = new ReadingPursuit(deps);
  return { chat, pursuit, notes, told, saved, searches, deps };
}

describe('ReadingPursuit', () => {
  it('runs want, query, choose, consume and note, then tells Kevin through the inbox path', async () => {
    const { chat, pursuit, notes, told, saved, searches } = setup();
    const result = await runPursuit(pursuit, { signal: new AbortController().signal });
    expect(result).toMatchObject({ end: 'finished', items: 1 });

    // The model made the library call itself.
    expect(searches).toEqual([{ query: 'agent memory' }]);
    // The wish carried the persona, habits, recent lines and the memory brief.
    const wish = chat.userAt(0);
    expect(wish).toContain('Likes quiet corners.');
    expect(wish).toContain('Kevin: I am working on memory.');
    expect(wish).toContain('Kevin builds embodied assistants.');
    expect(JSON.stringify(chat.seen[0].messages[0])).toContain('Sage persona.');
    // The search round offered the station tools; the choice round did not.
    expect(chat.seen[1].tools.map((t) => t.function.name)).toEqual(['search_papers', 'get_paper']);
    const chooseIndex = chat.seen.findIndex((c) => JSON.stringify(c.messages).includes('Choose ONE thing'));
    expect(chat.seen[chooseIndex].tools).toEqual([]);

    // The note is in its own voice, with the link, and went to memory too.
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({
      avatarId: 'sage',
      stationId: 'station-1',
      title: 'Memory for Agents',
      link: PAPER_LINK,
      takeaway: 'Agents need forgetting too.',
      opinion: 'Convincing.',
      connection: 'Kevin is building a memory engine.',
      questions: ['How do they decide what fades?', 'Is it cheap?'],
      curiosity: 'I want to read about how agents keep memories.',
      partial: false,
    });
    expect(saved).toEqual(['Memory for Agents']);
    expect(told).toEqual(['Kevin, there is a paper on forgetting you would like.']);
  });

  it('goes on to another item when it wants more', async () => {
    let round = 0;
    const base = script({ next: 'NEXT: continue\nTELL: none' });
    const { pursuit, notes, told } = setup({
      respond: (call, index) => {
        const user = [...call.messages].reverse().find((m) => m.role === 'user');
        const text = user && 'content' in user ? user.content : '';
        if (text.includes('Do you want to read more')) return { text: round++ === 0 ? 'NEXT: continue\nTELL: none' : 'NEXT: stop\nTELL: none' };
        return base(call, index);
      },
    });
    const result = await runPursuit(pursuit, { signal: new AbortController().signal });
    expect(result.items).toBe(2);
    expect(notes.notes).toHaveLength(2);
    expect(told).toEqual([]);
  });

  it('refines the search when the character asks to look again', async () => {
    let chooses = 0;
    const base = script();
    const { pursuit, searches, chat } = setup({
      respond: (call, index) => {
        const user = [...call.messages].reverse().find((m) => m.role === 'user');
        const text = user && 'content' in user ? user.content : '';
        if (text.includes('Choose ONE thing') && chooses++ === 0) return { text: 'REFINE: papers on forgetting in memory systems' };
        return base(call, index);
      },
    });
    await runPursuit(pursuit, { signal: new AbortController().signal });
    expect(searches).toHaveLength(2);
    const second = chat.seen.find((c) => JSON.stringify(c.messages).includes('papers on forgetting in memory systems'));
    expect(second).toBeDefined();
  });

  it('reads a long text in chunks with a running summary, bounded', async () => {
    const paperText = 'x'.repeat(CHUNK_CHARS * (MAX_CHUNKS + 2));
    const { chat, pursuit, notes } = setup({ paperText });
    await runPursuit(pursuit, { signal: new AbortController().signal });
    const parts = chat.seen.filter((c) => JSON.stringify(c.messages).includes('running summary'));
    expect(parts).toHaveLength(MAX_CHUNKS);
    // Each prompt fits: one chunk plus the summary and the question.
    for (const part of parts) expect(JSON.stringify(part.messages).length).toBeLessThan(CHUNK_CHARS + 2500);
    // The second part sees the first part's summary, not the first part's text.
    expect(JSON.stringify(parts[1].messages)).toContain('summary so far');
    expect(notes.notes[0].takeaway).toContain(`I only read the first ${MAX_CHUNKS} of ${MAX_CHUNKS + 2} parts.`);
  });

  it('stops when two wishes in a row find nothing', async () => {
    const { pursuit, notes, chat } = setup({
      respond: (call) => {
        const user = [...call.messages].reverse().find((m) => m.role === 'user');
        const text = user && 'content' in user ? user.content : '';
        if (text.includes('What do you feel like')) return { text: 'I want to read something.' };
        if (text.includes('Look in the library now')) return { text: 'There is nothing I can think of.' };
        return { text: 'NEXT: continue' };
      },
    });
    const result = await runPursuit(pursuit, { signal: new AbortController().signal });
    expect(result.end).toBe('finished');
    expect(notes.notes).toHaveLength(0);
    // Two empty wishes: no "do you want to read more" question was needed after the second.
    expect(chat.seen.filter((c) => JSON.stringify(c.messages).includes('Do you want to read more'))).toHaveLength(1);
  });

  it('limits tool calls for the whole session', async () => {
    const { pursuit, searches } = setup({ toolCalls: 1 });
    await runPursuit(pursuit, { signal: new AbortController().signal });
    // The search used the one call; fetching the paper was refused, so the character read the search results instead.
    expect(searches).toHaveLength(1);
  });

  it('keeps what it had read when the session is cut short mid-note (partial note)', async () => {
    const controller = new AbortController();
    const { chat, pursuit, notes, saved } = setup({ paperText: 'Short paper text about forgetting.' });
    // The model call that would write the note never returns until Kevin starts talking.
    const noteCall = 6;
    chat.holdOn.add(noteCall);
    const running = runPursuit(pursuit, { signal: controller.signal });
    await vi.waitFor(() => expect(chat.seen.length).toBeGreaterThan(noteCall));
    controller.abort();
    const result = await running;
    expect(result.end).toBe('aborted');
    expect(JSON.stringify(chat.seen[noteCall].messages)).toContain('Write your notes');
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({ title: 'Memory for Agents', partial: true });
    expect(notes.notes[0].takeaway).toContain('Short paper text about forgetting.');
    expect(saved).toEqual(['Memory for Agents']);
  });

  it('writes nothing when it is cut short before reading anything', async () => {
    const controller = new AbortController();
    const { chat, pursuit, notes, told } = setup();
    chat.holdOn.add(0);
    const running = runPursuit(pursuit, { signal: controller.signal });
    await vi.waitFor(() => expect(chat.seen.length).toBe(1));
    controller.abort();
    expect((await running).end).toBe('aborted');
    expect(notes.notes).toHaveLength(0);
    expect(told).toEqual([]);
  });

  it('tells at most twice per session', async () => {
    const base = script();
    const { pursuit, told } = setup({
      respond: (call, index) => {
        const user = [...call.messages].reverse().find((m) => m.role === 'user');
        const text = user && 'content' in user ? user.content : '';
        if (text.includes('Do you want to read more')) return { text: 'NEXT: continue\nTELL: Look at this.' };
        return base(call, index);
      },
    });
    await runPursuit(pursuit, { signal: new AbortController().signal, maxItems: 4 });
    expect(told).toHaveLength(2);
  });
});

describe('LlmGate', () => {
  it('runs one call at a time and releases a waiting call that is aborted', async () => {
    const gate = new LlmGate(1);
    const order: string[] = [];
    let release!: () => void;
    const first = gate.run(new AbortController().signal, () => new Promise<void>((resolve) => ((release = resolve), order.push('first start'))));
    const controller = new AbortController();
    const second = gate.run(controller.signal, async () => void order.push('second'));
    const third = gate.run(new AbortController().signal, async () => void order.push('third'));
    controller.abort();
    await expect(second).rejects.toBeDefined();
    release();
    await first;
    await third;
    expect(order).toEqual(['first start', 'third']);
  });
});
