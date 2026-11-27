// Types only: shared/ holds what the main process and the renderer both need.

/**
 * Stations: a place in a 3D room where a tool "lives". The reading library (an MCP server) is kept on the
 * bookshelf, so when an avatar uses it the avatar walks to the bookshelf and reads. Types only.
 */

/** Where the tools of a station come from. */
export type StationSource =
  /** An MCP server: by its id, or by a preset id (the server is found by its address). */
  | { kind: 'mcp'; serverId?: string; preset?: string }
  /** Tools built into the app, by the name the model calls them (for example `web_search`). */
  | { kind: 'builtin'; toolNames: string[] };

/**
 * How the body acts a station's use when the user is a pursuit (reading). All optional: what is missing, or not in the
 * room, falls back to standing at the object and acting gestures only.
 */
export interface StationBody {
  /** Id of the room object to take from the station object and hold while reading (`book`). */
  prop?: string;
  /** Id of the room object to sit on to read (`armchair`). */
  seat?: string;
  /** Gesture texts (`{move:}`) for browsing at the object, reading and taking notes. */
  browse?: string;
  read?: string;
  note?: string;
}

export interface Station {
  id: string;
  /** The room, as a room id (`room:builtin:reading-room`). */
  roomId: string;
  /** The object in that room (`bookshelf`). */
  objectId: string;
  source: StationSource;
  /** What the avatar does, as one word: 'read'. Shown in the settings. */
  verb: string;
  /** What the avatar does at the object, said as a `{move:}` gesture: 'pulls a book from the shelf and reads'. */
  activity: string;
  /** 'all': every use is a trip. 'writes': only a tool that changes things is (a read-only tool is not). */
  trip: 'all' | 'writes';
  /** Which avatars make the trip. */
  characters: 'all' | string[];
  /**
   * 'none': a pursuit (reading) is never started here; the station is only for tool trips. Absent means the station may be
   * read at. Set on Home Assistant panels, which hold controls, not something to read.
   */
  pursuit?: 'none';
  /** What the body does for a pursuit at this station (props, seat, gestures); see `StationBody`. */
  body?: StationBody;
}

/** `station:use`: main tells the renderer where the avatar is going and what it does there. */
export interface StationUseEvent {
  /** One per trip; the renderer answers `station:arrived` with it. */
  useId: string;
  avatarId: string;
  stationId: string;
  roomId: string;
  objectId: string;
  activity: string;
  /** 'activity': a pursuit's next step; the avatar acts `activity` where it stands (no walking). */
  phase: 'start' | 'end' | 'activity';
  /** Who caused the trip: a pursuit (reading) or a tool call in a conversation. Absent means 'tool'. */
  source?: 'pursuit' | 'tool';
  /** Only on a pursuit's 'activity': the step it is in (want, act, choose, consume, note, next). */
  step?: string;
  /** The station's body plan (props, seat, gestures), sent on a pursuit's events so the screen needs no lookup. */
  body?: StationBody;
  /** Only on 'end': whether the tool worked. */
  ok?: boolean;
}

/** The names the model and the settings show for a station. */
export interface StationLabels {
  roomName: string;
  objectName: string;
}

/** A station as the settings show it: the station plus the names, and the MCP server it holds (when it exists). */
export interface StationView extends Station, StationLabels {
  serverId: string | null;
}
