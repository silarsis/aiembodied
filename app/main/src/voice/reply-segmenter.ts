/**
 * Splits a streamed LLM reply into pieces that can be spoken as soon as they are complete, so
 * text-to-speech of the first sentence overlaps generation of the rest. Never cuts inside an
 * avatar tag such as {move:waves hello}.
 */

const SENTENCE_END = /[.!?…]/;
// With no sentence end in sight, cut a long run at a comma so the first audio isn't held back.
const SOFT_CUT_LENGTH = 140;

export class ReplySegmenter {
  private buffer = '';

  push(delta: string): string[] {
    this.buffer += delta;
    const segments: string[] = [];
    let cut: number;
    while ((cut = this.findCut()) > 0) {
      const segment = this.buffer.slice(0, cut);
      this.buffer = this.buffer.slice(cut);
      if (segment.trim()) {
        segments.push(segment.trim());
      }
    }
    return segments;
  }

  flush(): string[] {
    const rest = this.buffer.trim();
    this.buffer = '';
    return rest ? [rest] : [];
  }

  /** Index just past the first safe cut point, or 0 when the buffer has none yet. */
  private findCut(): number {
    let depth = 0;
    let softCut = 0;
    for (let i = 0; i < this.buffer.length; i += 1) {
      const char = this.buffer[i];
      if (char === '{') {
        depth += 1;
      } else if (char === '}') {
        depth = Math.max(0, depth - 1);
      } else if (depth === 0) {
        if (char === '\n' && this.buffer.slice(0, i).trim()) {
          return i + 1;
        }
        const next = this.buffer[i + 1];
        // Need the following character to know "3." isn't "3.5".
        if (SENTENCE_END.test(char) && next !== undefined && /\s/.test(next)) {
          return i + 1;
        }
        if (char === ',' && next !== undefined && /\s/.test(next)) {
          softCut = i + 1;
        }
      }
    }
    if (depth === 0 && softCut > 0 && this.buffer.length >= SOFT_CUT_LENGTH) {
      return softCut;
    }
    return 0;
  }
}

/** What text-to-speech should say for a segment: no avatar tags, no markdown, no emoji. */
export function toSpeakable(segment: string): string {
  return segment
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/[*_#`~>|]/g, '')
    .replace(/\p{Extended_Pictographic}/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}
