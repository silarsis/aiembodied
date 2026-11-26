import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MemoryStore } from '../../src/memory/memory-store.js';
import { READING_NOTES_TOOL_ID, createReadingNotesTool, formatReadingNotes, readingFact, readingFactText, readingOutboxItem } from '../../src/pursuits/reading-memory.js';
import type { NewReadingNote } from '../../src/pursuits/types.js';
import type { ReadingNote } from '../../src/shared/pursuits/types.js';

const dirs: string[] = [];
const stores: MemoryStore[] = [];
async function createStore(): Promise<MemoryStore> {
  const directory = await mkdtemp(path.join(tmpdir(), 'reading-notes-'));
  dirs.push(directory);
  const store = new MemoryStore({ filePath: path.join(directory, 'memory.db') });
  stores.push(store);
  return store;
}
afterEach(async () => {
  for (const store of stores.splice(0)) store.dispose();
  for (const directory of dirs.splice(0)) await rm(directory, { recursive: true, force: true });
});

const base: NewReadingNote = {
  avatarId: 'sage',
  stationId: 'station-1',
  title: 'Memory for Agents',
  link: 'https://academy.example/p/1',
  takeaway: 'Forgetting matters.',
  opinion: 'Convincing.',
  connection: 'Kevin builds a memory engine.',
  questions: ['How does it fade?', 'Is it cheap?'],
  curiosity: 'I want to read about memory.',
  partial: false,
};

describe('reading notes store', () => {
  it('is created by migration 12 and keeps a note whole', async () => {
    const store = await createStore();
    expect(Number(store.database.pragma('user_version', { simple: true }))).toBeGreaterThanOrEqual(12);
    const saved = store.addReadingNote({ ...base, createdAt: 5 });
    expect(saved).toMatchObject({ ...base, createdAt: 5 });
    expect(saved.id).toBeTruthy();
    expect(store.listReadingNotes('sage')).toEqual([saved]);
  });

  it('lists one avatar\'s notes newest first, within the limit', async () => {
    const store = await createStore();
    store.addReadingNote({ ...base, title: 'old', createdAt: 1 });
    store.addReadingNote({ ...base, title: 'new', createdAt: 3, partial: true });
    store.addReadingNote({ ...base, title: 'mid', createdAt: 2 });
    store.addReadingNote({ ...base, avatarId: 'echo', title: 'not sage' });
    expect(store.listReadingNotes('sage').map((n) => n.title)).toEqual(['new', 'mid', 'old']);
    expect(store.listReadingNotes('sage', 2)).toHaveLength(2);
    expect(store.listReadingNotes('sage')[0].partial).toBe(true);
    expect(store.listReadingNotes('nobody')).toEqual([]);
  });

  it('forgets an avatar\'s notes', async () => {
    const store = await createStore();
    store.addReadingNote(base);
    store.addReadingNote({ ...base, avatarId: 'echo' });
    expect(store.deleteReadingNotes('sage')).toBe(1);
    expect(store.listReadingNotes('sage')).toEqual([]);
    expect(store.listReadingNotes('echo')).toHaveLength(1);
  });
});

describe('reading notes in memory', () => {
  const note: ReadingNote = { ...base, id: 'n1', createdAt: 1_700_000_000_000 };

  it('writes a private agent fact about the note, signed by the character', () => {
    const fact = readingFact(note, 'Sage', 'qwen');
    expect(fact).toMatchObject({ subject: 'reading', author: 'agent', agent: 'Sage', private: true, model: 'qwen' });
    expect(fact.text).toContain('Sage read "Memory for Agents" (https://academy.example/p/1).');
    expect(fact.text).toContain('Takeaway: Forgetting matters.');
    expect(fact.text).toContain('Link to Kevin: Kevin builds a memory engine.');
    expect(fact.text).toContain('Open questions: How does it fade? Is it cheap?');
    expect(readingOutboxItem(note, 'Sage')).toMatchObject({ kind: 'fact' });
    expect(readingFactText({ ...note, partial: true }, 'Sage')).toContain('(cut short)');
  });

  it('my_reading_notes is a read-only tool that answers for the calling avatar', async () => {
    const store = await createStore();
    store.addReadingNote({ ...base, title: 'Sage paper' });
    store.addReadingNote({ ...base, avatarId: 'echo', title: 'Echo paper' });
    const tool = createReadingNotesTool({ notes: store });
    expect(tool).toMatchObject({ id: READING_NOTES_TOOL_ID, serverId: 'builtin', toolName: 'my_reading_notes', readOnly: true, confirmationLevel: 'none' });
    const mine = String(await tool.execute({}, { avatarId: 'sage' }));
    expect(mine).toContain('Sage paper');
    expect(mine).not.toContain('Echo paper');
    expect(String(await tool.execute({ limit: 1 }))).toContain('Echo paper');
    expect(String(await tool.execute({}, { avatarId: 'nobody' }))).toContain('not written any reading notes');
  });

  it('keeps the formatted notes short', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ...note, id: `n${i}`, takeaway: 'x'.repeat(300) }));
    const text = formatReadingNotes(many, 1500);
    expect(text.length).toBeLessThan(2000);
    expect(text).toContain('more notes not shown');
  });
});
