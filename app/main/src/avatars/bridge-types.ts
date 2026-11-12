/** The renderer's bridge to the avatar registry . Types only. */
import type { AvatarProfile } from './avatar-registry.js';

export type { AvatarProfile };

export interface AvatarTagInstructions {
  shared: string;
  moveOnly: string;
  /** The room and scene tag text, added after the tag instructions of avatars other than Echo. Absent in 2D. */
  scene?: string;
  /** Scene text with the avatar's own "X is in the room with you." lines, by avatar id; `scene` serves the rest. */
  sceneFor?: Record<string, string>;
}

/** What the idle director is told about an avatar other than Echo. */
export interface AvatarIdlePersona {
  personality: string;
  habits: string;
}

export interface AvatarsBridge {
  list(): Promise<AvatarProfile[]>;
  /** Make an avatar; its id is a slug of the name. */
  add(input: { name: string; vrmModelId?: string | null; prompt?: string }): Promise<AvatarProfile>;
  /** `prompt: ''` clears the prompt. */
  update(id: string, changes: { name?: string; vrmModelId?: string | null; prompt?: string }): Promise<AvatarProfile>;
  /** Echo and the last avatar cannot be removed. */
  remove(id: string): Promise<void>;
  /**
   * The animation, pose and {move:} instructions that other avatars' prompts get after their persona.
   * `shared` is for avatars wearing Echo's body, `moveOnly` for avatars with a body of their own. `scene` (and `sceneFor`)
   * describe the room they stand in. Each at most 20000 characters.
   */
  setTagInstructions?(instructions: AvatarTagInstructions): Promise<void>;
  /** Personality and idle habits of every avatar except Echo, by avatar id, as saved now. */
  idlePersonas?(): Promise<Record<string, AvatarIdlePersona>>;
}
