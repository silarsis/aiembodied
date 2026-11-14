import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NOT_ON_SATELLITE, channelKind, channelsOfKind, isDeliverableEvent } from '../../src/satellite/channels.js';
import { SATELLITE_CHANNELS } from '../../src/room-hub/allowlist.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// The bridge's channel list lives in bridge/create-bridge.ts (preload.ts only plugs ipcRenderer into it).
const preload = ['../../src/preload.ts', '../../src/bridge/create-bridge.ts'].map((file) => readFileSync(path.resolve(here, file), 'utf8')).join('\n');

/** Every channel name in preload.ts and the bridge it builds: a quoted `group:name` string. (`preload:bridge-exposed` is a log message, not a channel.) */
const PRELOAD_CHANNELS = [...new Set([...preload.matchAll(/'([a-z][a-z0-9-]*(?::[a-z0-9-]+)+)'/g)].map((match) => match[1]))].filter((name) => name !== 'preload:bridge-exposed');

describe('satellite channels', () => {
  it('reads a sensible number of channels from the preload script', () => {
    expect(PRELOAD_CHANNELS.length).toBeGreaterThan(150);
    expect(PRELOAD_CHANNELS).toContain('local-voice:respond');
    expect(PRELOAD_CHANNELS).toContain('places:changed');
  });

  it('classifies every channel the preload script uses (add new channels to satellite/channels.ts)', () => {
    const unclassified = PRELOAD_CHANNELS.filter((channel) => channelKind(channel) === undefined);
    expect(unclassified).toEqual([]);
  });

  it('lists no channel the preload script does not use, except the satellite ones', () => {
    const known = new Set([...PRELOAD_CHANNELS, 'satellite:status', 'satellite:pair', 'satellite:forget', 'wake-word:model']);
    const stale = ['forward', 'local', 'unavailable', 'event'].flatMap((kind) => channelsOfKind(kind as 'forward')).filter((channel) => !known.has(channel));
    expect(stale).toEqual([]);
  });

  it('forwards exactly what bija\'s hub allows', () => {
    const forwarded = new Set(channelsOfKind('forward'));
    const notAllowed = [...forwarded].filter((channel) => !SATELLITE_CHANNELS.has(channel));
    const notForwarded = [...SATELLITE_CHANNELS].filter((channel) => !forwarded.has(channel));
    expect(notAllowed).toEqual([]);
    expect(notForwarded).toEqual([]);
  });

  it('never forwards settings, models, keys, avatars, coding, generation, uploads, deletes or app control', () => {
    // The tag instructions are the one write allowed: bija keeps them per place.
    const risky = /^(?!avatars:set-tag-instructions$)(config:(set|clear|get-secret|test)|models:|mcp:|coding:|memory-engine:|approvals:(approve|decline)|app:|realtime:|room-hub:|wake-word:(train|cancel)|avatars:(add|update|remove)|avatar:generation|avatar-(model|animation|pose):(upload|delete|generate|set-active|update|rename|refine|evaluate)|background:(set-active|generate|delete)|rooms:(generate|cancel|delete|generated)|.*:set-)/;
    const bad = channelsOfKind('forward').filter((channel) => risky.test(channel));
    expect(bad).toEqual([]);
  });

  it('answers on this PC for the config, devices, window and pairing', () => {
    for (const channel of ['config:get', 'app:quit', 'satellite:status', 'satellite:pair', 'satellite:forget', 'talk:get-shortcut-status']) {
      expect(channelKind(channel), channel).toBe('local');
    }
  });

  it('rejects settings and tools with the satellite message, and only bija\'s pushed events get through', () => {
    expect(NOT_ON_SATELLITE).toBe('Not available on a satellite PC.');
    for (const channel of ['models:set-key', 'config:set-secret', 'coding:start-task', 'avatars:add']) expect(channelKind(channel)).toBe('unavailable');
    expect(isDeliverableEvent('local-voice:event')).toBe(true);
    expect(isDeliverableEvent('avatar-motion:chunk')).toBe(true);
    expect(isDeliverableEvent('places:changed')).toBe(true);
    expect(isDeliverableEvent('config:get')).toBe(false);
    expect(isDeliverableEvent('mcp:execute-tool')).toBe(false);
    expect(isDeliverableEvent(42)).toBe(false);
    expect(channelKind('constructor')).toBeUndefined();
  });
});
