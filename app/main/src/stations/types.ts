

/** What a station needs from a tool to be matched (a RegisteredTool has all of these). */
export interface StationTool {
  id: string;
  serverId: string;
  toolName: string;
  readOnly?: boolean;
}
