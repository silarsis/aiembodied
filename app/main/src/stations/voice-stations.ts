/**
 * What the local voice needs from stations, as one small object: the note added to a tool's description, the
 * spoken notice, and the trip around a tool call. The voice does not know about rooms or places; main builds
 * this from the registry and the trips.
 */
import type { ChatClient } from '../local-voice/voice-engines.js';
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { StationLookup } from './station-lookup.js';
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
  /**
   * The tools to offer the model: each reading station's tools are replaced by ONE lookup tool for the station
   * (`go_to_bookshelf`). Returns the given tools when stations are not offered that way.
   */
  offer?(tools: RegisteredTool[]): RegisteredTool[];
  /**
   * Runs a lookup tool made by `offer` (the focused tool loop at the station); null when `tool` is not one.
   * The station trip around it is made by `begin`, as for any station tool.
   */
  runLookup?(
    avatarId: string,
    tool: RegisteredTool,
    params: unknown,
    context: { chat: ChatClient; signal: AbortSignal },
  ): Promise<string> | null;
}

/** `lookup`: offer reading stations as one tool each. Without it every station tool is offered on its own. */
export function createVoiceStations(
  registry: StationRegistry,
  trips: StationTrips,
  lookup?: StationLookup,
): VoiceStations {
  return {
    prepare: () => registry.loadLabels(),
    descriptionNote: (tool) => {
      // A lookup tool already says where it goes in its own description.
      if (lookup?.isLookup(tool as RegisteredTool)) return '';
      const station = registry.stationForTool(tool);
      return station ? registry.descriptionNote(station) : '';
    },
    noticeFor: (avatarId, tool) => trips.noticeFor(avatarId, tool),
    begin: (avatarId, tool) => trips.begin(avatarId, tool),
    ...(lookup
      ? {
          offer: (tools: RegisteredTool[]) => lookup.offer(tools),
          runLookup: (
            avatarId: string,
            tool: RegisteredTool,
            params: unknown,
            context: { chat: ChatClient; signal: AbortSignal },
          ) => (lookup.isLookup(tool) ? lookup.run(avatarId, tool, params, context) : null),
        }
      : {}),
  };
}
