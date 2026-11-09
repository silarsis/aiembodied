/**
 * What the avatar does when the user starts talking after it wandered off: walk back to its home
 * spot ("Come back to me") or just turn towards the camera where it is ("Turn to me where it is").
 * Decided when the action's turn comes, from where the avatar is by then.
 */
import type { OnTalk } from '../../../main/src/rooms/idle-settings.js';
import { yawToward, wrapRadians } from './scene-frames.js';
import type { AvatarState, PlanWorld, SceneAction } from './scene-actions.js';

/** "Come back to me" only walks when the avatar is farther than this (metres) from home. */
export const HOME_DISTANCE = 1.0;
/** "Turn to me" only turns when the avatar faces further than this (radians) away from the camera. */
export const TURN_THRESHOLD = (30 * Math.PI) / 180;

export function talkStartActions(mode: OnTalk, world: PlanWorld, state: AvatarState): SceneAction[] {
  const root: [number, number, number] = [world.frame.origin.x, 0, world.frame.origin.z];
  if (mode === 'come-back') {
    const home = world.room.home.position;
    const far = Math.hypot(root[0] - home[0], root[2] - home[2]) > HOME_DISTANCE;
    if (state.posture !== 'seated' && !far) return [];
    return state.posture === 'seated' ? [{ kind: 'stand' }, { kind: 'come' }] : [{ kind: 'come' }];
  }
  // A seated avatar stays seated.
  if (state.posture === 'seated') return [];
  const camera = world.room.camera.position;
  const away = Math.abs(wrapRadians(yawToward(root, camera) - world.frame.origin.yaw));
  return away > TURN_THRESHOLD ? [{ kind: 'lookAtPoint', position: camera, label: 'the camera' }] : [];
}
