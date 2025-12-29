import { mkdirSync } from 'node:fs';
import path from 'node:path';
import DatabaseConstructor, { type Database as SqliteDatabase } from 'better-sqlite3';
import { Buffer } from 'node:buffer';

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
  vrmModels: SerializedVrmModel[];
  vrmaAnimations: VrmAnimationRecord[];
}

export type ImportStrategy = 'replace' | 'merge';

interface Migration {
  version: number;
  statements: string[];
}

export interface VrmModelRecord {
  id: string;
  name: string;
  createdAt: number;
  filePath: string;
  fileSha: string;
  version: string;
  thumbnail: Buffer | null;
  description: string | null;
}

interface SerializedVrmModel extends Omit<VrmModelRecord, 'thumbnail'> {
  thumbnail: string | null;
}

export interface VrmAnimationRecord {
  id: string;
  name: string;
  createdAt: number;
  filePath: string;
  fileSha: string;
  duration: number | null;
  fps: number | null;
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

{
version: 2,
statements: [
`CREATE TABLE IF NOT EXISTS vrm_models (
id TEXT PRIMARY KEY,
name TEXT NOT NULL,
created_at INTEGER NOT NULL,
file_path TEXT NOT NULL,
file_sha TEXT NOT NULL,
version TEXT NOT NULL,
thumbnail BLOB NULL
);`,
`CREATE INDEX IF NOT EXISTS vrm_models_created_idx ON vrm_models(created_at DESC, id DESC);`,
],
},
{
version: 3,
statements: [
`CREATE TABLE IF NOT EXISTS vrma_animations (
id TEXT PRIMARY KEY,
name TEXT NOT NULL,
created_at INTEGER NOT NULL,
file_path TEXT NOT NULL,
file_sha TEXT NOT NULL,
duration REAL NULL,
fps REAL NULL
);`,
`CREATE INDEX IF NOT EXISTS vrma_animations_created_idx ON vrma_animations(created_at DESC, id DESC);`,
],
},
{
version: 4,
statements: [`ALTER TABLE vrm_models ADD COLUMN description TEXT NULL;`],
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

const ACTIVE_VRM_KEY = 'avatar.activeVrmId';

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

  createVrmModel(model: VrmModelRecord): void {
    this.ensureOpen();

    const stmt = this.db.prepare<VrmModelRecord>(
      `INSERT INTO vrm_models (id, name, created_at, file_path, file_sha, version, thumbnail, description)
       VALUES (@id, @name, @createdAt, @filePath, @fileSha, @version, @thumbnail, @description);`,
    );

    stmt.run({
      id: model.id,
      name: model.name,
      createdAt: model.createdAt,
      filePath: model.filePath,
      fileSha: model.fileSha,
      version: model.version,
      thumbnail: model.thumbnail ?? null,
      description: model.description ?? null,
    });
  }

  listVrmModels(): VrmModelRecord[] {
    this.ensureOpen();

    const stmt = this.db.prepare(
      `SELECT id, name, created_at as createdAt, file_path as filePath, file_sha as fileSha, version, thumbnail, description
       FROM vrm_models
       ORDER BY created_at DESC, id DESC;`,
    );

    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      createdAt: number;
      filePath: string;
      fileSha: string;
      version: string;
      thumbnail: Buffer | null;
      description: string | null;
    }>;

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.createdAt),
      filePath: String(row.filePath),
      fileSha: String(row.fileSha),
      version: String(row.version),
      thumbnail: row.thumbnail ? Buffer.from(row.thumbnail) : null,
      description: row.description ? String(row.description) : null,
    }));
  }

  getVrmModel(id: string): VrmModelRecord | null {
    this.ensureOpen();

    const stmt = this.db.prepare(
      `SELECT id, name, created_at as createdAt, file_path as filePath, file_sha as fileSha, version, thumbnail, description
       FROM vrm_models WHERE id = ?;`,
    );

    const row = stmt.get(id) as
      | {
          id: string;
          name: string;
          createdAt: number;
          filePath: string;
          fileSha: string;
          version: string;
          thumbnail: Buffer | null;
          description: string | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.createdAt),
      filePath: String(row.filePath),
      fileSha: String(row.fileSha),
      version: String(row.version),
      thumbnail: row.thumbnail ? Buffer.from(row.thumbnail) : null,
      description: row.description ? String(row.description) : null,
    };
  }

  deleteVrmModel(modelId: string): void {
    this.ensureOpen();

    const stmt = this.db.prepare(`DELETE FROM vrm_models WHERE id = ?;`);
    stmt.run(modelId);

    if (this.getActiveVrmModelId() === modelId) {
      this.setActiveVrmModel(null);
    }
  }

  updateVrmModelThumbnail(modelId: string, thumbnail: Buffer): void {
    this.ensureOpen();

    const stmt = this.db.prepare(`UPDATE vrm_models SET thumbnail = ? WHERE id = ?;`);
    stmt.run(thumbnail, modelId);
  }

  updateVrmModelDescription(modelId: string, description: string): void {
    this.ensureOpen();

    const stmt = this.db.prepare(`UPDATE vrm_models SET description = ? WHERE id = ?;`);
    stmt.run(description, modelId);
  }

  createVrmAnimation(animation: VrmAnimationRecord): void {
    this.ensureOpen();

    const stmt = this.db.prepare<VrmAnimationRecord>(
      `INSERT INTO vrma_animations (id, name, created_at, file_path, file_sha, duration, fps)
       VALUES (@id, @name, @createdAt, @filePath, @fileSha, @duration, @fps);`,
    );

    stmt.run({
      id: animation.id,
      name: animation.name,
      createdAt: animation.createdAt,
      filePath: animation.filePath,
      fileSha: animation.fileSha,
      duration: animation.duration ?? null,
      fps: animation.fps ?? null,
    });
  }

  listVrmAnimations(): VrmAnimationRecord[] {
    this.ensureOpen();

    const stmt = this.db.prepare(
      `SELECT id, name, created_at as createdAt, file_path as filePath, file_sha as fileSha, duration, fps
       FROM vrma_animations
       ORDER BY created_at DESC, id DESC;`,
    );

    const rows = stmt.all() as Array<{
      id: string;
      name: string;
      createdAt: number;
      filePath: string;
      fileSha: string;
      duration: number | null;
      fps: number | null;
    }>;

    return rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.createdAt),
      filePath: String(row.filePath),
      fileSha: String(row.fileSha),
      duration: typeof row.duration === 'number' ? row.duration : null,
      fps: typeof row.fps === 'number' ? row.fps : null,
    }));
  }

  getVrmAnimation(id: string): VrmAnimationRecord | null {
    this.ensureOpen();

    const stmt = this.db.prepare(
      `SELECT id, name, created_at as createdAt, file_path as filePath, file_sha as fileSha, duration, fps
       FROM vrma_animations WHERE id = ?;`,
    );

    const row = stmt.get(id) as
      | {
          id: string;
          name: string;
          createdAt: number;
          filePath: string;
          fileSha: string;
          duration: number | null;
          fps: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.createdAt),
      filePath: String(row.filePath),
      fileSha: String(row.fileSha),
      duration: typeof row.duration === 'number' ? row.duration : null,
      fps: typeof row.fps === 'number' ? row.fps : null,
    };
  }

  deleteVrmAnimation(animationId: string): void {
    this.ensureOpen();

    const stmt = this.db.prepare(`DELETE FROM vrma_animations WHERE id = ?;`);
    stmt.run(animationId);
  }

  updateVrmAnimation(animationId: string, record: VrmAnimationRecord): void {
    this.ensureOpen();

    const stmt = this.db.prepare<VrmAnimationRecord>(
      `UPDATE vrma_animations SET name = @name, created_at = @createdAt, file_path = @filePath, file_sha = @fileSha, duration = @duration, fps = @fps WHERE id = @id;`,
    );
    stmt.run({
      id: animationId,
      name: record.name,
      createdAt: record.createdAt,
      filePath: record.filePath,
      fileSha: record.fileSha,
      duration: record.duration ?? null,
      fps: record.fps ?? null,
    });
  }

  getActiveVrmModelId(): string | null {
    return this.getValue(ACTIVE_VRM_KEY);
  }

  setActiveVrmModel(modelId: string | null): void {
    if (!modelId) {
      this.deleteValue(ACTIVE_VRM_KEY);
      return;
    }

    this.setValue(ACTIVE_VRM_KEY, modelId);
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
    const vrmModelsStmt = this.db.prepare(
      `SELECT id, name, created_at as createdAt, file_path as filePath, file_sha as fileSha, version, thumbnail, description
       FROM vrm_models ORDER BY created_at ASC, id ASC;`,
    );
    const vrmaAnimationsStmt = this.db.prepare(
      `SELECT id, name, created_at as createdAt, file_path as filePath, file_sha as fileSha, duration, fps
       FROM vrma_animations ORDER BY created_at ASC, id ASC;`,
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

    const vrmModelRows = vrmModelsStmt.all() as Array<{
      id: string;
      name: string;
      createdAt: number;
      filePath: string;
      fileSha: string;
      version: string;
      thumbnail: Buffer | null;
      description: string | null;
    }>;
    const vrmaAnimationRows = vrmaAnimationsStmt.all() as Array<{
      id: string;
      name: string;
      createdAt: number;
      filePath: string;
      fileSha: string;
      duration: number | null;
      fps: number | null;
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

    const vrmModels: SerializedVrmModel[] = vrmModelRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.createdAt),
      filePath: String(row.filePath),
      fileSha: String(row.fileSha),
      version: String(row.version),
      thumbnail: row.thumbnail ? Buffer.from(row.thumbnail).toString('base64') : null,
      description: row.description ? String(row.description) : null,
    }));

    const vrmaAnimations: VrmAnimationRecord[] = vrmaAnimationRows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      createdAt: Number(row.createdAt),
      filePath: String(row.filePath),
      fileSha: String(row.fileSha),
      duration: typeof row.duration === 'number' ? row.duration : null,
      fps: typeof row.fps === 'number' ? row.fps : null,
    }));

    const kvEntries = kvStmt.all() as Array<{ key: string; value: string }>;
    const kv: Record<string, string> = {};

    for (const entry of kvEntries) {
      kv[entry.key] = entry.value;
    }

    return { sessions, messages, kv, vrmModels, vrmaAnimations };
  }

  importData(data: MemoryStoreExport, options?: { strategy?: ImportStrategy }): void {
    this.ensureOpen();
    const strategy = options?.strategy ?? 'replace';

    const runImport = this.db.transaction(() => {
      if (strategy === 'replace') {
        this.db.prepare(`DELETE FROM messages;`).run();
        this.db.prepare(`DELETE FROM sessions;`).run();
        this.db.prepare(`DELETE FROM kv;`).run();
        this.db.prepare(`DELETE FROM vrm_models;`).run();
        this.db.prepare(`DELETE FROM vrma_animations;`).run();
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

      const insertVrmModel = this.db.prepare<VrmModelRecord>(
        `INSERT INTO vrm_models (id, name, created_at, file_path, file_sha, version, thumbnail, description)
         VALUES (@id, @name, @createdAt, @filePath, @fileSha, @version, @thumbnail, @description)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at,
           file_path = excluded.file_path,
           file_sha = excluded.file_sha,
           version = excluded.version,
           thumbnail = excluded.thumbnail,
           description = excluded.description;`,
      );

      for (const model of data.vrmModels ?? []) {
        insertVrmModel.run({
          id: model.id,
          name: model.name,
          createdAt: model.createdAt,
          filePath: model.filePath,
          fileSha: model.fileSha,
          version: model.version,
          thumbnail: model.thumbnail ? Buffer.from(model.thumbnail, 'base64') : null,
          description: model.description ?? null,
        });
      }

      const insertVrmAnimation = this.db.prepare<VrmAnimationRecord>(
        `INSERT INTO vrma_animations (id, name, created_at, file_path, file_sha, duration, fps)
         VALUES (@id, @name, @createdAt, @filePath, @fileSha, @duration, @fps)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           created_at = excluded.created_at,
           file_path = excluded.file_path,
           file_sha = excluded.file_sha,
           duration = excluded.duration,
           fps = excluded.fps;`,
      );

      for (const animation of data.vrmaAnimations ?? []) {
        insertVrmAnimation.run({
          id: animation.id,
          name: animation.name,
          createdAt: animation.createdAt,
          filePath: animation.filePath,
          fileSha: animation.fileSha,
          duration: animation.duration ?? null,
          fps: animation.fps ?? null,
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
