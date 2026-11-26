/**
 * The generic shape of a pursuit and the loop that runs one.
 *
 * A pursuit is something a character does on its own because it wants to, in steps it takes itself:
 *
 *   want    what do I feel like finding out right now?
 *   act     go and look (query the tools)
 *   choose  pick one of the things found, or look again
 *   consume take it in (fetch it; read it in pieces when it is long)
 *   note    write down what I think of it
 *   next    go on with another one, stop, or tell someone
 *
 * `runPursuit` owns the order, the bounds (steps, items, one overall time limit) and the stop signal. The
 * pursuit itself (`ReadingPursuit`) owns what each step means. No Electron here.
 */

import type { PursuitStep } from './types.js';

/** Most steps one session takes in all (each is at least one model call). */
export const MAX_SESSION_STEPS = 60;
/** Most items one session reads before it must stop. A character that wants more starts another session. */
export const MAX_ITEMS_PER_SESSION = 5;
/** How many times a search may be redone ("refine") for one wish. */
export const MAX_REFINEMENTS = 2;
/** The whole session, whatever it is doing. */
export const SESSION_TIMEOUT_MS = 20 * 60_000;

export type ChooseResult = 'consume' | 'refine' | 'nothing';
export type NextResult = 'again' | 'stop';
export type PursuitEnd = 'finished' | 'aborted' | 'limit' | 'failed';

export interface Pursuit {
  readonly kind: string;
  want(signal: AbortSignal): Promise<void>;
  act(signal: AbortSignal): Promise<void>;
  /** 'refine': look again with what was learned; 'nothing': nothing found worth taking in. */
  choose(signal: AbortSignal): Promise<ChooseResult>;
  consume(signal: AbortSignal): Promise<void>;
  note(signal: AbortSignal): Promise<void>;
  next(signal: AbortSignal): Promise<NextResult>;
  /** Always runs last (also after an abort or a failure): keep what was gathered so far. */
  finish(end: PursuitEnd): Promise<void> | void;
}

export interface RunPursuitOptions {
  signal: AbortSignal;
  /** Told before each step starts, for the body ("browses the shelf"). */
  onStep?: (step: PursuitStep) => void;
  maxSteps?: number;
  maxItems?: number;
  maxRefinements?: number;
}

export interface PursuitResult {
  end: PursuitEnd;
  steps: number;
  items: number;
  error?: string;
}

/** Runs a pursuit to the end. Never throws; the result says how it ended. */
export async function runPursuit(
  pursuit: Pursuit,
  options: RunPursuitOptions,
): Promise<PursuitResult> {
  const { signal } = options;
  const maxSteps = options.maxSteps ?? MAX_SESSION_STEPS;
  const maxItems = options.maxItems ?? MAX_ITEMS_PER_SESSION;
  const maxRefinements = options.maxRefinements ?? MAX_REFINEMENTS;
  let steps = 0;
  let items = 0;
  let end: PursuitEnd = 'finished';
  let error: string | undefined;

  /** Starts a step: stops when the signal fired or the session has used up its steps. */
  const begin = (step: PursuitStep): void => {
    signal.throwIfAborted();
    if (steps >= maxSteps) throw new StepLimit();
    steps += 1;
    options.onStep?.(step);
  };

  try {
    while (items < maxItems) {
      begin('want');
      await pursuit.want(signal);

      let chosen: ChooseResult = 'nothing';
      for (let looks = 0; ; looks += 1) {
        begin('act');
        await pursuit.act(signal);
        begin('choose');
        chosen = await pursuit.choose(signal);
        if (chosen !== 'refine' || looks >= maxRefinements) break;
      }

      if (chosen === 'consume') {
        begin('consume');
        await pursuit.consume(signal);
        begin('note');
        await pursuit.note(signal);
        items += 1;
      }
      begin('next');
      if ((await pursuit.next(signal)) === 'stop') break;
    }
    if (items >= maxItems) end = 'limit';
  } catch (caught) {
    if (signal.aborted) {
      end = 'aborted';
    } else if (caught instanceof StepLimit) {
      end = 'limit';
    } else {
      end = 'failed';
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }
  try {
    await pursuit.finish(end);
  } catch (caught) {
    error ??= caught instanceof Error ? caught.message : String(caught);
  }
  return { end, steps, items, ...(error ? { error } : {}) };
}

class StepLimit extends Error {
  constructor() {
    super('The session used all its steps.');
  }
}
