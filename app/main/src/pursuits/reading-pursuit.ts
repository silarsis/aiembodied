/**
 * Reading as a character's own pursuit. The character asks itself what it wants to read, searches the library
 * tools of its station, picks something, reads it (in pieces when it is long), writes notes in its own voice,
 * and decides whether to go on, stop, or tell someone. Every step is a model call it makes in the first person,
 * with its own persona as the system message.
 *
 * Plain state machine over `Pursuit` (pursuit.ts): this file knows what each step asks, nothing about
 * Electron, rooms or bodies.
 */
import type { RegisteredTool } from '../tools/tool-registry.js';
import type { ChooseResult, NextResult, Pursuit, PursuitEnd } from './pursuit.js';
import { clip, type PursuitLlm } from './pursuit-llm.js';
import { linkNear, parseChoice, parseNext, parseNote, splitChunks } from './reading-parse.js';
import type { NewReadingNote, ReadingNoteStore } from './types.js';
import type { ReadingNote } from '../shared/pursuits/types.js';

/** Model calls with tools while looking something up, and while fetching the chosen item. */
export const MAX_QUERY_ROUNDS = 3;
export const MAX_FETCH_ROUNDS = 3;
/** Characters of the library's answer kept for the choice. */
export const RESULTS_CHARS = 6000;
/** One chunk of a long text; it has to fit the context with the running summary and the prompt around it. */
export const CHUNK_CHARS = 6000;
/** Most chunks read of one item (about 36k characters); the rest is left unread, and the notes say so. */
export const MAX_CHUNKS = 6;
/** Tool calls one session may make in all. */
export const MAX_TOOL_CALLS = 30;
/** Lines for Kevin one session may hand to the inbox. */
export const MAX_TELLS = 2;
/** Consecutive wishes that found nothing before the session gives up. */
export const MAX_EMPTY_WISHES = 2;
const RECENT_NOTES_IN_PROMPT = 5;
const RECENT_QUESTIONS_IN_PROMPT = 5;
const RECENT_LINES_IN_PROMPT = 6;
const BRIEF_CHARS = 1500;

/** What the body does for each step ("browses the shelf"). The bookshelf is named from the station. */
export function readingActivity(step: string, objectName: string): string {
  switch (step) {
    case 'want':
      return `stands at the ${objectName}, thinking about what to read`;
    case 'act':
      return `browses the ${objectName}`;
    case 'choose':
      return `looks over the titles on the ${objectName}`;
    case 'consume':
      return 'reads';
    case 'note':
      return 'jots down notes';
    default:
      return 'closes the book and thinks';
  }
}

/** The part of the system message that is about this activity; the persona goes in front of it. */
export function readingGuidance(name: string, objectName: string): string {
  return [
    `You are ${name}. This is your own free time: nobody is talking to you, and nobody asked you to do this.`,
    `You are at the ${objectName}, deciding for yourself what to read and what you think of it.`,
    'Everything you write here is for yourself. Write in the first person, in your own voice, as plain text with no markdown and no emoji.',
    'Follow the answer format a question asks for exactly.',
  ].join(' ');
}

export interface ReadingMemory {
  /** What long-term memory knows (about Kevin, recent days); null when it has nothing or is unavailable. */
  brief(): Promise<string | null>;
}

export interface ReadingPursuitDeps {
  avatarId: string;
  avatarName: string;
  stationId: string;
  /** "bookshelf" */
  objectName: string;
  llm: PursuitLlm;
  /** Only the tools of the station. */
  tools: RegisteredTool[];
  /** What it likes doing when idle (its idle habits). */
  habits: string;
  /** The last few lines of its conversations, oldest first. */
  recentLines: () => string[];
  memory?: ReadingMemory;
  notes: ReadingNoteStore;
  /** Also keep the note in long-term memory. Must not throw or wait. */
  saveToMemory: (note: ReadingNote) => void;
  /** Hand a short line to the avatar's inbox, as an update from itself (the decide step may ignore, keep or say it). */
  tell: (text: string) => void;
  now?: () => number;
  logger?: Pick<Console, 'info' | 'warn'>;
}

/** What the session has in hand for the item it is reading. */
interface Item {
  title: string;
  link: string | null;
  why: string;
}

export class ReadingPursuit implements Pursuit {
  readonly kind = 'reading';

  private curiosity = '';
  private refineIdea = '';
  private results = '';
  private item: Item | null = null;
  /** Running summary of the item being read (or the text itself when it is short). */
  private summary = '';
  /** The item was read to the end of what fit; says so in the notes when it did not. */
  private unreadNote = '';
  private noted = false;
  private brief: string | null = null;
  private emptyWishes = 0;
  private tells = 0;
  private readonly readTitles: string[] = [];
  private readonly notesMade: ReadingNote[] = [];

  constructor(private readonly deps: ReadingPursuitDeps) {}

  /** The notes this session wrote. */
  get written(): readonly ReadingNote[] {
    return this.notesMade;
  }

  // -- want ---------------------------------------------------------------------------------------

  async want(signal: AbortSignal): Promise<void> {
    this.curiosity = '';
    this.refineIdea = '';
    this.results = '';
    this.item = null;
    this.summary = '';
    this.unreadNote = '';
    this.noted = false;

    if (this.brief === null) {
      this.brief = clip((await this.deps.memory?.brief().catch(() => null)) ?? '', BRIEF_CHARS);
    }
    const earlier = this.deps.notes.listReadingNotes(this.deps.avatarId, RECENT_NOTES_IN_PROMPT);
    const questions = earlier
      .flatMap((note) => note.questions)
      .slice(0, RECENT_QUESTIONS_IN_PROMPT);
    const lines = this.deps.recentLines().slice(-RECENT_LINES_IN_PROMPT);
    const prompt = [
      this.deps.habits.trim()
        ? `What you like doing when you are by yourself: ${this.deps.habits.replace(/\s+/g, ' ').trim()}`
        : '',
      lines.length > 0 ? `What you were talking about lately:\n${lines.join('\n')}` : '',
      this.brief ? `What you remember:\n${this.brief}` : '',
      earlier.length > 0
        ? `What you read lately:\n${earlier.map((note) => `- ${note.title}: ${clip(note.takeaway, 160)}`).join('\n')}`
        : 'You have not read anything here yet.',
      questions.length > 0
        ? `Questions you still have:\n${questions.map((question) => `- ${question}`).join('\n')}`
        : '',
      this.readTitles.length > 0
        ? `You already read these in this visit, so pick something else: ${this.readTitles.join('; ')}.`
        : '',
      '',
      'What do you feel like reading about right now? Answer with one sentence in the first person, starting with "I want to".',
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n');
    const reply = await this.deps.llm.ask(prompt, signal);
    this.curiosity =
      clip(
        reply
          .split('\n')
          .find((line) => line.trim())
          ?.trim() ?? '',
        300,
      ) || 'I want to read something that interests me.';
    this.deps.logger?.info('Reading: wish', {
      avatarId: this.deps.avatarId,
      curiosity: this.curiosity,
    });
  }

  // -- act ----------------------------------------------------------------------------------------

  async act(signal: AbortSignal): Promise<void> {
    const names = this.deps.tools.map((tool) => tool.toolName).join(', ');
    const prompt = [
      `You wish: ${this.curiosity}`,
      this.refineIdea
        ? `Last time you looked, nothing was quite right. This time look for: ${this.refineIdea}`
        : '',
      `Look in the library now. Call one of its tools (${names}) to search or list what is there, with your own words as the query. Do not answer from memory.`,
    ]
      .filter(Boolean)
      .join('\n');
    const { results } = await this.deps.llm.useTools(
      prompt,
      this.deps.tools,
      MAX_QUERY_ROUNDS,
      signal,
    );
    const found = results
      .filter((result) => result.ok)
      .map((result) => `[${result.name} ${clip(result.arguments, 120)}]\n${result.text}`)
      .join('\n\n');
    // Only what the library really returned counts; a model that answered without looking has found nothing.
    this.results = clip(found, RESULTS_CHARS);
  }

  // -- choose -------------------------------------------------------------------------------------

  async choose(signal: AbortSignal): Promise<ChooseResult> {
    if (!this.results.trim()) {
      this.emptyWishes += 1;
      return 'nothing';
    }
    const prompt = [
      `You wished: ${this.curiosity}`,
      `Here is what the library showed you:\n${this.results}`,
      this.readTitles.length > 0 ? `You already read: ${this.readTitles.join('; ')}.` : '',
      '',
      'Choose ONE thing to read, or ask to look again. Answer in exactly one of these forms:',
      'PICK: <exact title> | <its link, if shown> | <why you chose it, one sentence>',
      'REFINE: <what to look for instead>',
      'NOTHING',
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n');
    const choice = parseChoice(await this.deps.llm.ask(prompt, signal));
    if (choice.kind === 'refine') {
      this.refineIdea = choice.idea;
      return 'refine';
    }
    if (choice.kind === 'nothing') {
      this.emptyWishes += 1;
      return 'nothing';
    }
    this.item = {
      title: choice.title,
      link: choice.link ?? linkNear(this.results, choice.title),
      why: choice.why,
    };
    return 'consume';
  }

  // -- consume ------------------------------------------------------------------------------------

  async consume(signal: AbortSignal): Promise<void> {
    const item = this.item;
    if (!item) return;
    const prompt = [
      `You chose to read "${item.title}"${item.link ? ` (${item.link})` : ''}.`,
      'Fetch its full text now with the library tools (use the link or id the library gave). Do not answer from memory.',
    ].join('\n');
    const { results } = await this.deps.llm.useTools(
      prompt,
      this.deps.tools,
      MAX_FETCH_ROUNDS,
      signal,
    );
    const fetched = results.filter((result) => result.ok).map((result) => result.text);
    // The longest answer is the text itself; when nothing could be fetched the character reads what the search showed.
    const text = fetched.sort((a, b) => b.length - a.length)[0] ?? this.results;

    const chunks = splitChunks(text, CHUNK_CHARS);
    const read = chunks.slice(0, MAX_CHUNKS);
    if (chunks.length > read.length) {
      this.unreadNote = `I only read the first ${read.length} of ${chunks.length} parts.`;
    }
    if (read.length <= 1) {
      this.summary = read[0] ?? '';
      return;
    }
    // A long text, read in pieces. The running summary is all that is carried from one piece to the next.
    for (let index = 0; index < read.length; index += 1) {
      const reply = await this.deps.llm.ask(
        [
          `You are reading "${item.title}", part ${index + 1} of ${read.length}.`,
          this.summary ? `What you have taken from the earlier parts:\n${this.summary}` : '',
          `This part:\n${read[index]}`,
          '',
          'Update your running summary in the first person, in under 150 words: what matters so far, what surprised you. Reply with the summary only.',
        ]
          .filter((line, at, all) => line !== '' || all[at - 1] !== '')
          .join('\n'),
        signal,
      );
      if (reply) this.summary = reply;
      // Keep going from the part that was read when a call returns nothing: the summary so far still stands.
    }
  }

  // -- note ---------------------------------------------------------------------------------------

  async note(signal: AbortSignal): Promise<void> {
    const item = this.item;
    if (!item) return;
    const prompt = [
      `You just read "${item.title}"${item.link ? ` (${item.link})` : ''}. You went looking because: ${this.curiosity}`,
      item.why ? `You chose it because: ${item.why}` : '',
      `What you took in${this.unreadNote ? ` (${this.unreadNote})` : ''}:\n${clip(this.summary, CHUNK_CHARS)}`,
      this.brief ? `What you remember about Kevin and your life here:\n${this.brief}` : '',
      '',
      'Write your notes for yourself, in your own voice, as exactly these labelled lines:',
      'TAKEAWAY: what you took from it, in a few sentences',
      'OPINION: what you honestly think of it',
      'KEVIN: how it connects to Kevin or to things you care about (or "no link")',
      'QUESTIONS: questions you still have, separated by |  (or "none")',
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n');
    const parsed = parseNote(await this.deps.llm.ask(prompt, signal));
    this.save({
      title: item.title,
      link: item.link,
      takeaway: parsed.takeaway + (this.unreadNote ? ` (${this.unreadNote})` : ''),
      opinion: parsed.opinion,
      connection: /^no link\.?$/i.test(parsed.connection) ? '' : parsed.connection,
      questions: parsed.questions,
      partial: false,
    });
    this.noted = true;
    this.readTitles.push(item.title);
  }

  // -- next ---------------------------------------------------------------------------------------

  async next(signal: AbortSignal): Promise<NextResult> {
    // Two wishes in a row that found nothing: the shelf has nothing for now.
    if (!this.noted && this.emptyWishes >= MAX_EMPTY_WISHES) return 'stop';
    const last = this.noted ? this.notesMade[this.notesMade.length - 1] : undefined;
    const prompt = [
      this.readTitles.length > 0
        ? `So far you read: ${this.readTitles.join('; ')}.`
        : 'You did not find anything to read this time.',
      last ? `Your latest note, "${last.title}": ${clip(last.takeaway, 300)}` : '',
      '',
      'Do you want to read more now, or is that enough for the moment? And is there anything you would like to tell Kevin about, a thing that would really interest him? Answer in exactly this form:',
      'NEXT: continue  (or: stop)',
      'TELL: <one short sentence to Kevin, or none>',
    ]
      .filter((line, index, all) => line !== '' || all[index - 1] !== '')
      .join('\n');
    const answer = parseNext(await this.deps.llm.ask(prompt, signal));
    if (answer.tell && this.tells < MAX_TELLS) {
      this.tells += 1;
      // Never spoken from here: the inbox decides whether to ignore it, remember it or say it.
      this.deps.tell(clip(answer.tell, 300));
    }
    return answer.go;
  }

  // -- finish -------------------------------------------------------------------------------------

  finish(end: PursuitEnd): void {
    // Something was read but not written down yet (Kevin started talking, a call failed): keep what there is.
    if (this.item && !this.noted && this.summary.trim()) {
      this.save({
        title: this.item.title,
        link: this.item.link,
        takeaway: clip(this.summary.replace(/\s+/g, ' ').trim(), 800),
        opinion: '',
        connection: '',
        questions: [],
        partial: true,
      });
      this.noted = true;
    }
    this.deps.logger?.info('Reading: session over', {
      avatarId: this.deps.avatarId,
      end,
      notes: this.notesMade.length,
    });
  }

  private save(parts: Omit<NewReadingNote, 'avatarId' | 'stationId' | 'curiosity'>): void {
    const note = this.deps.notes.addReadingNote({
      avatarId: this.deps.avatarId,
      stationId: this.deps.stationId,
      curiosity: this.curiosity,
      ...parts,
      createdAt: (this.deps.now ?? Date.now)(),
    });
    this.notesMade.push(note);
    try {
      this.deps.saveToMemory(note);
    } catch (error) {
      this.deps.logger?.warn('Reading: could not queue the note for memory', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
