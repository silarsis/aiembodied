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
