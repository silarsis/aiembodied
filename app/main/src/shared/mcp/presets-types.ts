// Types only: shared/ holds what the main process and the renderer both need.


/** The preset list in the shape the renderer needs (no config internals beyond the address). */
export interface MCPPresetSummary {
  id: string;
  name: string;
  description: string;
  url: string;
}
