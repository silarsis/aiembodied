import type { RoomFile, Vec3 } from '../../../main/src/rooms/types.js';
import { objectToWorld } from './room-geometry.js';

export type PositionalTag = 'sit' | 'stand' | 'grab' | 'look' | 'surface';

export interface WorldTag {
  position: Vec3;
  /** World facing in degrees (0 = +Z); absent for tags that have no direction. */
  facing?: number;
}

/**
 * Converts an object's tag from object-local space to world space. Positions rotate with the
 * object's rotationY and facings add to it. Returns null when the object or tag does not exist.
 */
export function worldTag(room: RoomFile, objectId: string, kind: PositionalTag): WorldTag | null {
  const object = room.objects.find((candidate) => candidate.id === objectId);
  const tag = object?.tags?.[kind];
  if (!object || !tag) return null;
  const rotation = object.rotationY ?? 0;
  if ('height' in tag) return { position: [object.position[0], object.position[1] + tag.height, object.position[2]] };
  const position = objectToWorld(object, tag.position);
  if ('facing' in tag) return { position, facing: normaliseDegrees(tag.facing + rotation) };
  return { position };
}

export function normaliseDegrees(degrees: number): number {
  const wrapped = ((degrees % 360) + 360) % 360;
  return wrapped > 180 ? wrapped - 360 : wrapped;
}
