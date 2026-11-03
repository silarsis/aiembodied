/**
 * What long-term memory adds to a conversation without the model asking (phase 3 of the eternal
 * memory design):
 *
 * - The session brief, built once when a conversation starts and then left alone, so the prompt
 *   prefix (and llama.cpp's cache of it) stays the same for the whole conversation. It always
 *   has the date and time, so the model can place "last Tuesday", plus saved facts and how the
 *   last conversation ended.
 * - Auto-recall: before each turn, a few memories that clearly bear on what was just said, put
 *   at the top of that user message. Most turns get nothing. It has a hard time limit, and if
 *   the engine is slow or down the turn simply goes ahead without it.
 *
 * Neither ever throws: memory is a help, never a reason for a reply to fail.
 */
import type { MemoryEngineBrief, MemoryEngineClient, MemoryEngineSearchResult } from './client.js';
import { describeAgo } from './period.js';

type Logger = { warn: (message: string, data?: Record<string, unknown>) => void; debug?: (message: string, data?: Record<string, unknown>) => void };

/** The part of long-term memory the voice pipeline uses. */
export interface VoiceMemory {
  /** Text for the end of the system prompt, for a conversation that is starting now. */
  brief(): Promise<string | null>;
  /** A block to put before the user's words, or null when nothing clearly matters. */
  recall(text: string, alreadyRecalled: readonly string[]): Promise<{ block: string; ids: string[] } | null>;
  /** A turn started (true) or ended (false), so the engine's background work waits. */
  activity?(busy: boolean): void;
}

export interface VoiceMemoryOptions {
  client: Pick<MemoryEngineClient, 'brief' | 'recall'> & Partial<Pick<MemoryEngineClient, 'activity'>>;
  currentSessionId: () => string | null;
  agentName: () => string;
  /** Off: the brief is only the date and time. */
  brief?: boolean;
  autoRecall?: boolean;
  briefTimeoutMs?: number;
  recallTimeoutMs?: number;
  now?: () => Date;
  logger?: Logger;
}

export const BRIEF_TIMEOUT_MS = 600;
export const RECALL_TIMEOUT_MS = 150;

function formatNow(now: Date): string {
  const day = now.toLocaleDateString('en-AU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  const time = now.toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  return `${day}, ${time}`;
}

function formatDay(date: Date): string {
  return date.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}

function oneLine(text: string): string {
  return text.replace(/\s*\n\s*/g, ' / ');
}

export function formatBrief(brief: MemoryEngineBrief | null, now: Date): string {
  const lines = [`Now: ${formatNow(now)}.`];
  if (brief?.facts.length) {
    lines.push('', 'What you know about the user from long-term memory:');
    for (const fact of brief.facts) {
      lines.push(`- ${fact.text}`);
    }
  }
  const days = brief?.recent_days ?? [];
  if (days.length) {
    lines.push('', 'Recent days:');
    for (const day of days) {
      lines.push(`- ${formatDay(new Date(day.period_start))}: ${oneLine(day.text)}`);
    }
  }
  const last = brief?.last_session;
  if (last?.summary) {
    const when = new Date(last.last_at);
    const who = last.agent ? `, with ${last.agent}` : '';
    lines.push('', `Your last conversation (${describeAgo(when, now)}${who}): ${oneLine(last.summary)}`);
  } else if (last && last.turns.length) {
    const when = new Date(last.last_at);
    const who = last.agent ? `, with ${last.agent}` : '';
    lines.push('', `How your last conversation ended (${describeAgo(when, now)}${who}):`);
    for (const turn of last.turns) {
      lines.push(`- ${oneLine(turn)}`);
    }
  }
  lines.push(
    '',
    'For anything else from before this conversation, use recall_memories or recall_timeline rather ' +
      'than guessing, when those tools are offered.',
  );
  return lines.join('\n');
}

export function formatRecalled(items: MemoryEngineSearchResult[], now: Date): string {
  const lines = ['<recalled>', 'From long-term memory, in case it helps. Mention it only if it is relevant:'];
  for (const item of items) {
    const when = new Date(item.period_start);
    const label = item.kind === 'fact' ? 'noted' : 'talked';
    lines.push(`- ${formatDay(when)} (${describeAgo(when, now)}, ${label}): ${oneLine(item.text)}`);
  }
  lines.push('</recalled>');
  return lines.join('\n');
}

export function createVoiceMemory(options: VoiceMemoryOptions): VoiceMemory {
  const now = options.now ?? (() => new Date());
  const useBrief = options.brief !== false;
  const useRecall = options.autoRecall !== false;

  return {
    async brief() {
      if (!useBrief) return formatBrief(null, now());
      try {
        const brief = await options.client.brief({
          sessionId: options.currentSessionId(),
          agent: options.agentName(),
          timeoutMs: options.briefTimeoutMs ?? BRIEF_TIMEOUT_MS,
        });
        return formatBrief(brief, now());
      } catch (error) {
        options.logger?.warn('Memory brief unavailable; starting with the time only', {
          message: error instanceof Error ? error.message : String(error),
        });
        return formatBrief(null, now());
      }
    },

    activity(busy) {
      // Fire and forget: background work pausing a little late is harmless.
      options.client.activity?.(busy).catch(() => undefined);
    },

    async recall(text, alreadyRecalled) {
      if (!useRecall || !text.trim()) return null;
      try {
        const result = await options.client.recall(
          { text, session_id: options.currentSessionId(), exclude: [...alreadyRecalled] },
          options.recallTimeoutMs ?? RECALL_TIMEOUT_MS,
        );
        if (!result.items.length) return null;
        return { block: formatRecalled(result.items, now()), ids: result.items.map((item) => item.id) };
      } catch (error) {
        options.logger?.debug?.('Auto-recall skipped', {
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    },
  };
}
