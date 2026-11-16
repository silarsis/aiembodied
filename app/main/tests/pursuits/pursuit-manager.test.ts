import { describe, expect, it, vi } from 'vitest';
import { PursuitManager, type PursuitManagerOptions } from '../../src/pursuits/pursuit-manager.js';
import { LlmGate } from '../../src/pursuits/pursuit-llm.js';
import type { StationVisit } from '../../src/stations/station-trips.js';
import type { Station } from '../../src/stations/types.js';
import { FakeChat, MemoryNotes, executorFor, libraryTool, type Reply, type SeenCall } from './fakes.js';

const station: Station = {
  id: 'station-1',
  roomId: 'room:builtin:reading-room',
  objectId: 'bookshelf',
  source: { kind: 'mcp', serverId: 'srv-1' },
  verb: 'read',
  activity: 'pulls a book from the shelf and reads',
  trip: 'all',
  characters: 'all',
};

function lastUser(call: SeenCall): string {
  const user = [...call.messages].reverse().find((m) => m.role === 'user');
  return user && 'content' in user ? user.content : '';
}

/** A character that reads one paper and then stops. */
function reader(call: SeenCall): Reply {
  const last = call.messages[call.messages.length - 1];
  const text = lastUser(call);
  const afterTool = last?.role === 'tool';
  if (text.includes('What do you feel like')) return { text: 'I want to read about gardens.' };
  if (text.includes('Look in the library now')) return afterTool ? { text: 'ok' } : { calls: [{ name: 'search', arguments: { q: 'gardens' } }] };
  if (text.includes('Choose ONE')) return { text: 'PICK: Gardens | https://x.y/g | pretty' };
  if (text.includes('Fetch its full text')) return afterTool ? { text: 'ok' } : { calls: [{ name: 'fetch', arguments: {} }] };
  if (text.includes('Write your notes')) return { text: 'TAKEAWAY: Plants are patient.\nOPINION: Nice.\nKEVIN: no link\nQUESTIONS: none' };
  return { text: 'NEXT: stop\nTELL: none' };
}

function setup(options: { respond?: (call: SeenCall, index: number) => Reply; known?: Partial<PursuitManagerOptions>; visit?: StationVisit | null } = {}) {
  const chats = new Map<string, FakeChat>();
  const chatFor = (id: string) => {
    let chat = chats.get(id);
    if (!chat) {
      chat = new FakeChat(options.respond ?? reader);
      chats.set(id, chat);
    }
    return chat;
  };
  const tools = [libraryTool('search', () => '1. Gardens https://x.y/g'), libraryTool('fetch', () => 'All about gardens.'), libraryTool('delete_all', () => 'x', { confirmationLevel: 'confirm' })];
  const notes = new MemoryNotes();
  const changes: string[][] = [];
  const told: Array<[string, string]> = [];
  const activities: string[] = [];
  const visit: StationVisit | null =
    options.visit === undefined
      ? { arrived: async () => undefined, activity: (text) => void activities.push(text), settle: vi.fn(async () => undefined) }
      : options.visit;
  const manager = new PursuitManager({
    stations: {
      get: (id) => (id === station.id ? station : null),
      list: () => [station],
      appliesTo: (s, avatarId) => s.characters === 'all' || s.characters.includes(avatarId),
      stationForTool: (tool) => (typeof tool !== 'string' && tool.serverId === 'srv-1' ? station : null),
      labelsFor: () => ({ roomName: 'Reading room', objectName: 'bookshelf' }),
      loadLabels: async () => undefined,
      resolveServerId: () => 'srv-1',
    },
    tools: { list: () => tools, execute: executorFor(tools) },
    voiceFor: (avatarId) => ({ chat: () => chatFor(avatarId), recentLines: () => [] }),
    persona: (id) => `${id} persona`,
    habits: () => '',
    avatarName: (id) => id.toUpperCase(),
    notes,
    saveToMemory: () => undefined,
    tell: (avatarId, text) => void told.push([avatarId, text]),
    visit: () => visit,
    onChanged: (running) => void changes.push(running),
    ...options.known,
  });
  return { manager, notes, changes, told, activities, visit, chatFor, tools };
}

/** Waits until nobody is reading. */
const idle = (manager: PursuitManager) => vi.waitFor(() => expect(manager.running()).toEqual([]));

describe('PursuitManager', () => {
  it('runs a session in the background, reports who is reading, and keeps the notes', async () => {
    const { manager, notes, changes, activities, visit } = setup();
    expect(manager.start('sage', 'station-1')).toEqual({ ok: true });
    expect(manager.isRunning('sage')).toBe(true);
    expect(changes[0]).toEqual(['sage']);
    await idle(manager);
    expect(changes.at(-1)).toEqual([]);
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({ avatarId: 'sage', title: 'Gardens', takeaway: 'Plants are patient.' });
    // The body followed the steps.
    expect(activities).toEqual(['stands at the bookshelf, thinking about what to read', 'browses the bookshelf', 'looks over the titles on the bookshelf', 'reads', 'jots down notes', 'closes the book and thinks']);
    expect(visit?.settle).toHaveBeenCalledWith(true);
  });

  it('uses the avatar\'s own model, its persona, and only the station tools without approvals', async () => {
    const { manager, chatFor } = setup();
    manager.start('sage', 'station-1');
    await idle(manager);
    const chat = chatFor('sage');
    expect(JSON.stringify(chat.seen[0].messages[0])).toContain('sage persona');
    const toolNames = chat.seen.flatMap((c) => c.tools.map((t) => t.function.name));
    expect(new Set(toolNames)).toEqual(new Set(['search', 'fetch']));
  });

  it('allows one session per avatar, and refuses what cannot run', () => {
    const { manager } = setup({ known: { voiceFor: (id) => (id === 'mute' ? null : { chat: () => new FakeChat(reader), recentLines: () => [] }) } });
    expect(manager.start('sage', 'station-1')).toEqual({ ok: true });
    expect(manager.start('sage', 'station-1')).toEqual({ ok: false, reason: 'already reading' });
    expect(manager.start('echo', 'nope')).toEqual({ ok: false, reason: 'no such station' });
    expect(manager.start('mute', 'station-1')).toMatchObject({ ok: false });
    // A different avatar may read at the same time.
    expect(manager.start('echo', 'station-1')).toEqual({ ok: true });
    expect(manager.running().sort()).toEqual(['echo', 'sage']);
  });

  it('refuses an avatar the station is not for', () => {
    const { manager } = setup();
    station.characters = ['echo'];
    try {
      expect(manager.start('sage', 'station-1')).toMatchObject({ ok: false });
      expect(manager.offers()[0].characters).toEqual(['echo']);
    } finally {
      station.characters = 'all';
    }
  });

  it('offers the stations that have tools to read with', () => {
    const { manager } = setup();
    expect(manager.offers()).toEqual([{ stationId: 'station-1', roomId: station.roomId, objectId: 'bookshelf', objectName: 'bookshelf', characters: 'all' }]);
    const none = setup({ known: { tools: { list: () => [], execute: async () => ({ success: false, durationMs: 0 }) } } });
    expect(none.manager.offers()).toEqual([]);
    expect(none.manager.start('sage', 'station-1')).toMatchObject({ ok: false });
  });

  it('ends at once when Kevin starts talking, aborting the model call and saving what it had', async () => {
    const { manager, notes, chatFor } = setup();
    const chat = chatFor('sage');
    // Hold the note call (call 6) until Kevin speaks.
    chat.holdOn.add(6);
    manager.start('sage', 'station-1');
    await vi.waitFor(() => expect(chat.seen.length).toBe(7));
    expect(manager.interrupt('sage', 'conversation')).toBe(true);
    await idle(manager);
    expect(notes.notes).toHaveLength(1);
    expect(notes.notes[0]).toMatchObject({ title: 'Gardens', partial: true });
    expect(manager.interrupt('sage')).toBe(false);
  });

  it('does not tell anyone after being interrupted, and tells through the inbox path otherwise', async () => {
    const tell = (call: SeenCall): Reply => (lastUser(call).includes('Do you want to read more') ? { text: 'NEXT: stop\nTELL: Kevin, gardens are patient.' } : reader(call));
    const { manager, told } = setup({ respond: tell });
    manager.start('sage', 'station-1');
    await idle(manager);
    expect(told).toEqual([['sage', 'Kevin, gardens are patient.']]);
  });

  it('runs model calls of different avatars one at a time, so a slot is left for the conversation', async () => {
    let active = 0;
    let most = 0;
    const respond = (call: SeenCall): Reply => reader(call);
    const { manager, chatFor } = setup({ respond });
    for (const id of ['sage', 'echo']) {
      const chat = chatFor(id);
      const original = chat.streamChat.bind(chat);
      chat.streamChat = async function* (...args) {
        active += 1;
        most = Math.max(most, active);
        try {
          yield* original(...args);
          await new Promise((resolve) => setTimeout(resolve, 1));
        } finally {
          active -= 1;
        }
      };
    }
    manager.start('sage', 'station-1');
    manager.start('echo', 'station-1');
    await idle(manager);
    expect(most).toBe(1);
  });

  it('ends a session that takes too long', async () => {
    const { manager, chatFor, notes } = setup({ known: { sessionTimeoutMs: 20 } });
    chatFor('sage').holdOn.add(0);
    manager.start('sage', 'station-1');
    await idle(manager);
    expect(notes.notes).toHaveLength(0);
  });

  it('stopAll ends every session', async () => {
    const { manager, chatFor } = setup();
    chatFor('sage').holdOn.add(0);
    manager.start('sage', 'station-1');
    await manager.stopAll();
    expect(manager.running()).toEqual([]);
  });

  it('still reads when the body cannot go (no visit)', async () => {
    const { manager, notes } = setup({ visit: null });
    manager.start('sage', 'station-1');
    await idle(manager);
    expect(notes.notes).toHaveLength(1);
  });

  it('shares the gate it is given', () => {
    const gate = new LlmGate(2);
    expect(setup({ known: { gate } }).manager.running()).toEqual([]);
  });
});
