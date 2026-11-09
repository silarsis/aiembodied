import type { Vec3 } from '../../../main/src/rooms/types.js';

export interface AvatarBaseTransform {
  position: Vec3;
  rotationY: number;
}

/**
 * The normalised avatar's scene origin is offset from its body centre (the model is shifted so
 * the body sits on the world origin). Putting the body at `home` and turning it to `facing`
 * therefore rotates that offset too: position = home + Ry(facing) * basePosition.
 * Facing is in degrees (0 = +Z, direction (sin, 0, cos)); rotationY is in radians.
 */
export function placeAtHome(base: AvatarBaseTransform, home: { position: Vec3; facing: number }): AvatarBaseTransform {
  const angle = (home.facing * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const [bx, by, bz] = base.position;
  return {
    position: [home.position[0] + bx * cos + bz * sin, home.position[1] + by, home.position[2] - bx * sin + bz * cos],
    rotationY: base.rotationY + angle,
  };
}
