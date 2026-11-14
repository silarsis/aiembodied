/**
 * What a satellite PC does with every IPC channel in preload.ts. The renderer is the same on both PCs, so it
 * may call any channel; each one is decided here, once:
 *
 * - `forward`: sent to bija with `link.call` (bija's hub allowlist, room-hub/allowlist.ts, must allow it too).
 * - `local`: answered on this PC (a small config, devices, window and pairing).
 * - `unavailable`: rejects with "Not available on a satellite PC.". The satellite's renderer does not call
 *   these (the controls for them are hidden), and tolerates the error if one slips through.
 * - `event`: pushed by bija and handed to this PC's renderer as it arrives.
 *
 * A test reads preload.ts and fails for any channel that is not listed, so adding a channel means deciding
 * here what a satellite does with it.
 */

export type ChannelKind = 'forward' | 'local' | 'unavailable' | 'event';

export const NOT_ON_SATELLITE = 'Not available on a satellite PC.';

/** Run on bija, for the place this PC draws. */
const FORWARD = [
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
  'avatars:idle-personas',
  'rooms:idle-settings:get',
  'rooms:object-settings:get',
  'rooms:idle-pick',
  // Talking: the turn runs on bija with this place's floor; its events come back as `event` channels.
  'local-voice:respond',
  'local-voice:cancel',
  'local-voice:status',
  'local-voice:system-status',
  'local-voice:voice-options',
  'local-voice:transcribe',
  'floor:interrupt',
  'avatars:set-tag-instructions',
  'avatar:prompt:get-preference',
  'avatar:voice:get-preference',
  'avatar:idle-habits:get',
  'conversation:get-history',
  'conversation:append-message',
  'conversation:announce',
  'presence:update',
  'presence:get-dnd',
  // Moving: live motion streams, and walking between places.
  'avatar-motion:stream',
  'avatar-motion:cancel',
  'avatar-motion:status',
  'places:snapshot',
  'places:move',
  'places:arrived',
  'places:summon',
] as const;

/** Answered on this PC. */
const LOCAL = [
  // The app and the window.
  'app:quit',
  'diagnostics:preload-log',
  // A minimal config (`role: 'satellite'`), and this PC's own devices. Audio devices belong to this PC, not to bija.
  'config:get',
  'config:set-audio-devices',
  'talk:get-shortcut-status',
  'wake-word:list',
  'wake-word:set-listening',
  'metrics:observe-latency',
  // Nothing to approve or make in the background on this PC: the answers are empty.
  'approvals:list',
  'rooms:making',
  // Pairing with bija, and the link's state.
  'satellite:status',
  'satellite:pair',
  'satellite:forget',
  // The privacy gate (device-gate.ts) and what the renderer reports back to it.
  'device-gate:get',
  'device-gate:capture-stopped',
  'device-gate:set-open',
  'satellite:turn-timing',
] as const;

/** Events bija pushes (as `ipc`) that this PC's renderer listens for. */
const EVENT = [
  'local-voice:event',
  'local-voice:system-ready',
  'avatar-motion:chunk',
  'places:changed',
  'rooms:updated',
  'coding:busy',
  // A greeting for an avatar that just walked in where a face was seen (this PC's own camera cues are sent by its own main process).
  'camera:detection',
] as const;

/** Never run on a satellite: settings, models, keys, avatars, coding, generation, uploads, deletes, memory, tools, bija's own admin. */
const UNAVAILABLE = [
  // Settings and keys.
  'config:clear-secret',
  'config:get-secret',
  'config:set-providers',
  'config:set-secret',
  'config:test-secret',
  'models:cancel-download',
  'models:civitai-lookup',
  'models:comfy-addon',
  'models:delete-local-llm',
  'models:download',
  'models:downloads',
  'models:get',
  'models:hf-cancel',
  'models:hf-download',
  'models:hf-downloads',
  'models:hf-lookup',
  'models:local-llms',
  'models:probe',
  'models:remove-server',
  'models:save-server',
  'models:set-key',
  'models:set-route',
  'models:speech-download',
  'models:speech-engines',
  'models:use-local-llm',
  'models:vision-cancel',
  'models:vision-download',
  'models:vision-status',
  'realtime:mint-ephemeral-token',
  // Avatars: writes, generation, the studio.
  'avatar-animation:delete',
  'avatar-animation:generate',
  'avatar-animation:rename',
  'avatar-animation:upload',
  'avatar-model:delete',
  'avatar-model:generate-description',
  'avatar-model:set-active',
  'avatar-model:update-description',
  'avatar-model:update-thumbnail',
  'avatar-model:upload',
  'avatar-pose:delete',
  'avatar-pose:evaluate',
  'avatar-pose:generate',
  'avatar-pose:refine',
  'avatar-pose:upload',
  'avatar:base-model-suggestions',
  'avatar:character-model-select',
  'avatar:character-models',
  'avatar:generation-accept',
  'avatar:generation-cancel',
  'avatar:generation-confirm-concept',
  'avatar:generation-list',
  'avatar:generation-preview',
  'avatar:generation-redraw-views',
  'avatar:generation-reject',
  'avatar:generation-remove-background',
  'avatar:generation-restore-background',
  'avatar:generation-start',
  'avatar:generation-status',
  'avatar:idle-habits:set',
  'avatar:image-loras-select',
  'avatar:image-model-select',
  'avatar:image-models',
  'avatar:prompt:set-preference',
  'avatar:trigger-behavior',
  'avatar:voice:set-preference',
  'avatars:add',
  'avatars:remove',
  'avatars:update',
  // Backgrounds and rooms: authoring.
  'background:delete',
  'background:generate',
  'background:set-active',
  'rooms:cancel-generate',
  'rooms:delete',
  'rooms:generate',
  'rooms:generated:delete',
  'rooms:generated:list',
  'rooms:idle-settings:set',
  'rooms:object-settings:set',
  // Coding, memory, tools.
  'coding:answer-task',
  'coding:apply-task',
  'coding:cancel-task',
  'coding:diff',
  'coding:discard-task',
  'coding:follow-up',
  'coding:get',
  'coding:pick-folder',
  'coding:pick-gguf',
  'coding:set',
  'coding:start-task',
  'coding:status',
  'coding:suggest-checks',
  'coding:task',
  'coding:tasks',
  'coding:task-event',
  'mcp:add-server',
  'mcp:connect-server',
  'mcp:delete-server',
  'mcp:disconnect-server',
  'mcp:execute-tool',
  'mcp:get-tool-definitions',
  'mcp:list-servers',
  'mcp:list-tools',
  'mcp:server-status-changed',
  'mcp:test-connection',
  'mcp:tools-discovered',
  'mcp:update-server',
  'mcp:update-tool-preferences',
  'memory-engine:add-fact',
  'memory-engine:delete-fact',
  'memory-engine:facts',
  'memory-engine:forget-session',
  'memory-engine:memory',
  'memory-engine:recall-log',
  'memory-engine:review-facts',
  'memory-engine:run-summaries',
  'memory-engine:search',
  'memory-engine:status',
  'memory-engine:timeline',
  'memory-engine:update-fact',
  'approvals:approve',
  'approvals:changed',
  'approvals:decline',
  'switchboard:status',
  'diagnostics:gpu-memory',
  // Voice on bija: resetting its history, the chatter switch, do-not-disturb.
  'local-voice:reset',
  'floor:get-hear-chatter',
  'floor:set-hear-chatter',
  'presence:set-dnd',
  // Wake words are trained and heard on bija. The talk key's events come from this PC's own main process, and so
  // does the gate's: bija may ask devices off but never on, so it never gets to push `device-gate:changed`.
  'device-gate:changed',
  'wake-word:cancel-training',
  'wake-word:event',
  'wake-word:get-training-status',
  'wake-word:peak',
  'wake-word:train',
  'wake-word:training-status',
  'talk:shortcut-status',
  'talk:trigger',
  'camera:emit-detection',
  // Conversation events: the satellite's renderer keeps its own transcript from its own turns.
  'conversation:message-appended',
  'conversation:session-started',
  // Room generation progress, and bija's own pairing and admin pages.
  'rooms:generate-progress',
  'room-hub:cancel-pairing',
  'room-hub:changed',
  'room-hub:rename',
  'room-hub:revoke',
  'room-hub:set-camera',
  'room-hub:set-room',
  'room-hub:start-pairing',
  'room-hub:status',
] as const;

const KINDS: Record<string, ChannelKind> = {};
function add(kind: ChannelKind, channels: readonly string[]): void {
  for (const channel of channels) {
    if (KINDS[channel]) throw new Error(`Satellite channel ${channel} is listed twice.`);
    KINDS[channel] = kind;
  }
}
add('forward', FORWARD);
add('local', LOCAL);
add('event', EVENT);
add('unavailable', UNAVAILABLE);

export function channelKind(channel: string): ChannelKind | undefined {
  return Object.hasOwn(KINDS, channel) ? KINDS[channel] : undefined;
}

export function channelsOfKind(kind: ChannelKind): string[] {
  return Object.keys(KINDS).filter((channel) => KINDS[channel] === kind);
}

/** The events a satellite hands on to its renderer. Anything else bija sends is dropped. */
export function isDeliverableEvent(channel: unknown): channel is string {
  return typeof channel === 'string' && channelKind(channel) === 'event';
}
