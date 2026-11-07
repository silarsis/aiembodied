/**
 * The memory tools the conversation model can call: recall_memories (relevance, optionally
 * within a period), recall_timeline (what happened over a period), open_memory (one memory in
 * full), remember (save a durable fact), correct_memory (fix or withdraw a saved fact) and
 * note_for_next_time (a note it reads, word for word, when the next conversation starts). Few
 * on purpose: the local model is more reliable with a short list. Every result is capped so one
 * call can't flood the context. What the agent writes is signed with the conversation model.
 */
import { randomUUID } from 'node:crypto';
import type { RegisteredTool } from '../tools/tool-registry.js';
import type {
  MemoryEngineClient,
  MemoryEngineCorrectionResult,
  MemoryEngineMemoryDetail,
  MemoryEngineSearchResult,
  MemoryEngineTimeline,
} from './client.js';
import type { OutboxItem } from './outbox.js';
import { describeAgo, parsePeriod, type Period } from './period.js';

export const MEMORY_TOOL_IDS = {
  recall: 'builtin:recall_memories',
  timeline: 'builtin:recall_timeline',
  open: 'builtin:open_memory',
  remember: 'builtin:remember',
  correct: 'builtin:correct_memory',
  handoff: 'builtin:note_for_next_time',
} as const;

/** About 1,500 tokens. */
const MAX_RESULT_CHARS = 6000;
const SNIPPET_CHARS = 500;

const PERIOD_HELP =
  'A period in plain words: "today", "yesterday", "last week", "this month", "in March", "3 weeks ago", ' +
  '"the last 10 days", "last tuesday", or a date such as "2026-10-14" or "2026-10".';

export interface MemoryToolsOptions {
  client: Pick<MemoryEngineClient, 'search' | 'timeline' | 'memory' | 'correctFact'>;
  outbox: { enqueue(item: OutboxItem): void };
  /** The conversation the model is in, for linking a remembered fact to it. */
  currentSessionId: () => string | null;
  agentName: () => string;
  /** The conversation model, recorded on what the agent writes; null when unknown. */
  modelName?: () => string | null;
  now?: () => Date;
}

function readString(params: unknown, key: string): string | undefined {
  if (params && typeof params === 'object' && key in params) {
    const value = (params as Record<string, unknown>)[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

function readNumber(params: unknown, key: string, fallback: number, min: number, max: number): number {
  const raw = readString(params, key);
  const value = raw === undefined ? fallback : Number(raw);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function formatTime(date: Date): string {
  return date.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
}

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function fitTo(lines: string[], limit = MAX_RESULT_CHARS): string {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    if (used + line.length > limit) {
      out.push('(more not shown; narrow the period or the query)');
      break;
    }
    out.push(line);
    used += line.length + 1;
  }
  return out.join('\n');
}

function resolvePeriod(params: unknown, now: Date): Period | null | 'invalid' {
  const raw = readString(params, 'period');
  if (!raw) return null;
  return parsePeriod(raw, now) ?? 'invalid';
}

/** How a search result is introduced, by kind; turns name the character instead. */
const KIND_LABELS: Record<string, string> = {
  fact: 'fact',
  session: 'conversation summary',
  day: 'summary of the day',
  week: 'summary of the week',
  month: 'summary of the month',
  handoff: 'note you left yourself',
};

export function formatSearchResults(results: MemoryEngineSearchResult[], now: Date): string {
  if (results.length === 0) {
    return 'No memories found.';
  }
  return fitTo(
    results.map((result) => {
      const when = new Date(result.period_start);
      const who = KIND_LABELS[result.kind] ?? (result.agent ? `with ${result.agent}` : 'conversation');
      return `[${result.id}] ${formatDay(when)} (${describeAgo(when, now)}), ${who}:\n${clip(result.text, SNIPPET_CHARS)}\n`;
    }),
  );
}

export function formatTimeline(timeline: MemoryEngineTimeline, period: Period, now: Date): string {
  const { sessions, summaries } = timeline;
  if (sessions.length === 0 && summaries.length === 0) {
    return `No conversations between ${formatDay(period.from)} and ${formatDay(new Date(period.to.getTime() - 1))}.`;
  }
  const lines: string[] = [];
  if (summaries.length) {
    // A long period: the day, week or month summaries carry it; conversations follow in brief.
    for (const summary of summaries) {
      const start = new Date(summary.period_start);
      const label = summary.kind === 'day' ? formatDay(start) : `${summary.kind} of ${formatDay(start)}`;
      lines.push(`[${summary.id}] ${label}: ${summary.title ? `${summary.title}. ` : ''}${clip(summary.text, 400)}`);
    }
    if (sessions.length) lines.push('', 'Conversations:');
  }
  const brief = summaries.length > 0;
  for (const session of sessions) {
    const start = new Date(session.started_at);
    const title = session.summary?.title ?? session.title;
    const named = title ? ` "${title}"` : '';
    lines.push(
      `${formatDay(start)} ${formatTime(start)} (${describeAgo(start, now)}), ${session.agent ?? 'conversation'}${named}, ${session.message_count} messages:`,
    );
    if (session.summary) {
      lines.push(`  [${session.summary.id}] ${clip(session.summary.text, brief ? 240 : 500)}`);
      continue;
    }
    for (const turn of brief ? session.turns.slice(0, 2) : session.turns) {
      lines.push(`  [${turn.id}] ${clip(turn.text.replace(/\n/g, ' / '), 240)}`);
    }
  }
  return fitTo(lines);
}

export function formatMemory(detail: MemoryEngineMemoryDetail, now: Date): string {
  const when = new Date(detail.period_start);
  const header = `${formatDay(when)} ${formatTime(when)} (${describeAgo(when, now)})`;
  if (detail.kind === 'fact') {
    const source = (detail.messages ?? []).map((m) => `${m.role}: ${m.content}`).join('\n');
    return fitTo([`Fact noted ${header}: ${detail.text ?? ''}`, ...(source ? ['From:', source] : [])]);
  }
  if (detail.kind !== 'turn') {
    const what = KIND_LABELS[detail.kind] ?? detail.kind;
    const more = detail.kind === 'session' ? ' Open one of its exchanges from recall_timeline for the exact words.' : '';
    return fitTo([`${what[0].toUpperCase()}${what.slice(1)}, ${header}: ${detail.text ?? ''}${more}`]);
  }
  const agent = detail.agent ?? 'Assistant';
  const lines = (detail.messages ?? []).map((m) => {
    const time = formatTime(new Date(m.created_at));
    if (m.role === 'tool') return `${time} [${m.tool?.name ?? 'tool'} result] ${clip(m.content, 800)}`;
    const speaker = m.role === 'user' ? (m.speaker ?? 'User') : agent;
    return `${time} ${speaker}: ${m.content}`;
  });
  return fitTo([`Conversation ${header}:`, ...lines]);
}

/**
 * Vector search always returns its nearest rows, related or not. A hit that matched only on
 * meaning has to be at least this close (cosine) to count; word matches always count.
 */
export const VECTOR_ONLY_MIN_SIMILARITY = 0.5;

export function isRelevant(result: MemoryEngineSearchResult): boolean {
  if (!result.matched || result.matched.includes('text')) return true;
  return (result.similarity ?? 0) >= VECTOR_ONLY_MIN_SIMILARITY;
}

export function formatCorrection(result: MemoryEngineCorrectionResult): string {
  switch (result.status) {
    case 'replaced':
      return `Corrected. "${result.fact?.text ?? ''}" is now "${result.replacement?.text ?? ''}".`;
    case 'retracted':
      return `Withdrawn: "${result.fact?.text ?? ''}".`;
    case 'ambiguous':
      return fitTo([
        'More than one saved fact could be meant. Call correct_memory again with the id of the right one:',
        ...(result.candidates ?? []).map((c) => `[${c.id}] ${clip(c.text, 200)}`),
      ]);
    case 'not_a_fact':
      return 'That is a record of a conversation, which is kept as it was said. Save the right version with remember instead.';
    case 'inactive':
      return 'That fact was already replaced or withdrawn.';
    case 'pinned':
      return `Kevin pinned "${result.fact?.text ?? 'that fact'}", so only he can change it. Tell him what looks wrong.`;
    default:
      return 'No saved fact matches that. Use recall_memories to find it, then pass its id.';
  }
}

export function createMemoryTools(options: MemoryToolsOptions): RegisteredTool[] {
  const now = options.now ?? (() => new Date());
  const modelName = () => options.modelName?.() ?? null;

  const recall: RegisteredTool = {
    id: MEMORY_TOOL_IDS.recall,
    serverId: 'builtin',
    toolName: 'recall_memories',
    description:
      'Search your long-term memory of past conversations with Kevin and the facts you have saved. Use it when he ' +
      'refers to something from before this conversation, or when knowing his history would help. Returns dated ' +
      'snippets, best match first, each with an id for open_memory.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to look for, in a few words.' },
        period: { type: 'string', description: `Optional. Only look in this period. ${PERIOD_HELP}` },
        subject: { type: 'string', description: 'Optional. A subject to focus on, such as "garden" or "car".' },
      },
      required: ['query'],
    },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me think back.',
    describeCall: (params) => readString(params, 'query') ?? 'memory',
    execute: async (params) => {
      const query = [readString(params, 'query'), readString(params, 'subject')].filter(Boolean).join(' ');
      if (!query) throw new Error('recall_memories needs a "query".');
      const period = resolvePeriod(params, now());
      if (period === 'invalid') return `I could not read that period. ${PERIOD_HELP}`;
      const results = await options.client.search(query, {
        from: period?.from.toISOString(),
        to: period?.to.toISOString(),
        limit: readNumber(params, 'limit', 6, 1, 12),
        // The agent recalling a fact keeps it from fading out of the brief.
        touch: true,
        sessionId: options.currentSessionId(),
      });
      return formatSearchResults(results.filter(isRelevant), now());
    },
  };

  const timeline: RegisteredTool = {
    id: MEMORY_TOOL_IDS.timeline,
    serverId: 'builtin',
    toolName: 'recall_timeline',
    description:
      'List what you and Kevin talked about over a period, conversation by conversation, oldest first. Use it ' +
      'for questions like "what did we talk about yesterday?" or "what was I doing last week?".',
    inputSchema: {
      type: 'object',
      properties: { period: { type: 'string', description: PERIOD_HELP } },
      required: ['period'],
    },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me think back.',
    describeCall: (params) => readString(params, 'period') ?? 'timeline',
    execute: async (params) => {
      const period = resolvePeriod(params, now());
      if (!period) throw new Error('recall_timeline needs a "period".');
      if (period === 'invalid') return `I could not read that period. ${PERIOD_HELP}`;
      const timeline = await options.client.timeline(period.from.toISOString(), period.to.toISOString());
      return formatTimeline(timeline, period, now());
    },
  };

  const open: RegisteredTool = {
    id: MEMORY_TOOL_IDS.open,
    serverId: 'builtin',
    toolName: 'open_memory',
    description:
      'Read one memory in full: the exact conversation around a snippet from recall_memories or recall_timeline, ' +
      'or where a saved fact came from.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id in square brackets from recall_memories or recall_timeline.' },
        around: { type: 'number', description: 'Optional. How many exchanges either side to include (default 1).' },
      },
      required: ['id'],
    },
    enabled: true,
    confirmationLevel: 'none',
    describeCall: () => 'opening a memory',
    execute: async (params) => {
      const id = readString(params, 'id')?.replace(/^\[|\]$/g, '');
      if (!id) throw new Error('open_memory needs an "id".');
      const detail = await options.client.memory(id, readNumber(params, 'around', 1, 0, 5), {
        touch: true,
        sessionId: options.currentSessionId(),
      });
      return formatMemory(detail, now());
    },
  };

  const remember: RegisteredTool = {
    id: MEMORY_TOOL_IDS.remember,
    serverId: 'builtin',
    toolName: 'remember',
    description:
      'Save a durable fact about Kevin or his world so you know it in future conversations: a preference, a ' +
      'decision, a plan, a person, a date. One short sentence in the third person, e.g. "Kevin prefers wslc over ' +
      'Docker". Everything said is already kept, so only save what is worth knowing at a glance later.',
    inputSchema: {
      type: 'object',
      properties: {
        fact: { type: 'string', description: 'The fact, one short sentence.' },
        subject: { type: 'string', description: 'Optional. One or two words it is about, such as "car" or "garden".' },
      },
      required: ['fact'],
    },
    enabled: true,
    confirmationLevel: 'notify',
    describeCall: (params) => clip(readString(params, 'fact') ?? 'a fact', 80),
    execute: async (params) => {
      const fact = readString(params, 'fact');
      if (!fact) throw new Error('remember needs a "fact".');
      // Queued like every other memory write, so it survives the engine being down.
      options.outbox.enqueue({
        kind: 'fact',
        id: randomUUID(),
        fact: {
          text: clip(fact, 1000),
          subject: readString(params, 'subject') ?? null,
          author: 'agent',
          agent: options.agentName(),
          session_id: options.currentSessionId(),
          model: modelName(),
        },
      });
      return 'Saved.';
    },
  };

  const correct: RegisteredTool = {
    id: MEMORY_TOOL_IDS.correct,
    serverId: 'builtin',
    toolName: 'correct_memory',
    description:
      'Fix or withdraw a saved fact that has turned out wrong or out of date, e.g. when Kevin says "I sold that car". ' +
      'Name the fact by its id from recall_memories, or by what it said. Give the corrected wording to replace it, ' +
      'or leave it out to withdraw the fact. The old version is kept for Kevin to review.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Optional. The fact\'s id in square brackets from recall_memories.' },
        about: { type: 'string', description: 'Optional, instead of id. What the fact said, in a few words.' },
        correction: {
          type: 'string',
          description: 'Optional. The corrected fact, one short sentence in the third person. Leave out to withdraw it.',
        },
      },
    },
    enabled: true,
    confirmationLevel: 'notify',
    describeCall: (params) => clip(readString(params, 'correction') ?? readString(params, 'about') ?? 'a fact', 80),
    execute: async (params) => {
      const id = readString(params, 'id')?.replace(/^\[|\]$/g, '');
      const about = readString(params, 'about');
      if (!id && !about) throw new Error('correct_memory needs an "id" or "about".');
      const correction = readString(params, 'correction');
      const result = await options.client.correctFact({
        ...(id ? { id } : { about }),
        action: correction ? 'replace' : 'retract',
        text: correction ? clip(correction, 1000) : undefined,
        new_id: randomUUID(),
        author: 'agent',
        agent: options.agentName(),
        model: modelName(),
        session_id: options.currentSessionId(),
      });
      return formatCorrection(result);
    },
  };

  const handoff: RegisteredTool = {
    id: MEMORY_TOOL_IDS.handoff,
    serverId: 'builtin',
    toolName: 'note_for_next_time',
    description:
      'Leave yourself a note for the start of your next conversation, in your own words: where things stand, what ' +
      'you were in the middle of, what to follow up or ask about. You will read it word for word next time. It ' +
      'replaces any note from this conversation. Use it when a conversation is winding down or the plan changes. ' +
      'Facts about Kevin go in remember instead.',
    inputSchema: {
      type: 'object',
      properties: { note: { type: 'string', description: 'The note, a few sentences at most.' } },
      required: ['note'],
    },
    enabled: true,
    confirmationLevel: 'none',
    describeCall: () => 'a note for next time',
    execute: async (params) => {
      const note = readString(params, 'note');
      if (!note) throw new Error('note_for_next_time needs a "note".');
      const sessionId = options.currentSessionId();
      if (!sessionId) return 'There is no conversation to attach the note to yet.';
      options.outbox.enqueue({
        kind: 'handoff',
        sessionId,
        handoff: { text: clip(note, 2000), agent: options.agentName(), model: modelName() },
      });
      return 'Noted for next time.';
    },
  };

  return [recall, timeline, open, remember, correct, handoff];
}
