/**
 * Detects a model that has run away: a small local model can degenerate into "2-2-2-2-2-..." and go on for
 * hundreds of repeats. Checked on the reply as it streams, so the stream can be stopped and nothing spoken or saved.
 */

/** A chunk of at most 8 characters repeated this many times in a row is a runaway. */
export const RUNAWAY_REPEATS = 20;
/** Only the end of the text is looked at, so the check stays cheap on a long reply. */
const WINDOW_CHARS = 400;
/** A window this long with this few different characters (compared to its length) is a runaway. */
const LOW_VARIETY_CHARS = 300;
const LOW_VARIETY_RATIO = 0.03;

/** The line spoken instead of a runaway reply. */
export const RUNAWAY_FALLBACK_LINE = 'Sorry, I lost my train of thought.';

// A short chunk followed by 19 or more copies of itself.
const REPEATED_CHUNK = new RegExp(`(.{1,8}?)\\1{${RUNAWAY_REPEATS - 1},}`, 'gs');

/** True when `text` ends in (or contains, near its end) a short chunk repeated many times, or is nearly all one few characters. */
export function isRunawayOutput(text: string): boolean {
  const window = text.slice(-WINDOW_CHARS);
  for (const match of window.matchAll(REPEATED_CHUNK)) {
    // A line of dashes or equals signs is formatting, not a loop.
    if (/[\p{L}\p{N}]/u.test(match[1])) return true;
  }
  if (window.length >= LOW_VARIETY_CHARS) {
    const tail = window.slice(-LOW_VARIETY_CHARS);
    if (new Set(tail).size / tail.length < LOW_VARIETY_RATIO) return true;
  }
  return false;
}
