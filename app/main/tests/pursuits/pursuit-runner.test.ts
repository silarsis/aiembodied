import { describe, expect, it } from 'vitest';
import { runPursuit, type ChooseResult, type NextResult, type Pursuit, type PursuitEnd } from '../../src/pursuits/pursuit.js';

/** A pursuit that logs its steps and answers from lists. */
function scripted(options: { choices?: ChooseResult[]; nexts?: NextResult[]; failAt?: string; onStep?: (step: string) => void } = {}) {
  const log: string[] = [];
  const choices = [...(options.choices ?? ['consume'])];
  const nexts = [...(options.nexts ?? ['stop'])];
  const step = async (name: string) => {
    log.push(name);
    options.onStep?.(name);
    if (options.failAt === name) throw new Error(`${name} broke`);
  };
  let end: PursuitEnd | null = null;
  const pursuit: Pursuit = {
    kind: 'test',
    want: () => step('want'),
    act: () => step('act'),
    choose: async () => (await step('choose'), choices.shift() ?? 'nothing'),
    consume: () => step('consume'),
    note: () => step('note'),
    next: async () => (await step('next'), nexts.shift() ?? 'stop'),
    finish: (reason) => {
      end = reason;
    },
  };
  return { pursuit, log, ended: () => end };
}

describe('runPursuit', () => {
  it('goes want, act, choose, consume, note, next', async () => {
    const { pursuit, log, ended } = scripted();
    const result = await runPursuit(pursuit, { signal: new AbortController().signal });
    expect(log).toEqual(['want', 'act', 'choose', 'consume', 'note', 'next']);
    expect(result).toMatchObject({ end: 'finished', items: 1, steps: 6 });
    expect(ended()).toBe('finished');
  });

  it('tells the body about every step', async () => {
    const { pursuit } = scripted();
    const seen: string[] = [];
    await runPursuit(pursuit, { signal: new AbortController().signal, onStep: (step) => seen.push(step) });
    expect(seen).toEqual(['want', 'act', 'choose', 'consume', 'note', 'next']);
  });

  it('looks again on refine, up to the bound, then moves on without reading', async () => {
    const { pursuit, log } = scripted({ choices: ['refine', 'refine', 'refine', 'refine'] });
    await runPursuit(pursuit, { signal: new AbortController().signal, maxRefinements: 2 });
    expect(log.filter((s) => s === 'act')).toHaveLength(3);
    expect(log).not.toContain('consume');
  });

  it('goes on to another item when next says again, and stops at the item limit', async () => {
    const { pursuit, log } = scripted({ choices: ['consume', 'consume', 'consume'], nexts: ['again', 'again', 'again'] });
    const result = await runPursuit(pursuit, { signal: new AbortController().signal, maxItems: 2 });
    expect(log.filter((s) => s === 'note')).toHaveLength(2);
    expect(result).toMatchObject({ end: 'limit', items: 2 });
  });

  it('stops at the step limit', async () => {
    const { pursuit } = scripted({ choices: ['consume', 'consume', 'consume'], nexts: ['again', 'again', 'again'] });
    const result = await runPursuit(pursuit, { signal: new AbortController().signal, maxSteps: 8 });
    expect(result).toMatchObject({ end: 'limit', steps: 8 });
  });

  it('ends as aborted when the signal fires, still calling finish', async () => {
    const controller = new AbortController();
    const { pursuit, ended } = scripted({ onStep: (step) => step === 'choose' && controller.abort() });
    const result = await runPursuit(pursuit, { signal: controller.signal });
    expect(result.end).toBe('aborted');
    expect(ended()).toBe('aborted');
  });

  it('reports a failure without throwing', async () => {
    const { pursuit, ended } = scripted({ failAt: 'act' });
    const result = await runPursuit(pursuit, { signal: new AbortController().signal });
    expect(result).toMatchObject({ end: 'failed', error: 'act broke' });
    expect(ended()).toBe('failed');
  });
});
