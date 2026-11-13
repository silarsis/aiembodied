/**
 * The IPC channels a satellite may call on this PC. Everything else is refused with `denied`.
 * Settings, models, keys, coding, generation, uploads, deletes and app:* are never in this list.
 * It grows one step at a time (see docs/features/room-link-protocol.md).
 */
export const SATELLITE_CHANNELS: ReadonlySet<string> = new Set([
  // Drawing a room and the avatars in it (read-only).
  'avatar-model:list',
  'avatar-model:get-active',
  'avatar-model:load',
  'background:list',
  'background:get-active',
  'background:load',
  'background:list-rooms',
  'background:load-room',
  'avatar-animation:list',
  'avatar-animation:load',
  'avatar-pose:list',
  'avatar-pose:load',
  'avatars:list',
  'rooms:idle-settings:get',
  'rooms:object-settings:get',
  // Who is where, and walking between places.
  'places:snapshot',
  'places:move',
  'places:arrived',
]);

export function isAllowedChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && SATELLITE_CHANNELS.has(channel);
}
