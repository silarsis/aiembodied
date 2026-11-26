// Types only: shared/ holds what the main process and the renderer both need.

/** What a note in the Characters pop-up (and the `my_reading_notes` tool) shows. */
export interface ReadingNote {
  id: string;
  avatarId: string;
  /** The station (the bookshelf) the item was found at. */
  stationId: string | null;
  title: string;
  link: string | null;
  /** What the character took from it, in its own words. */
  takeaway: string;
  opinion: string;
  /** How it ties to Kevin or the character's own interests. */
  connection: string;
  /** Questions it still has after reading. */
  questions: string[];
  /** What it wanted to find out when it went looking. */
  curiosity: string;
  /** True when the session was cut short (Kevin started talking) and the notes are what had been gathered so far. */
  partial: boolean;
  createdAt: number;
}

/** A station an avatar may go and read at, as the idle director offers it. */
export interface PursuitOffer {
  stationId: string;
  roomId: string;
  objectId: string;
  /** "bookshelf" */
  objectName: string;
  /** The avatars that may use it. */
  characters: 'all' | string[];
}

/** How the renderer starts a session, lists notes and learns who is reading. */
export interface PursuitsBridge {
  /** Start a reading session for an avatar at a station. `ok: false` says why not (already reading, no tools...). */
  start(avatarId: string, stationId: string): Promise<{ ok: boolean; reason?: string }>;
  /** Stop an avatar's session (it ends gracefully, saving its notes). */
  stop?(avatarId: string): Promise<void>;
  /** The stations that can be read at. */
  offers(): Promise<PursuitOffer[]>;
  /** The avatars that have a session running now. */
  running(): Promise<string[]>;
  /** Called when the set of reading avatars changes. Returns the unsubscribe function. */
  onChanged(listener: (running: string[]) => void): () => void;
  /** An avatar's recent reading notes, newest first. */
  notes(avatarId: string, limit?: number): Promise<ReadingNote[]>;
}
