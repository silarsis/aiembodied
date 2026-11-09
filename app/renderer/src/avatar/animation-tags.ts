export const ANIMATION_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isValidAnimationSlug(slug: string): boolean {
  return ANIMATION_SLUG_PATTERN.test(slug);
}

export function toAnimationSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

export interface AvatarTag {
  type: 'anim' | 'pose';
  slug: string;
}

export interface AvatarMoveTag {
  type: 'move';
  /** Free-text description of the movement, sent to the local motion model. */
  text: string;
}

const MAX_MOVE_TEXT_LENGTH = 200;

/**
 * Extract free-text movement tags: {move:<description>}, e.g. {move:shrugs with both shoulders}.
 */
export function extractMoveTags(text: string): AvatarMoveTag[] {
  const results: AvatarMoveTag[] = [];
  for (const match of text.matchAll(/\{move:([^}]+)\}/gi)) {
    const description = (match[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MOVE_TEXT_LENGTH);
    if (description) {
      results.push({ type: 'move', text: description });
    }
  }
  return results;
}

export type SceneTag =
  | { type: 'go'; object: string }
  | { type: 'sit'; object: string }
  | { type: 'stand' }
  | { type: 'look'; object: string }
  | { type: 'pick'; object: string }
  | { type: 'put'; object: string; surface: string }
  | { type: 'come' };

/** A tag in the order it was written: a free-text movement or a scene action. */
export type MotionTag = AvatarMoveTag | SceneTag;

/** Tag names that are never animation slugs, so the legacy `{slug}` form must skip them. */
const SCENE_TAG_NAMES = new Set(['go', 'sit', 'stand', 'look', 'pick', 'put', 'come']);

const MOTION_TAG_PATTERN = /\{(move|go|sit|stand|look|pick|put|come)(?::([^}]*))?\}/gi;
const MAX_OBJECT_REF_LENGTH = 60;

function cleanRef(value: string | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_OBJECT_REF_LENGTH);
}

/** `mug@side table`, `mug on the side table` or `mug onto side table`. */
function splitPut(argument: string): { object: string; surface: string } | null {
  const at = argument.split('@');
  const parts = at.length === 2 ? at : argument.split(/\s+(?:on top of|onto|on)\s+/i);
  if (parts.length !== 2) return null;
  const object = cleanRef(parts[0]);
  const surface = cleanRef(parts[1]);
  return object && surface ? { object, surface } : null;
}

/**
 * Extract the tags that move the body, in the order they were written: {move:<text>} plus the
 * scene tags {go:<object>}, {sit:<object>}, {stand}, {look:<object>}, {pick:<object>},
 * {put:<object>@<surface>} (or "{put:<object> on <surface>}") and {come}. Object names are
 * returned as written; match them against a room with `resolveObjectRef`.
 */
export function extractMotionTags(text: string): MotionTag[] {
  const results: MotionTag[] = [];
  for (const match of text.matchAll(MOTION_TAG_PATTERN)) {
    const name = (match[1] ?? '').toLowerCase();
    const argument = match[2];
    if (name === 'move') {
      const description = (argument ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_MOVE_TEXT_LENGTH);
      if (description) results.push({ type: 'move', text: description });
    } else if (name === 'stand' || name === 'come') {
      if (argument === undefined) results.push({ type: name });
    } else if (name === 'put') {
      const put = argument === undefined ? null : splitPut(argument);
      if (put) results.push({ type: 'put', ...put });
    } else {
      const object = cleanRef(argument);
      if (object) results.push({ type: name as 'go' | 'sit' | 'look' | 'pick', object });
    }
  }
  return results;
}

/** Only the scene actions of `extractMotionTags`. */
export function extractSceneTags(text: string): SceneTag[] {
  return extractMotionTags(text).filter((tag): tag is SceneTag => tag.type !== 'move');
}

/**
 * Extract avatar control tags from text.
 * Supports two formats:
 * - {anim:<slug>} for animations
 * - {pose:<slug>} for poses
 * - {<slug>} for animations (legacy format, backward compatible)
 */
export function extractAvatarTags(
  text: string,
  options: {
    allowedAnimationSlugs?: Iterable<string> | null;
    allowedPoseSlugs?: Iterable<string> | null;
  } = {},
): AvatarTag[] {
  const allowedAnims = options.allowedAnimationSlugs ? new Set(options.allowedAnimationSlugs) : null;
  const allowedPoses = options.allowedPoseSlugs ? new Set(options.allowedPoseSlugs) : null;
  const results: AvatarTag[] = [];
  // Match {anim:slug}, {pose:slug}, or {slug}; {move:...} is handled by extractMoveTags
  const regex = /\{((?:anim|pose|move):)?([^}]+)\}/gi;

  for (const match of text.matchAll(regex)) {
    if (match[1]?.toLowerCase() === 'move:') {
      continue;
    }
    const prefix = match[1]?.toLowerCase().replace(':', '') ?? '';
    const candidate = match[2]?.trim() ?? '';

    if (!candidate) {
      continue;
    }
    if (!isValidAnimationSlug(candidate)) {
      continue;
    }
    if (!prefix && SCENE_TAG_NAMES.has(candidate)) {
      // {stand} and {come} are scene actions, not animations of those names.
      continue;
    }

    if (prefix === 'pose') {
      // Explicit pose tag
      if (allowedPoses && !allowedPoses.has(candidate)) {
        continue;
      }
      results.push({ type: 'pose', slug: candidate });
    } else {
      // Explicit anim tag or legacy format (no prefix) - treat as animation
      if (allowedAnims && !allowedAnims.has(candidate)) {
        continue;
      }
      results.push({ type: 'anim', slug: candidate });
    }
  }

  return results;
}

/**
 * @deprecated Use extractAvatarTags instead for typed tag extraction
 */
export function extractAnimationTags(
  text: string,
  options: {
    allowedSlugs?: Iterable<string> | null;
  } = {},
): string[] {
  const tags = extractAvatarTags(text, { allowedAnimationSlugs: options.allowedSlugs });
  return tags.filter(t => t.type === 'anim').map(t => t.slug);
}
