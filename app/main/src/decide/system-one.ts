/**
 * "System 1": quick decisions from a small local model (Laya, services/laya). The caller sends a
 * small state and a few typed questions; one call answers them all in a single pass, in tens of
 * milliseconds on a CPU. It goes to the servers the `decide` use of Models and servers names, with
 * that use's backups tried in order. Any failure rejects, and the caller falls back to something
 * else (the floor falls back to the Idle thoughts model).
 *
 * Question types:
 *  - choice: pick one of several options. Answer: a probability for each option.
 *  - score: rate on an ordered scale (the criteria, lowest first). Answer: 0..1.
 *  - noul: yes or no. Answer: the probability of yes.
 */
import { routeTargets, type ModelRouting } from '../config/model-routing.js';
import type { ServerKeyLookup } from '../local-voice/voice-engines.js';

export const SYSTEM_ONE_TIMEOUT_MS = 3_000;
/** The checkpoint asked for when the route names none: the English one is the smallest and fastest. */
export const DEFAULT_SYSTEM_ONE_MODEL = 'english';

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option key -> what it means. */
  criteria: Record<string, string>;
}

export interface ScoreQuestion {
  type: 'score';
  instructions: string;
  /** The scale, lowest first (at least two levels). */
  criteria: string[];
}

export interface NoulQuestion {
  type: 'noul';
  instructions: string;
  criteria?: { true?: string; false?: string };
}

export type SystemOneQuestion = ChoiceQuestion | ScoreQuestion | NoulQuestion;

/** What a question's answer looks like in the result. */
export type SystemOneAnswer<Q extends SystemOneQuestion> = Q extends ChoiceQuestion ? Record<string, number> : number;

export type SystemOneResult<Q extends Record<string, SystemOneQuestion>> = { [K in keyof Q]: SystemOneAnswer<Q[K]> };

export interface SystemOneAskOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface SystemOneClientOptions {
  routing: ModelRouting;
  keyFor?: ServerKeyLookup;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  logger?: Pick<Console, 'warn'>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/** Reads one answer out of a response, or throws when it does not have the shape the question asks for. */
export function readAnswer(question: SystemOneQuestion, raw: unknown): number | Record<string, number> {
  if (!isRecord(raw)) throw new Error('The decision server gave no answer for a question.');
  if (question.type === 'choice') {
    const probabilities = raw.probabilities;
    if (!isRecord(probabilities)) throw new Error('A choice answer had no probabilities.');
    const result: Record<string, number> = {};
    for (const option of Object.keys(question.criteria)) {
      const value = probabilities[option];
      result[option] = typeof value === 'number' && Number.isFinite(value) ? clamp01(value) : 0;
    }
    return result;
  }
  if (question.type === 'score') {
    // `score` is the expected level index (0 for the first level); spread it over 0..1.
    const levels = question.criteria.length;
    const value = raw.score;
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A score answer had no score.');
    return levels > 1 ? clamp01(value / (levels - 1)) : clamp01(value);
  }
  const value = raw.noul;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('A yes/no answer had no value.');
  return clamp01(value);
}

export class SystemOneClient {
  private readonly options: SystemOneClientOptions;

  constructor(options: SystemOneClientOptions) {
    this.options = options;
  }

  /** The servers this client tries, in order. */
  targets(): ReturnType<typeof routeTargets> {
    return routeTargets(this.options.routing, 'decide');
  }

  async ask<Q extends Record<string, SystemOneQuestion>>(state: unknown, questions: Q, options: SystemOneAskOptions = {}): Promise<SystemOneResult<Q>> {
    const targets = this.targets();
    if (targets.length === 0) throw new Error('No quick-decision server is configured.');
    const fetchFn = this.options.fetchFn ?? fetch;
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? SYSTEM_ONE_TIMEOUT_MS;
    let lastError: unknown;
    for (const { server, model } of targets) {
      if (options.signal?.aborted) throw options.signal.reason ?? new Error('Aborted');
      const signals = [AbortSignal.timeout(timeoutMs), ...(options.signal ? [options.signal] : [])];
      try {
        const key = this.options.keyFor?.(server.id);
        const response = await fetchFn(`${server.url.replace(/\/+$/, '')}/v1/systemone`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify({ model: model || DEFAULT_SYSTEM_ONE_MODEL, state, questions }),
          signal: AbortSignal.any(signals),
        });
        if (!response.ok) throw new Error(`${server.name} answered ${response.status}.`);
        const body = (await response.json()) as unknown;
        const answers = isRecord(body) && isRecord(body.answers) ? body.answers : null;
        if (!answers) throw new Error(`${server.name} gave no answers.`);
        const result: Record<string, number | Record<string, number>> = {};
        for (const [id, question] of Object.entries(questions)) result[id] = readAnswer(question, answers[id]);
        return result as SystemOneResult<Q>;
      } catch (error) {
        lastError = error;
        // The caller gave up: no point trying the next server.
        if (options.signal?.aborted) throw error;
        this.options.logger?.warn(`Quick decision server ${server.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('The quick-decision servers did not answer.');
  }
}

/** A client for the `decide` route, or null when the route is off or names no known server. */
export function createSystemOne(options: SystemOneClientOptions): SystemOneClient | null {
  const client = new SystemOneClient(options);
  return client.targets().length > 0 ? client : null;
}
