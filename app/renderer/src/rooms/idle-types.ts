import type { RoomFile, RoomObject, Vec3 } from '../../../main/src/rooms/types.js';
import type { AvatarState } from './scene-actions.js';

/** What the avatar may be asked to do on its own: scene tags, a gesture, or nothing this time. */
export type IdleTag =
  | { type: 'go'; object: string }
  | { type: 'look'; object: string }
  | { type: 'sit'; object: string }
  | { type: 'stand' }
  | { type: 'come' }
  | { type: 'pick'; object: string }
  | { type: 'put'; object: string; surface: string }
  | { type: 'move'; text: string }
  | { type: 'wait' };

/** Everything the prompt and the fallback picker know about the moment. */
export interface IdleInput {
  name: string;
  personality: string;
  habits: string;
  room: RoomFile;
  /** Objects the room camera can see. */
  visible: RoomObject[];
  state: AvatarState;
  /** Where the avatar stands (world). */
  position: Vec3;
  /** The last few idle actions, newest last, as written for the log. */
  recent: string[];
  now: Date;
  /** The other avatars in the room and where they are; absent when this one is alone. */
  others?: Array<{ name: string; where: string | null }>;
}
