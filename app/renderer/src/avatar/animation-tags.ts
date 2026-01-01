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
  // Match {anim:slug}, {pose:slug}, or {slug}
  const regex = /\{((?:anim|pose):)?([^}]+)\}/gi;

  for (const match of text.matchAll(regex)) {
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
