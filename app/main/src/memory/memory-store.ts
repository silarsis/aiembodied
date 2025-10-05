import { mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, { type Database as SqliteDatabase } from 'better-sqlite3';

export interface MemoryStoreOptions {
  filePath: string;
  readOnly?: boolean;
}

export interface SessionRecord {
  id: string;
  startedAt: number;
  title: string | null;
}

export interface MessageRecord {
  id: string;
  sessionId: string;
  role: string;
  ts: number;
  content: string;
  audioPath: string | null;
}

export interface SessionWithMessages extends SessionRecord {
  messages: MessageRecord[];
}

export interface MemoryStoreExport {
  sessions: SessionRecord[];
  messages: MessageRecord[];
  kv: Record<string, string>;
}

export type ImportStrategy = 'replace' | 'merge';

interface Migration {
  version: number;
  statements: string[];
}

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        started_at INTEGER NOT NULL,
        title TEXT NULL
      );`,
      `CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        ts INTEGER NOT NULL,
        content TEXT NOT NULL,
        audio_path TEXT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      );`,
      `CREATE TABLE IF NOT EXISTS kv (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );`,
      `CREATE INDEX IF NOT EXISTS messages_session_idx ON messages(session_id, ts);`,
      `CREATE INDEX IF NOT EXISTS sessions_started_at_idx ON sessions(started_at DESC);`,
    ],
  },
];

function runMigrations(db: SqliteDatabase) {
  const currentVersion = Number(db.pragma('user_version', { simple: true }));
  const pending = MIGRATIONS.filter((migration) => migration.version > currentVersion).sort(
    (a, b) => a.version - b.version,
  );

  for (const migration of pending) {
    const apply = db.transaction(() => {
      for (const statement of migration.statements) {
        db.prepare(statement).run();
      }

      db.pragma(`user_version = ${migration.version}`);
    });

    apply();
  }
}

function normalizeTitle(title: string | null | undefined): string | null {
  if (typeof title !== 'string') {
    return null;
  }

  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeAudioPath(audioPath: string | null | undefined): string | null {
  if (typeof audioPath !== 'string') {
    return null;
  }

  const trimmed = audioPath.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export class MemoryStore {
  private readonly db: SqliteDatabase;
  private disposed = false;

  constructor(options: MemoryStoreOptions) {
    if (!options.readOnly) {
      const directory = path.dirname(options.filePath);
      mkdirSync(directory, { recursive: true });
    }

    const db = new DatabaseConstructor(options.filePath, {
      readonly: options.readOnly ?? false,
      fileMustExist: options.readOnly ?? false,
    });

    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    if (!options.readOnly) {
      runMigrations(db);
    }

    this.db = db;
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.db.close();
    this.disposed = true;
  }

  createSession(session: SessionRecord): void {
    this.ensureOpen();

    const stmt = this.db.prepare<SessionRecord>(
      `INSERT INTO sessions (id, started_at, title)
       VALUES (@id, @startedAt, @title);`,
    );

    stmt.run({
      id: session.id,
      startedAt: session.startedAt,
      title: normalizeTitle(session.title),
    });
  }

  updateSessionTitle(sessionId: string, title: string | null | undefined): void {
    this.ensureOpen();

    const stmt = this.db.prepare<{
      title: string | null;
      id: string;
    }>(`UPDATE sessions SET title = @title WHERE id = @id;`);

    stmt.run({
      title: normalizeTitle(title),
      id: sessionId,
    });
  }

  deleteSession(sessionId: string): void {
    this.ensureOpen();

    const stmt = this.db.prepare(`DELETE FROM sessions WHERE id = ?;`);
    stmt.run(sessionId);
  }

  deleteMessages(messageIds: readonly string[]): void {
    this.ensureOpen();

    if (messageIds.length === 0) {
      return;
    }

    const stmt = this.db.prepare(`DELETE FROM messages WHERE id = ?;`);
    const run = this.db.transaction((ids: readonly string[]) => {
      for (const id of ids) {
        stmt.run(id);
      }
    });

    run(messageIds);
  }

  listSessions(options?: { limit?: number; offset?: number }): SessionRecord[] {
    this.ensureOpen();

    const limit = Math.max(0, options?.limit ?? 50);
    const offset = Math.max(0, options?.offset ?? 0);

    const stmt = this.db.prepare(
      `SELECT id, started_at as startedAt, title
       FROM sessions
       ORDER BY started_at DESC, id DESC
       LIMIT ? OFFSET ?;`,
    );

    const rows = stmt.all(limit, offset) as Array<{
      id: string;
      startedAt: number;
      title: string | null;
    }>;

    return rows.map((row) => ({
      id: String(row.id),
      startedAt: Number(row.startedAt),
      title: typeof row.title === 'string' ? row.title : null,
    }));
  }

  getSessionWithMessages(sessionId: string): SessionWithMessages | null {
    this.ensureOpen();

    const sessionStmt = this.db.prepare(
      `SELECT id, started_at as startedAt, title
       FROM sessions WHERE id = ?;`,
    );

    const session = sessionStmt.get(sessionId) as
      | { id: string; startedAt: number; title: string | null }
      | undefined;

    if (!session) {
      return null;
    }

    const messages = this.listMessages(sessionId);

    return {
      id: String(session.id),
      startedAt: Number(session.startedAt),
      title: typeof session.title === 'string' ? session.title : null,
      messages,
    };
  }

  listMessages(sessionId: string): MessageRecord[] {
    this.ensureOpen();

    const stmt = this.db.prepare(
      `SELECT id, session_id as sessionId, role, ts, content, audio_path as audioPath
       FROM messages WHERE session_id = ?
       ORDER BY ts ASC, id ASC;`,
    );

    const rows = stmt.all(sessionId) as Array<{
      id: string;
      sessionId: string;
      role: string;
      ts: number;
      content: string;
      audioPath: string | null;
    }>;

    return rows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.sessionId),
      role: String(row.role),
      ts: Number(row.ts),
      content: String(row.content),
      audioPath: typeof row.audioPath === 'string' ? row.audioPath : null,
    }));
  }

  appendMessage(message: MessageRecord): void {
    this.ensureOpen();

    const stmt = this.db.prepare<MessageRecord>(
      `INSERT INTO messages (id, session_id, role, ts, content, audio_path)
       VALUES (@id, @sessionId, @role, @ts, @content, @audioPath);`,
    );

    stmt.run({
      id: message.id,
      sessionId: message.sessionId,
      role: message.role,
      ts: message.ts,
      content: message.content,
      audioPath: normalizeAudioPath(message.audioPath),
    });
  }

  setValue(key: string, value: string): void {
    this.ensureOpen();

    const stmt = this.db.prepare<{ key: string; value: string }>(
      `INSERT INTO kv (key, value) VALUES (@key, @value)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
    );

    stmt.run({ key, value });
  }

  getValue(key: string): string | null {
    this.ensureOpen();

    const stmt = this.db.prepare(`SELECT value FROM kv WHERE key = ?;`);
    const row = stmt.get(key) as { value: string } | undefined;

    if (!row) {
      return null;
    }

    return row.value;
  }

  deleteValue(key: string): void {
    this.ensureOpen();

    const stmt = this.db.prepare(`DELETE FROM kv WHERE key = ?;`);
    stmt.run(key);
  }

  exportData(): MemoryStoreExport {
    this.ensureOpen();

    const sessionsStmt = this.db.prepare(
      `SELECT id, started_at as startedAt, title FROM sessions ORDER BY started_at ASC, id ASC;`,
    );
    const messagesStmt = this.db.prepare(
      `SELECT id, session_id as sessionId, role, ts, content, audio_path as audioPath
       FROM messages ORDER BY ts ASC, id ASC;`,
    );
    const kvStmt = this.db.prepare(`SELECT key, value FROM kv ORDER BY key ASC;`);

    const sessionRows = sessionsStmt.all() as Array<{
      id: string;
      startedAt: number;
      title: string | null;
    }>;

    const messageRows = messagesStmt.all() as Array<{
      id: string;
      sessionId: string;
      role: string;
      ts: number;
      content: string;
      audioPath: string | null;
    }>;

    const sessions = sessionRows.map((row) => ({
      id: String(row.id),
      startedAt: Number(row.startedAt),
      title: typeof row.title === 'string' ? row.title : null,
    }));

    const messages = messageRows.map((row) => ({
      id: String(row.id),
      sessionId: String(row.sessionId),
      role: String(row.role),
      ts: Number(row.ts),
      content: String(row.content),
      audioPath: typeof row.audioPath === 'string' ? row.audioPath : null,
    }));

    const kvEntries = kvStmt.all() as Array<{ key: string; value: string }>;
    const kv: Record<string, string> = {};

    for (const entry of kvEntries) {
      kv[entry.key] = entry.value;
    }

    return { sessions, messages, kv };
  }

  importData(data: MemoryStoreExport, options?: { strategy?: ImportStrategy }): void {
    this.ensureOpen();
    const strategy = options?.strategy ?? 'replace';

    const runImport = this.db.transaction(() => {
      if (strategy === 'replace') {
        this.db.prepare(`DELETE FROM messages;`).run();
        this.db.prepare(`DELETE FROM sessions;`).run();
        this.db.prepare(`DELETE FROM kv;`).run();
      }

      const insertSession = this.db.prepare<SessionRecord>(
        `INSERT INTO sessions (id, started_at, title)
         VALUES (@id, @startedAt, @title)
         ON CONFLICT(id) DO UPDATE SET started_at = excluded.started_at, title = excluded.title;`,
      );

      for (const session of data.sessions) {
        insertSession.run({
          id: session.id,
          startedAt: session.startedAt,
          title: normalizeTitle(session.title),
        });
      }

      const insertMessage = this.db.prepare<MessageRecord>(
        `INSERT INTO messages (id, session_id, role, ts, content, audio_path)
         VALUES (@id, @sessionId, @role, @ts, @content, @audioPath)
         ON CONFLICT(id) DO UPDATE SET
           session_id = excluded.session_id,
           role = excluded.role,
           ts = excluded.ts,
           content = excluded.content,
           audio_path = excluded.audio_path;`,
      );

      for (const message of data.messages) {
        insertMessage.run({
          id: message.id,
          sessionId: message.sessionId,
          role: message.role,
          ts: message.ts,
          content: message.content,
          audioPath: normalizeAudioPath(message.audioPath),
        });
      }

      const insertKv = this.db.prepare<{ key: string; value: string }>(
        `INSERT INTO kv (key, value) VALUES (@key, @value)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value;`,
      );

      for (const [key, value] of Object.entries(data.kv)) {
        insertKv.run({ key, value });
      }
    });

    runImport();
  }

  private ensureOpen() {
    if (this.disposed) {
      throw new Error('MemoryStore has been disposed.');
    }
  }
}
