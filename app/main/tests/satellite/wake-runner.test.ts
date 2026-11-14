import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SatelliteWakeRunner, type SharedWakeWord, type WakeRunnerDeps } from '../../src/satellite/wake-runner.js';
import { evaluateGate, INITIAL_FACTS } from '../../src/satellite/device-gate.js';
import type { WakeWordConfig } from '../../src/config/config-manager.js';
import type { WakeWordDetectionEvent } from '../../src/wake-word/types.js';

const BUILTIN: SharedWakeWord = { model: 'hey_echo', keywordLabel: 'Hey Echo', threshold: 0.5, cooldownMs: 1500 };
const EVENT: WakeWordDetectionEvent = { keywordLabel: 'Hey Echo', confidence: 0.9, timestamp: 1 };
const flush = async () => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

function setup(overrides: Partial<WakeRunnerDeps> = {}, shared: SharedWakeWord | null | Error = BUILTIN) {
  const started: WakeWordConfig[] = [];
  const disposed: number[] = [];
  const handlers: Array<(event: WakeWordDetectionEvent) => void> = [];
  const wakes: Array<[WakeWordDetectionEvent, string]> = [];
  const fetchModel = vi.fn(async () => {
    if (shared instanceof Error) throw shared;
    return shared;
  });
  const storeModel = vi.fn(async (name: string) => `/cache/${name}`);
  const runner = new SatelliteWakeRunner({
    fetchModel,
    storeModel,
    start: (config, onWake) => {
      started.push(config);
      handlers.push(onWake);
      const index = started.length - 1;
      return { dispose: async () => void disposed.push(index) };
    },
    onWake: (event, mode) => void wakes.push([event, mode]),
    ...overrides,
  });
  // The gate, as the device runtime computes it from the facts.
  const gateFor = (facts: Partial<typeof INITIAL_FACTS>, doorbell = false) => evaluateGate({ ...INITIAL_FACTS, linkUp: true, noFullscreenApp: true, ...facts }, doorbell);
  return { runner, started, disposed, handlers, wakes, fetchModel, storeModel, gateFor };
}

describe('SatelliteWakeRunner truth table', () => {
  const cases: Array<{ name: string; facts: Record<string, boolean>; doorbell: boolean; runs: boolean; mode?: string }> = [
    { name: 'avatar here, everything fine', facts: {}, doorbell: false, runs: false },
    { name: 'avatar here, everything fine', facts: { occupied: true }, doorbell: false, runs: true, mode: 'live' },
    { name: 'avatar here, doorbell on too (it is the mic, not the doorbell)', facts: { occupied: true }, doorbell: true, runs: true, mode: 'live' },
    { name: 'nobody here, doorbell off', facts: { occupied: false }, doorbell: false, runs: false },
    { name: 'nobody here, doorbell on', facts: { occupied: false }, doorbell: true, runs: true, mode: 'doorbell' },
    { name: 'nobody here, doorbell on, screen locked', facts: { occupied: false, unlocked: false }, doorbell: true, runs: false },
    { name: 'nobody here, doorbell on, link down', facts: { occupied: false, linkUp: false }, doorbell: true, runs: false },
    { name: 'nobody here, doorbell on, room closed', facts: { occupied: false, open: false }, doorbell: true, runs: false },
    { name: 'nobody here, doorbell on, full-screen app', facts: { occupied: false, noFullscreenApp: false }, doorbell: true, runs: false },
    { name: 'nobody here, doorbell on, bija held devices off', facts: { occupied: false, notHeldOff: false }, doorbell: true, runs: false },
    { name: 'avatar here, screen locked', facts: { occupied: true, unlocked: false }, doorbell: false, runs: false },
    { name: 'avatar here, link down', facts: { occupied: true, linkUp: false }, doorbell: true, runs: false },
    { name: 'avatar here, room closed', facts: { occupied: true, open: false }, doorbell: true, runs: false },
    { name: 'avatar here, full-screen app', facts: { occupied: true, noFullscreenApp: false }, doorbell: true, runs: false },
    { name: 'avatar here, held off', facts: { occupied: true, notHeldOff: false }, doorbell: true, runs: false },
  ];
  for (const row of cases) {
    it(`${row.runs ? 'runs' : 'does not run'}: ${row.name} ${JSON.stringify(row.facts)} doorbell=${row.doorbell}`, async () => {
      const t = setup();
      t.runner.setGate(t.gateFor(row.facts, row.doorbell));
      await flush();
      expect(t.started.length).toBe(row.runs ? 1 : 0);
      if (row.runs) {
        t.handlers[0](EVENT);
        expect(t.wakes).toEqual([[EVENT, row.mode]]);
      }
    });
  }

  it('the worker runs exactly when micAllowed or doorbell, nothing else', () => {
    // Every combination of the six facts the gate looks at.
    const keys = ['occupied', 'unlocked', 'linkUp', 'open', 'noFullscreenApp', 'notHeldOff'] as const;
    for (let bits = 0; bits < 64; bits += 1) {
      const facts = Object.fromEntries(keys.map((key, index) => [key, (bits & (1 << index)) !== 0]));
      for (const doorbell of [false, true]) {
        const state = evaluateGate({ ...INITIAL_FACTS, ...facts }, doorbell);
        const others = facts.unlocked && facts.linkUp && facts.open && facts.noFullscreenApp && facts.notHeldOff;
        const expected = (facts.occupied && others) || (!facts.occupied && others && doorbell);
        expect(state.micAllowed || state.doorbell, JSON.stringify({ facts, doorbell })).toBe(Boolean(expected));
      }
    }
  });
});

describe('SatelliteWakeRunner', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stops the worker the moment the gate closes, and a wake that slips through is thrown away', async () => {
    const t = setup();
    t.runner.setGate({ micAllowed: false, doorbell: true });
    await flush();
    expect(t.started).toHaveLength(1);
    t.runner.setGate({ micAllowed: false, doorbell: false });
    // Gated at once, before the worker has even finished stopping.
    t.handlers[0](EVENT);
    expect(t.wakes).toEqual([]);
    await flush();
    expect(t.disposed).toEqual([0]);
    expect(t.runner.isRunning).toBe(false);
  });

  it('keeps one worker when the mic gives way to the doorbell, and says which mode a wake was heard in', async () => {
    const t = setup();
    t.runner.setGate({ micAllowed: true, doorbell: false });
    await flush();
    t.runner.setGate({ micAllowed: false, doorbell: true });
    await flush();
    expect(t.started).toHaveLength(1);
    t.handlers[0](EVENT);
    t.runner.setGate({ micAllowed: true, doorbell: false });
    t.handlers[0](EVENT);
    expect(t.wakes.map(([, mode]) => mode)).toEqual(['doorbell', 'live']);
  });

  it('fetches the model from bija each time it starts', async () => {
    const t = setup();
    t.runner.setGate({ micAllowed: true, doorbell: false });
    await flush();
    t.runner.setGate({ micAllowed: false, doorbell: false });
    await flush();
    t.runner.setGate({ micAllowed: true, doorbell: false });
    await flush();
    expect(t.fetchModel).toHaveBeenCalledTimes(2);
    expect(t.started).toHaveLength(2);
    expect(t.started[0]).toEqual({ model: 'hey_echo', keywordLabel: 'Hey Echo', threshold: 0.5, cooldownMs: 1500 });
    // The mic that is used is this PC's own default: bija's device index is never passed on.
    expect(t.started[0]).not.toHaveProperty('deviceIndex');
  });

  it('fails closed when the gate shuts while the model is still being fetched', async () => {
    let release: (value: SharedWakeWord) => void = () => undefined;
    const t = setup({ fetchModel: () => new Promise((resolve) => (release = resolve)) });
    t.runner.setGate({ micAllowed: true, doorbell: false });
    t.runner.setGate({ micAllowed: false, doorbell: false });
    release(BUILTIN);
    await flush();
    expect(t.started).toHaveLength(0);
  });

  it('does not listen when bija gives no model, an unknown built-in name, or nonsense settings', async () => {
    for (const shared of [null, { ...BUILTIN, model: '/etc/passwd' }, { ...BUILTIN, threshold: 7 }, new Error('lost touch')] as Array<SharedWakeWord | null | Error>) {
      const t = setup({}, shared);
      t.runner.setGate({ micAllowed: true, doorbell: false });
      await flush();
      expect(t.started).toHaveLength(0);
    }
  });

  it('tries again after a failed fetch while the gate stays open', async () => {
    let attempts = 0;
    const t = setup({
      retryMs: 1000,
      fetchModel: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('lost touch');
        return BUILTIN;
      },
    });
    t.runner.setGate({ micAllowed: false, doorbell: true });
    await flush();
    expect(t.started).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(t.started).toHaveLength(1);
  });

  it('keeps a trained model sent by bija on this PC and starts the worker on that file', async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const t = setup({}, { ...BUILTIN, model: 'hey-kev.onnx', bytes });
    t.runner.setGate({ micAllowed: true, doorbell: false });
    await flush();
    expect(t.storeModel).toHaveBeenCalledWith('hey-kev.onnx', bytes);
    expect(t.started[0].model).toBe('/cache/hey-kev.onnx');
    const empty = setup({}, { ...BUILTIN, model: 'x.onnx', bytes: new Uint8Array(0) });
    empty.runner.setGate({ micAllowed: true, doorbell: false });
    await flush();
    expect(empty.started).toHaveLength(0);
  });

  it('a doorbell wake is only a name and a score for bija (the caller sends wake.heard, no audio is involved)', async () => {
    const sent: Array<Record<string, unknown>> = [];
    const t = setup({
      onWake: (event, mode) => {
        if (mode === 'doorbell') sent.push({ op: 'wake.heard', model: event.keywordLabel, score: event.confidence });
      },
    });
    t.runner.setGate({ micAllowed: false, doorbell: true });
    await flush();
    t.handlers[0](EVENT);
    expect(sent).toEqual([{ op: 'wake.heard', model: 'Hey Echo', score: 0.9 }]);
  });

  it('dispose stops the worker', async () => {
    const t = setup();
    t.runner.setGate({ micAllowed: true, doorbell: false });
    await flush();
    await t.runner.dispose();
    expect(t.disposed).toEqual([0]);
    t.handlers[0](EVENT);
    expect(t.wakes).toEqual([]);
  });
});
