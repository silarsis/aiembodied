// Types only: shared/ holds what the main process and the renderer both need.
import type { RoomSummary } from './types.js';

export interface RoomGenerationProgress {
  phase: 'planning' | 'finding' | 'arranging' | 'making' | 'done';
  message: string;
  current?: number;
  total?: number;
  warnings?: string[];
  /** Set for the background phase: the saved room the objects are being made for. */
  roomId?: string;
}

export interface RoomGenerationResult {
  room: RoomSummary;
  warnings: string[];
  /** How many objects may still be made in the background (0 when none). */
  making?: number;
}
