/**
 * Reading what the "Idle thoughts" model answered, checking it against the room, writing it back
 * as tags for the scene executor, and the random picker used when the model gives nothing usable.
 * Everything here is pure; the director (idle-director.ts) supplies the random numbers.
 */
import type { RoomFile, RoomObject } from '../../../main/src/rooms/types.js';
import { extractMotionTags } from '../avatar/animation-tags.js';
import { resolveObjectRef } from './scene-actions.js';
import type { IdleInput, IdleTag } from './idle-types.js';

export const MAX_IDLE_TAGS = 3;
const FALLBACK_MOVE = 'looks around';
/** Chance, when seated, of staying put rather than standing up. */
const STAY_SEATED = 0.6;
/** A walk home is only offered when the avatar is this far (metres) from the home spot. */
const FAR_FROM_HOME = 1.5;
const COME_WEIGHT = 0.3;

const WAIT_TAG = /\{\s*wait\s*\}/i;
const FIRST_ACTION_TAG = /\{\s*(?:move|go|sit|stand|look|pick|put|come)\b/i;

const find = (room: RoomFile, ref: string): RoomObject | null => resolveObjectRef(room, ref);

/** True when the model's first tag is {wait}: do nothing this time. */
export function startsWithWait(text: string): boolean {
  const wait = text.search(WAIT_TAG);
  if (wait < 0) return false;
  const action = text.search(FIRST_ACTION_TAG);
  return action < 0 || wait < action;
}

/**
 * The tags of the model's reply that make sense right now: at most 3, in order. Only scene tags,
 * {move:} and {wait} count; objects must exist, be visible to the room camera and have the tag the
 * action needs. Objects come back as their ids.
 */
export function parseIdleReply(text: string, input: IdleInput): IdleTag[] {
  if (startsWithWait(text)) return [{ type: 'wait' }];
  const visible = new Set(input.visible.map((object) => object.id));
  const { room, state } = input;
  const usable = (ref: string, needs: (object: RoomObject) => boolean): RoomObject | null => {
    const object = find(room, ref);
    return object && visible.has(object.id) && needs(object) ? object : null;
  };
  const tags: IdleTag[] = [];
  let seated = state.posture === 'seated';
  let held = state.held?.objectId ?? null;
  for (const tag of extractMotionTags(text)) {
    if (tags.length >= MAX_IDLE_TAGS) break;
    switch (tag.type) {
      case 'move':
        tags.push({ type: 'move', text: tag.text });
        break;
      case 'come':
        tags.push({ type: 'come' });
        seated = false;
        break;
      case 'stand':
        if (seated) {
          tags.push({ type: 'stand' });
          seated = false;
        }
        break;
      case 'go':
      case 'look': {
        const object = usable(tag.object, (o) => Boolean(o.tags?.stand || o.tags?.look));
        if (object) {
          tags.push({ type: tag.type, object: object.id });
          if (tag.type === 'go') seated = false;
        }
        break;
      }
      case 'sit': {
        const object = usable(tag.object, (o) => Boolean(o.tags?.sit));
        if (object) {
          tags.push({ type: 'sit', object: object.id });
          seated = true;
        }
        break;
      }
      case 'pick': {
        const object = usable(tag.object, (o) => Boolean(o.tags?.grab && o.dynamic));
        if (object && !held) {
          tags.push({ type: 'pick', object: object.id });
          held = object.id;
        }
        break;
      }
      case 'put': {
        const object = find(room, tag.object);
        const surface = usable(tag.surface, (o) => Boolean(o.tags?.surface));
        if (object && surface && held === object.id) {
          tags.push({ type: 'put', object: object.id, surface: surface.id });
          held = null;
        }
        break;
      }
    }
  }
  return tags;
}

/** Tags as the text the scene executor reads, the same as the assistant would write them. */
export function idleTagsToText(tags: readonly IdleTag[]): string {
  return tags
    .map((tag) => {
      switch (tag.type) {
        case 'stand':
        case 'come':
        case 'wait':
          return `{${tag.type}}`;
        case 'move':
          return `{move:${tag.text.replace(/[{}]/g, '')}}`;
        case 'put':
          return `{put:${tag.object}@${tag.surface}}`;
        default:
          return `{${tag.type}:${tag.object}}`;
      }
    })
    .join('');
}

/** The object ids a list of tags is about (what "avoid the last targets" looks at). */
export function idleTargets(tags: readonly IdleTag[]): string[] {
  const ids: string[] = [];
  for (const tag of tags) {
    if ('object' in tag) ids.push(tag.object);
    if (tag.type === 'put') ids.push(tag.surface);
  }
  return ids;
}

/** A line for the log of what happened, such as "walked to the bookshelf (browses the books)". */
export function describeIdleTags(tags: readonly IdleTag[], room: RoomFile): string {
  const name = (id: string) => room.objects.find((object) => object.id === id)?.name ?? id;
  const parts: string[] = [];
  for (const tag of tags) {
    switch (tag.type) {
      case 'go':
        parts.push(`walked to the ${name(tag.object)}`);
        break;
      case 'look':
        parts.push(`looked at the ${name(tag.object)}`);
        break;
      case 'sit':
        parts.push(`sat down on the ${name(tag.object)}`);
        break;
      case 'stand':
        parts.push('stood up');
        break;
      case 'come':
        parts.push('walked back to the middle of the room');
        break;
      case 'pick':
        parts.push(`picked up the ${name(tag.object)}`);
        break;
      case 'put':
        parts.push(`put the ${name(tag.object)} on the ${name(tag.surface)}`);
        break;
      case 'move': {
        const text = tag.text.replace(/^an? (?:person|character)\s+/i, '');
        if (parts.length > 0) parts[parts.length - 1] += ` (${text})`;
        else parts.push(text);
        break;
      }
      case 'wait':
        break;
    }
  }
  return parts.join(' and ');
}

interface Candidate {
  tags: IdleTag[];
  weight: number;
  targets: string[];
}

function candidates(input: IdleInput): Candidate[] {
  const { state, room } = input;
  const found: Candidate[] = [];
  for (const object of input.visible) {
    const tags = object.tags ?? {};
    if (tags.sit)
      found.push({ tags: [{ type: 'sit', object: object.id }], weight: 1, targets: [object.id] });
    if (tags.stand || tags.look) {
      found.push({
        tags: [
          { type: 'go', object: object.id },
          { type: 'move', text: tags.idle || FALLBACK_MOVE },
        ],
        weight: tags.idle ? 1.5 : 1,
        targets: [object.id],
      });
    }
    if (tags.grab && object.dynamic && !state.held) {
      found.push({ tags: [{ type: 'pick', object: object.id }], weight: 1, targets: [object.id] });
    }
    if (tags.surface && state.held) {
      found.push({
        tags: [{ type: 'put', object: state.held.objectId, surface: object.id }],
        weight: 1,
        targets: [object.id],
      });
    }
  }
  const home = room.home.position;
  if (Math.hypot(input.position[0] - home[0], input.position[2] - home[2]) > FAR_FROM_HOME) {
    found.push({ tags: [{ type: 'come' }], weight: COME_WEIGHT, targets: [] });
  }
  return found;
}

/**
 * What to do when the model gave nothing usable (or could not be asked): a weighted random pick
 * from what the visible objects allow, avoiding the last two targets. Seated, it mostly stays put.
 * Returns `[{ type: 'wait' }]` when there is nothing to do.
 */
export function fallbackIdleTags(
  input: IdleInput,
  random: () => number,
  recentTargets: readonly string[] = [],
): IdleTag[] {
  if (input.state.posture === 'seated') {
    return random() < STAY_SEATED ? [{ type: 'wait' }] : [{ type: 'stand' }];
  }
  const all = candidates(input);
  const avoid = new Set(recentTargets.slice(-2));
  const fresh = all.filter((candidate) => !candidate.targets.some((id) => avoid.has(id)));
  const pool = fresh.length > 0 ? fresh : all;
  if (pool.length === 0) return [{ type: 'wait' }];
  const total = pool.reduce((sum, candidate) => sum + candidate.weight, 0);
  let roll = random() * total;
  for (const candidate of pool) {
    roll -= candidate.weight;
    if (roll < 0) return candidate.tags;
  }
  return pool[pool.length - 1]?.tags ?? [{ type: 'wait' }];
}
