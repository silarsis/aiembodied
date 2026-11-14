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
  // Talking and moving. Each runs on this PC for the satellite's place (the fake event carries `placeId`).
  'local-voice:respond',
  'local-voice:cancel',
  'local-voice:status',
  'local-voice:system-status',
  'local-voice:voice-options',
  'local-voice:transcribe',
  'avatar-motion:stream',
  'avatar-motion:cancel',
  'avatar-motion:status',
  'floor:interrupt',
  'avatars:set-tag-instructions',
  'avatars:idle-personas',
  'presence:update',
  'presence:get-dnd',
  'rooms:idle-pick',
  // Read-only getters the renderer asks for at start-up.
  'avatar:prompt:get-preference',
  'avatar:voice:get-preference',
  'avatar:idle-habits:get',
  'conversation:get-history',
  // The transcript the satellite's renderer keeps of its own turns (user and assistant lines, announcements).
  'conversation:append-message',
  'conversation:announce',
  // Who is where, and walking between places.
  'places:snapshot',
  'places:move',
  'places:arrived',
  // Nobody is in the room and Kevin pressed the talk key: call someone over.
  'places:summon',
]);

export function isAllowedChannel(channel: unknown): channel is string {
  return typeof channel === 'string' && SATELLITE_CHANNELS.has(channel);
}
