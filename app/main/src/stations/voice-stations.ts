/**
 * What the local voice needs from stations, as one small object: the note added to a tool's description, the
 * spoken notice, and the trip around a tool call. The voice does not know about rooms or places; main builds
 * this from the registry and the trips.
 */
import type { StationRegistry } from './station-registry.js';
import type { StationTrips, StationUse } from './station-trips.js';
import type { StationTool } from './types.js';

export interface VoiceStations {
  /** Read the names of rooms and objects before the tools are described (cached, cheap). */
  prepare(): Promise<void>;
  /** " (kept on the bookshelf in the Reading room)" for a tool that lives at a station, else ''. */
  descriptionNote(tool: StationTool): string;
  /** What the avatar says while the tool runs; null leaves the tool's own notice. */
  noticeFor(avatarId: string, tool: StationTool & { spokenNotice?: string }): string | null;
  /** The trip around one tool call, or null when the avatar stays where it is. */
  begin(avatarId: string, tool: StationTool): StationUse | null;
}

export function createVoiceStations(registry: StationRegistry, trips: StationTrips): VoiceStations {
  return {
    prepare: () => registry.loadLabels(),
    descriptionNote: (tool) => {
      const station = registry.stationForTool(tool);
      return station ? registry.descriptionNote(station) : '';
    },
    noticeFor: (avatarId, tool) => trips.noticeFor(avatarId, tool),
    begin: (avatarId, tool) => trips.begin(avatarId, tool),
  };
}
