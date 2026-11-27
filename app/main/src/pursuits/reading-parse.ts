/**
 * Reading the character's answers. The model is asked for a few labelled lines (PICK:, TAKEAWAY:, NEXT: ...)
 * rather than JSON, which small local models get wrong more often. Everything here is forgiving about case,
 * bullets and extra words, and pure.
 */

const URL_PATTERN = /https?:\/\/[^\s<>"')\]]+/i;

/** The first web address in the text, without trailing punctuation. */
export function firstUrl(text: string): string | null {
  const match = URL_PATTERN.exec(text);
  return match ? match[0].replace(/[.,;:]+$/, '') : null;
}

/** The text after `LABEL:` up to the next label or the end, one line or more. Null when the label is missing. */
function field(text: string, label: string, labels: readonly string[]): string | null {
  const others = labels.filter((other) => other !== label).join('|');
  const pattern = new RegExp(
    `(?:^|\\n)[\\s>*#-]*\\**${label}\\**\\s*:\\**\\s*([\\s\\S]*?)(?=\\n[\\s>*#-]*\\**(?:${others})\\**\\s*:|$)`,
    'i',
  );
  const match = pattern.exec(text);
  const value = match?.[1]?.replace(/\s+/g, ' ').trim();
  return value ? value : null;
}

export type Choice =
  | { kind: 'pick'; title: string; link: string | null; why: string }
  | { kind: 'refine'; idea: string }
  | { kind: 'nothing' };

/**
 * "PICK: <title> | <link> | <why>", "REFINE: <idea>" or "NOTHING". A reply without a label is read as a pick
 * of its first line (a model that just names the paper), so a good choice is not thrown away over format.
 */
export function parseChoice(reply: string): Choice {
  const text = reply.trim();
  if (!text) return { kind: 'nothing' };
  const labels = ['PICK', 'REFINE', 'NOTHING'];
  const refine = field(text, 'REFINE', labels);
  const pick = field(text, 'PICK', labels);
  if (pick) {
    const link = firstUrl(pick);
    const parts = pick
      .split('|')
      .map((part) => part.trim())
      .filter(Boolean);
    const title = (parts[0] ?? pick)
      .replace(URL_PATTERN, '')
      .replace(/^["“]|["”]$/g, '')
      .trim();
    const why = parts
      .slice(1)
      .filter((part) => !URL_PATTERN.test(part) || part.length > (link?.length ?? 0) + 3)
      .join(' ')
      .replace(URL_PATTERN, '')
      .trim();
    if (title) return { kind: 'pick', title, link, why };
  }
  if (refine) return { kind: 'refine', idea: refine };
  if (/^\W*nothing\b/i.test(text)) return { kind: 'nothing' };
  const first =
    text
      .split('\n')[0]
      ?.replace(/^[\s>*#-]+/, '')
      .replace(URL_PATTERN, '')
      .replace(/^["“]|["”]$/g, '')
      .trim() ?? '';
  return first
    ? { kind: 'pick', title: first.slice(0, 200), link: firstUrl(text), why: '' }
    : { kind: 'nothing' };
}

export interface ParsedNote {
  takeaway: string;
  opinion: string;
  connection: string;
  questions: string[];
}

const NOTE_LABELS = ['TAKEAWAY', 'OPINION', 'KEVIN', 'QUESTIONS'] as const;

/** "TAKEAWAY: ...  OPINION: ...  KEVIN: ...  QUESTIONS: a | b". Without labels the whole reply is the takeaway. */
export function parseNote(reply: string): ParsedNote {
  const text = reply.trim();
  const takeaway = field(text, 'TAKEAWAY', NOTE_LABELS);
  const opinion = field(text, 'OPINION', NOTE_LABELS) ?? '';
  const connection = field(text, 'KEVIN', NOTE_LABELS) ?? '';
  const rawQuestions = field(text, 'QUESTIONS', NOTE_LABELS) ?? '';
  const questions = rawQuestions
    .split(/\s*(?:\||;|\s-\s|\s\d\.\s)\s*/)
    .map((question) => question.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((question) => question && !/^none\.?$/i.test(question))
    .slice(0, 5);
  return { takeaway: takeaway ?? text.replace(/\s+/g, ' '), opinion, connection, questions };
}

export interface ParsedNext {
  go: 'again' | 'stop';
  /** A short line to tell someone, or null. */
  tell: string | null;
}

/** "NEXT: continue | stop" and "TELL: <one sentence or none>". Anything unclear means stop (be quiet). */
export function parseNext(reply: string): ParsedNext {
  const text = reply.trim();
  const labels = ['NEXT', 'TELL'];
  const next = field(text, 'NEXT', labels);
  const tell = field(text, 'TELL', labels);
  const go = next && /^(continue|more|again|keep|go on|another)/i.test(next) ? 'again' : 'stop';
  const line = tell && !/^(none|nothing|no|n\/a|-)\W*$/i.test(tell) ? tell : null;
  return { go, tell: line };
}

/** Cut text into pieces of at most `size` characters, at a paragraph or sentence end where there is one. */
export function splitChunks(text: string, size: number): string[] {
  const chunks: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    const window = rest.slice(0, size);
    const paragraph = window.lastIndexOf('\n\n');
    const sentence = Math.max(window.lastIndexOf('. '), window.lastIndexOf('.\n'));
    const cut =
      paragraph > size * 0.5 ? paragraph + 2 : sentence > size * 0.5 ? sentence + 2 : size;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) chunks.push(rest);
  return chunks;
}

/** A link for the title, found in the results right after it (else just before it): the model forgot to repeat it. */
export function linkNear(results: string, title: string): string | null {
  const at = results.toLowerCase().indexOf(title.toLowerCase());
  if (at < 0) return null;
  return (
    firstUrl(results.slice(at, at + title.length + 300)) ??
    firstUrl(results.slice(Math.max(0, at - 150), at))
  );
}
