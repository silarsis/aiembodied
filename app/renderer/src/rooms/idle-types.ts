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
  /** Walk out to another place. Always the last tag; the idle director checks the rules in code before it runs. */
  | { type: 'room'; place: string }
  | { type: 'wait' };

/** Another place an idle avatar could walk to (only listed when it may leave at all). */
export interface IdlePlace {
  name: string;
  /** Names of the avatars standing there. */
  who: string[];
  /** Someone used that PC in the last 10 minutes. */
  recentlyUsed: boolean;
}

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
  /** The other places that exist, who is in each and whether that PC was used lately; absent with one place. */
  places?: IdlePlace[];
}
