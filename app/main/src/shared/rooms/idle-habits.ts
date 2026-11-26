/** What a character likes to do when nobody is talking, kept per avatar (see the Character pop-up). */
export const MAX_IDLE_HABITS_LENGTH = 500;

/** Trimmed text, at most 500 characters; anything that is not text is empty. */
export function normalizeIdleHabits(value: unknown): string {
  return typeof value === 'string' ? value.trim().slice(0, MAX_IDLE_HABITS_LENGTH).trim() : '';
}
