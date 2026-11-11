/** The renderer's bridge to the avatar registry . Types only. */
import type { AvatarProfile } from './avatar-registry.js';

export type { AvatarProfile };

export interface AvatarsBridge {
  list(): Promise<AvatarProfile[]>;
  /** Make an avatar; its id is a slug of the name. */
  add(input: { name: string; vrmModelId?: string | null; prompt?: string }): Promise<AvatarProfile>;
  /** `prompt: ''` clears the prompt. */
  update(id: string, changes: { name?: string; vrmModelId?: string | null; prompt?: string }): Promise<AvatarProfile>;
  /** Echo and the last avatar cannot be removed. */
  remove(id: string): Promise<void>;
}
