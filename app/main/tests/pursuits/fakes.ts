/** Fakes for the pursuit tests: a scripted chat model, library tools and an in-memory note store. */
import type { ChatMessage, LlmStreamPart, LlmToolDefinition } from '../../src/local-voice/local-llm-client.js';
import type { ChatClient } from '../../src/local-voice/voice-engines.js';
import type { RegisteredTool } from '../../src/tools/tool-registry.js';
import type { NewReadingNote, ReadingNoteStore } from '../../src/pursuits/types.js';
import type { ReadingNote } from '../../src/shared/pursuits/types.js';

export interface Reply {
  text?: string;
  calls?: Array<{ name: string; arguments?: unknown }>;
}

export interface SeenCall {
  messages: ChatMessage[];
  tools: LlmToolDefinition[];
}

/**
 * A chat client that answers from a function of the call so far. `respond` sees the last user message and the
 * tools offered; `hold` (when set) keeps a call open until the signal aborts, like a slow server.
 */
export class FakeChat implements ChatClient {
  readonly baseUrl = 'http://fake';
  readonly model = 'fake';
  readonly flavor = 'llama-server' as const;
  readonly seen: SeenCall[] = [];
  /** Calls to stop on until the signal aborts (by 0-based call number). */
  holdOn = new Set<number>();
  private n = 0;

  constructor(private readonly respond: (call: SeenCall, index: number) => Reply) {}

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async *streamChat(messages: ChatMessage[], options: { signal?: AbortSignal; tools?: LlmToolDefinition[] } = {}): AsyncGenerator<LlmStreamPart> {
    const index = this.n++;
    const call: SeenCall = { messages: structuredClone(messages), tools: options.tools ?? [] };
    this.seen.push(call);
    if (this.holdOn.has(index)) {
      await new Promise<void>((_resolve, reject) => {
        if (options.signal?.aborted) reject(options.signal.reason);
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true });
      });
    }
    options.signal?.throwIfAborted();
    const reply = this.respond(call, index);
    if (reply.text) yield { type: 'text', text: reply.text };
    if (reply.calls?.length) {
      yield {
        type: 'tool_calls',
        calls: reply.calls.map((c, i) => ({ id: `call_${index}_${i}`, name: c.name, arguments: JSON.stringify(c.arguments ?? {}) })),
      };
    }
  }

  /** The last user message of the nth call. */
  userAt(index: number): string {
    const user = this.seen[index]?.messages.filter((m) => m.role === 'user').pop();
    return user && 'content' in user ? user.content : '';
  }
}

export function libraryTool(name: string, run: (params: unknown) => unknown, overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    id: `srv-1:${name}`,
    serverId: 'srv-1',
    toolName: name,
    description: `The ${name} tool`,
    inputSchema: { type: 'object', properties: {} },
    enabled: true,
    confirmationLevel: 'none',
    readOnly: true,
    execute: async (params) => run(params),
    ...overrides,
  };
}

/** An executor over a list of tools, like ToolRegistry.execute. */
export function executorFor(tools: RegisteredTool[]) {
  return async (toolId: string, params: unknown) => {
    const tool = tools.find((candidate) => candidate.id === toolId);
    if (!tool) throw new Error(`Tool not found: ${toolId}`);
    try {
      return { success: true, data: await tool.execute(params), durationMs: 1 };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error), durationMs: 1 };
    }
  };
}

export class MemoryNotes implements ReadingNoteStore {
  readonly notes: ReadingNote[] = [];
  private id = 0;

  addReadingNote(note: NewReadingNote): ReadingNote {
    const saved: ReadingNote = { ...note, id: `n${++this.id}`, createdAt: note.createdAt ?? 1000 + this.id };
    this.notes.push(saved);
    return saved;
  }

  listReadingNotes(avatarId: string, limit = 20): ReadingNote[] {
    return this.notes.filter((note) => note.avatarId === avatarId).reverse().slice(0, limit);
  }
}
