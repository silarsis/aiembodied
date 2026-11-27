/**
 * How a reading note goes to the memory engine, and how it reads back to the character.
 *
 * The engine has no "reading" kind, so a note is written as a fact: author 'agent', agent = the character,
 * subject 'reading', and `private` so it stays out of the brief that opens every conversation (a paper's
 * takeaway is not something to know about Kevin at a glance). The text carries the title and link so recall can
 * find it. The same note is also kept in SQLite (`reading_notes`) for the Characters pop-up.
 */
import { randomUUID } from 'node:crypto';
import type { MemoryEngineFact } from '../memory-engine/client.js';
import type { OutboxItem } from '../memory-engine/outbox.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import { clip } from './pursuit-llm.js';
import type { ReadingNoteStore } from './types.js';
import type { ReadingNote } from '../shared/pursuits/types.js';

/** The note as one piece of text for memory: what it is, the link, then the character's own words. */
export function readingFactText(note: ReadingNote, avatarName: string): string {
  const parts = [
    `${avatarName} read "${note.title}"${note.link ? ` (${note.link})` : ''}${note.partial ? ' (cut short)' : ''}.`,
    note.takeaway ? `Takeaway: ${note.takeaway}` : '',
    note.opinion ? `Opinion: ${note.opinion}` : '',
    note.connection ? `Link to Kevin: ${note.connection}` : '',
    note.questions.length > 0 ? `Open questions: ${note.questions.join(' ')}` : '',
  ];
  return clip(parts.filter(Boolean).join(' '), 1000);
}

export function readingFact(
  note: ReadingNote,
  avatarName: string,
  model: string | null = null,
): MemoryEngineFact {
  return {
    text: readingFactText(note, avatarName),
    subject: 'reading',
    author: 'agent',
    agent: avatarName,
    session_id: null,
    private: true,
    model,
  };
}

/** The outbox item for a note (written first, sent when the engine is up). */
export function readingOutboxItem(
  note: ReadingNote,
  avatarName: string,
  model: string | null = null,
): OutboxItem {
  return { kind: 'fact', id: randomUUID(), fact: readingFact(note, avatarName, model) };
}

export const READING_NOTES_TOOL_ID = 'builtin:my_reading_notes';

function formatDay(at: number): string {
  return new Date(at).toLocaleDateString('en-AU', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** The notes as text for the model, newest first, within `limit` characters. */
export function formatReadingNotes(notes: ReadingNote[], limit = 4000): string {
  if (notes.length === 0) return 'You have not written any reading notes yet.';
  const out: string[] = [];
  let used = 0;
  for (const note of notes) {
    const lines = [
      `${formatDay(note.createdAt)}: "${note.title}"${note.link ? ` ${note.link}` : ''}${note.partial ? ' (cut short)' : ''}`,
      `  Takeaway: ${note.takeaway}`,
      note.opinion ? `  Opinion: ${note.opinion}` : '',
      note.connection ? `  Link to Kevin: ${note.connection}` : '',
      note.questions.length > 0 ? `  Open questions: ${note.questions.join(' ')}` : '',
    ].filter(Boolean);
    const text = lines.join('\n');
    if (used + text.length > limit) {
      out.push('(more notes not shown)');
      break;
    }
    out.push(text);
    used += text.length + 1;
  }
  return out.join('\n');
}

/**
 * `my_reading_notes`: the calling character's own recent reading notes, so "what have you been reading?" is
 * answered from what it wrote down. Read-only. Each avatar's voice calls it with its own id (ToolContext).
 */
export function createReadingNotesTool(options: {
  notes: Pick<ReadingNoteStore, 'listReadingNotes'>;
  defaultAvatarId?: string;
}): RegisteredTool {
  return {
    id: READING_NOTES_TOOL_ID,
    serverId: 'builtin',
    toolName: 'my_reading_notes',
    description:
      'Your own notes from what you have read on your own time (papers and articles from the library): titles, links, ' +
      'what you took from them and what you think. Use it when asked what you have been reading or learning lately.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: {
          type: 'number',
          description: 'Optional. How many of the latest notes to read, 1 to 20. Default 5.',
        },
      },
    },
    enabled: true,
    confirmationLevel: 'none',
    readOnly: true,
    spokenNotice: 'Let me think back.',
    describeCall: () => 'my reading notes',
    execute: async (params, context) => {
      const raw =
        params && typeof params === 'object'
          ? Number((params as Record<string, unknown>).limit)
          : Number.NaN;
      const limit = Number.isFinite(raw) ? Math.min(20, Math.max(1, Math.round(raw))) : 5;
      return formatReadingNotes(
        options.notes.listReadingNotes(
          context?.avatarId ?? options.defaultAvatarId ?? 'echo',
          limit,
        ),
      );
    },
  };
}
