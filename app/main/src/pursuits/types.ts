import type { ReadingNote } from '../shared/pursuits/types.js';
/**
 * Pursuits: things a character does on its own, as a small loop of its own thinking (want, act, choose, consume,
 * note, next). Reading is the first. Types only; no Electron.
 */

/** The steps of a pursuit, in the order a round goes through them. */
export type PursuitStep = 'want' | 'act' | 'choose' | 'consume' | 'note' | 'next';

export type NewReadingNote = Omit<ReadingNote, 'id' | 'createdAt'> & { createdAt?: number };

/** Where reading notes are kept (SQLite `reading_notes`). */
export interface ReadingNoteStore {
  addReadingNote(note: NewReadingNote): ReadingNote;
  /** Newest first. */
  listReadingNotes(avatarId: string, limit?: number): ReadingNote[];
}
