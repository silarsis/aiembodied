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
}

/** What a station needs from a tool to be matched (a RegisteredTool has all of these). */
export interface StationTool {
  id: string;
  serverId: string;
  toolName: string;
  readOnly?: boolean;
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
  phase: 'start' | 'end';
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
