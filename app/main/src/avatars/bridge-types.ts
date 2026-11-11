/** The renderer's bridge to the avatar registry (read-only for now). Types only. */
import type { AvatarProfile } from './avatar-registry.js';

export type { AvatarProfile };

export interface AvatarsBridge {
  list(): Promise<AvatarProfile[]>;
}
