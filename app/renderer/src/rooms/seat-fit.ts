/**
 * Seated contact fit. The motion service reaches its hip target only approximately and every avatar has
 * its own proportions, so after a sit the pelvis can end up inside the cushion. This works out a small
 * vertical offset for the avatar root so the buttocks rest on the measured seat surface. It is pure
 * arithmetic; `RoomSceneEnv` measures the bones and the surface and applies the result.
 */

/** Standing pelvis height the contact drop is specified for (metres). */
export const REFERENCE_HIPS_HEIGHT = 0.95;
/** Distance from the hips bone down to the lowest seated contact (buttocks) on a 0.95 m-hips avatar, metres. */
export const BUTTOCKS_BELOW_HIPS = 0.09;
/** The root is never moved further than this from the floor, either way (metres). */
export const MAX_SEAT_OFFSET = 0.3;
/** Offsets smaller than this are treated as zero, so a settled fit stops writing the root every frame (metres). */
export const SEAT_OFFSET_EPSILON = 0.0005;
/** Easing rate of the offset, 1/seconds (time constant of about 0.15 s). */
export const SEAT_EASE_RATE = 7;

/** World height of the lowest seated contact for a pelvis at `hipsY`; `scale` is the avatar root scale. */
export function seatedContactY(hipsY: number, restHipsHeight: number, scale = 1): number {
  const rest = restHipsHeight > 0 ? restHipsHeight : REFERENCE_HIPS_HEIGHT;
  return hipsY - BUTTOCKS_BELOW_HIPS * (rest / REFERENCE_HIPS_HEIGHT) * scale;
}

/**
 * The total vertical offset that puts the contact on the surface. `contactY` is measured with the
 * current offset already applied, so the offset is taken back out first; that keeps the target stable
 * while the root is moving and means the result never accumulates.
 */
export function seatOffsetTarget(contactY: number, surfaceY: number, appliedOffset: number): number {
  const wanted = surfaceY - (contactY - appliedOffset);
  return Math.max(-MAX_SEAT_OFFSET, Math.min(MAX_SEAT_OFFSET, wanted));
}

/** Moves `current` towards `target` with an exponential ease over `deltaSeconds`. */
export function easeOffset(current: number, target: number, deltaSeconds: number): number {
  const next = current + (target - current) * (1 - Math.exp(-SEAT_EASE_RATE * Math.max(0, deltaSeconds)));
  return Math.abs(target - next) < SEAT_OFFSET_EPSILON ? target : next;
}
