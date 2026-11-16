/** The renderer's bridge to stations. Types only. */
import type { Station, StationSource, StationUseEvent, StationView } from './types.js';

export type { Station, StationSource, StationUseEvent, StationView };

export interface StationsBridge {
  /** Every station with the names of its room and object, and the MCP server it holds. */
  list(): Promise<StationView[]>;
  /**
   * Make an object hold a source (or nothing, with null). A source lives in one place, so a station that held it
   * elsewhere is removed. `extra` changes the trip setting, the verb and so on.
   */
  hold(
    roomId: string,
    objectId: string,
    source: StationSource | null,
    extra?: Partial<Pick<Station, 'verb' | 'activity' | 'trip' | 'characters'>>,
  ): Promise<Station | null>;
  update(id: string, changes: Partial<Omit<Station, 'id'>>): Promise<Station | null>;
  remove(id: string): Promise<boolean>;
  /** Main says an avatar is going to a station (or is done there). Returns the unsubscribe function. */
  onUse(listener: (event: StationUseEvent) => void): () => void;
  /** The avatar reached the object, or cannot walk there: main may go on with the answer. */
  arrived(useId: string): Promise<void>;
}
