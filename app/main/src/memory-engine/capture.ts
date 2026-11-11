/**
 * The one place conversation lands in long-term memory. ConversationManager's sessions and
 * messages (every backend: local voice, OpenAI Realtime, typed text) and the local voice's tool
 * calls come through here and are queued for the memory engine.
 */
import { randomUUID } from 'node:crypto';
import type { MemoryEngineMessage, MemoryEngineSession } from './client.js';
import type { OutboxItem } from './outbox.js';

export interface CaptureAgent {
  /** The character's name, as the memory engine stores and shows it. */
  name: string;
  /** A stable id for the character, when there is one (the VRM model id). */
  id?: string | null;
}

export interface CapturedSession {
  id: string;
  startedAt: number;
  title?: string | null;
}

export interface CapturedMessage {
  id: string;
  sessionId: string;
  role: string;
  content: string;
  ts: number;
  /** Who said it: an avatar id or 'user' (see ConversationMessage.speaker). */
  speaker?: string | null;
}

export interface CapturedToolCall {
  sessionId: string;
  name: string;
  arguments: unknown;
  result: string;
  ok: boolean;
  at: number;
}

/** What the importer needs from the app's SQLite conversation archive. */
export interface ConversationArchive {
  listSessions(options?: { limit?: number }): Array<{ id: string; startedAt: number; title: string | null }>;
  listMessages(sessionId: string): Array<{ id: string; sessionId: string; role: string; ts: number; content: string; speaker?: string | null }>;
  getValue(key: string): string | null;
  setValue(key: string, value: string): void;
}

type Logger = {
  info: (message: string, data?: Record<string, unknown>) => void;
  debug?: (message: string, data?: Record<string, unknown>) => void;
};

export interface MemoryCaptureOptions {
  outbox: { enqueue(item: OutboxItem): void };
  /** The character, by avatar id when one is given; no id means the default avatar. */
  agent: (avatarId?: string) => CaptureAgent;
  channel?: string;
  logger?: Logger;
}

export const IMPORTED_KEY = 'memoryEngine:importedAt';

const INDEXED_ROLES = new Set(['user', 'assistant']);

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

export class MemoryCapture {
  private readonly outbox: MemoryCaptureOptions['outbox'];

  private readonly agent: (avatarId?: string) => CaptureAgent;

  private readonly channel: string;

  private readonly logger?: Logger;

  constructor(options: MemoryCaptureOptions) {
    this.outbox = options.outbox;
    this.agent = options.agent;
    this.channel = options.channel ?? 'voice';
    this.logger = options.logger;
  }

  recordSession(session: CapturedSession): void {
    this.outbox.enqueue({ kind: 'session', id: session.id, session: this.sessionBody(session) });
  }

  /** User and assistant messages. System notices ("wake word detected") are UI, not memory. */
  recordMessage(message: CapturedMessage): void {
    if (!INDEXED_ROLES.has(message.role) || !message.content.trim()) {
      return;
    }
    this.outbox.enqueue({
      kind: 'message',
      message: {
        id: message.id,
        session_id: message.sessionId,
        role: message.role as MemoryEngineMessage['role'],
        content: message.content,
        created_at: iso(message.ts),
        // The engine labels user lines with `speaker ?? 'User'`, so the plain user is sent as none.
        ...(message.speaker && message.speaker !== 'user' ? { speaker: message.speaker } : {}),
      },
    });
  }

  recordToolCall(call: CapturedToolCall): void {
    this.outbox.enqueue({
      kind: 'message',
      message: {
        id: randomUUID(),
        session_id: call.sessionId,
        role: 'tool',
        content: call.result,
        created_at: iso(call.at),
        tool: { name: call.name, arguments: call.arguments ?? null, ok: call.ok },
      },
    });
  }

  /**
   * Queue the conversations already in the app's SQLite archive, once. Message ids are kept, so
   * a repeat (after the flag is lost) changes nothing on the engine's side. The character of old
   * sessions isn't known; they go in under the current one with meta.imported set.
   */
  importArchive(archive: ConversationArchive): number {
    if (archive.getValue(IMPORTED_KEY)) {
      return 0;
    }
    let count = 0;
    const sessions = archive.listSessions({ limit: Number.MAX_SAFE_INTEGER });
    for (const session of [...sessions].sort((a, b) => a.startedAt - b.startedAt)) {
      const body = this.sessionBody(session);
      body.meta = { ...body.meta, imported: true };
      this.outbox.enqueue({ kind: 'session', id: session.id, session: body });
      for (const message of archive.listMessages(session.id)) {
        if (INDEXED_ROLES.has(message.role) && message.content.trim()) {
          this.recordMessage(message);
          count += 1;
        }
      }
    }
    archive.setValue(IMPORTED_KEY, new Date().toISOString());
    this.logger?.info('Queued conversation history for the memory engine', { sessions: sessions.length, messages: count });
    return count;
  }

  private sessionBody(session: CapturedSession): MemoryEngineSession {
    const agent = this.agent();
    return {
      started_at: iso(session.startedAt),
      agent: agent.name,
      channel: this.channel,
      title: session.title ?? null,
      meta: agent.id ? { agent_id: agent.id } : {},
    };
  }
}
