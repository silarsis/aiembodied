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

export function extractAnimationTags(
  text: string,
  options: {
    allowedSlugs?: Iterable<string> | null;
  } = {},
): string[] {
  const allowed = options.allowedSlugs ? new Set(options.allowedSlugs) : null;
  const results: string[] = [];
  const regex = /\{([^}]+)\}/g;

  for (const match of text.matchAll(regex)) {
    const candidate = match[1]?.trim() ?? '';
    if (!candidate) {
      continue;
    }
    if (!isValidAnimationSlug(candidate)) {
      continue;
    }
    if (allowed && !allowed.has(candidate)) {
      continue;
    }
    results.push(candidate);
  }

  return results;
}
