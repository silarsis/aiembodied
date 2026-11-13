import { describe, expect, it, vi } from 'vitest';
import { FloorController } from '../src/floor/index.js';
import type { IntentFunction, IntentInput, QuickIntentFunction } from '../src/floor/floor-manager.js';
import { buildIntentPrompt } from '../src/floor/intent-router.js';
import { LOCATIONS_KEY, PlaceManager } from '../src/places/place-manager.js';
import type { LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../src/local-voice/types.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
  { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
  { id: 'rex', name: 'Rex', vrmModelId: 'm1' },
];

function harness(options: { away?: string[]; intent?: IntentFunction; quick?: QuickIntentFunction; summon?: (id: string) => Promise<boolean> } = {}) {
  const kv = new Map<string, string>();
  if (options.away) kv.set(LOCATIONS_KEY, JSON.stringify(Object.fromEntries(options.away.map((id) => [id, 'next-door']))));
  const store = { getValue: (key: string) => kv.get(key) ?? null, setValue: (key: string, value: string) => void kv.set(key, value) };
  const registry = { list: () => PROFILES, get: (id: string) => PROFILES.find((p) => p.id === id) ?? null };
  const places = new PlaceManager({ store, registry });
  const turns: string[] = [];
  const heard: Array<{ to: string; from: string }> = [];
  const errors: string[] = [];
  const respond = (avatarId: string) => async (request: LocalVoiceRespondRequest): Promise<LocalVoiceRespondResult> => {
    turns.push(avatarId);
    return { requestId: request.requestId, text: `${avatarId} speaks.`, cancelled: false };
  };
  const summon = vi.fn(options.summon ?? (async () => true));
  const controller = new FloorController({
    registry,
    places,
    store,
    summon,
    reportError: (avatarId, _requestId, message) => void errors.push(`${avatarId}: ${message}`),
    voice: (avatarId) => ({ respond: respond(avatarId), cancel: () => undefined, overhear: (line) => void heard.push({ to: avatarId, from: line.from }) }),
    runPersonTurn: (avatarId, request) => respond(avatarId)(request),
    saveLine: () => undefined,
    quickIntent: options.quick,
    intent: options.intent,
    now: () => 1_000,
  });
  return { controller, places, turns, heard, errors, summon };
}
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('the floor scene comes from the places', () => {
  it('is the same as before when everybody is here', () => {
    const { controller } = harness();
    expect(controller.manager.scene()).toEqual({ id: 'home', avatarIds: ['echo', 'sage', 'rex'], hostId: 'echo' });
    expect(controller.isMulti()).toBe(true);
    expect(controller.hasAway()).toBe(false);
  });

  it('leaves out avatars that are somewhere else', () => {
    const { controller } = harness({ away: ['sage'] });
    expect(controller.manager.scene()).toEqual({ id: 'home', avatarIds: ['echo', 'rex'], hostId: 'echo', awayIds: ['sage'] });
    expect(controller.hasAway()).toBe(true);
  });

  it('hosts with the first avatar present when Echo is away', () => {
    const { controller } = harness({ away: ['echo'] });
    expect(controller.manager.scene().hostId).toBe('sage');
  });

  it('is not multi with one avatar present or none', () => {
    expect(harness({ away: ['sage', 'rex'] }).controller.isMulti()).toBe(false);
    const none = harness({ away: ['echo', 'sage', 'rex'] });
    expect(none.controller.isMulti()).toBe(false);
    expect(none.controller.manager.scene().avatarIds).toEqual([]);
  });

  it('keeps absent avatars from overhearing', () => {
    const { controller, heard } = harness({ away: ['rex'] });
    controller.heard('person', 'Hello everyone', 'echo');
    expect(heard).toEqual([{ to: 'sage', from: 'Kevin (to Echo)' }]);
  });

  it('does not count an in-transit avatar as present', () => {
    const { controller, places } = harness();
    places.startMove('sage', 'next-door', 'chose to');
    expect(controller.manager.scene().avatarIds).toEqual(['echo', 'rex']);
  });

  it('lets an absent avatar neither answer nor receive chatter', async () => {
    const { controller } = harness({ away: ['sage'] });
    const decision = await controller.manager.route({ from: 'avatar:echo', text: 'Sage, what do you think?', at: 1_000 });
    expect(decision.speakers.map((speaker) => speaker.avatarId)).not.toContain('sage');
  });
});

describe('Kevin speaks while someone is away', () => {
  const sayOf = (addressed: string): IntentFunction => async () => ({ addressed, wants: 'answer', other: null });

  it('offers the away avatars to the chat-model step only, and never the quick model', async () => {
    const seen: IntentInput[] = [];
    const quick = vi.fn<QuickIntentFunction>(async () => ({ addressed: 'echo', wants: 'answer', other: null, confidence: 0.99 }));
    const { controller } = harness({
      away: ['sage'],
      quick,
      intent: async (input) => (seen.push(input), { addressed: 'echo', wants: 'answer', other: null }),
    });
    await controller.respondToPerson({ requestId: 'r1', text: 'Hi' });
    expect(quick).not.toHaveBeenCalled();
    expect(seen).toHaveLength(1);
    expect(seen[0]?.candidates.map((c) => c.avatarId)).toEqual(['echo', 'rex']);
    expect(seen[0]?.away?.map((c) => c.avatarId)).toEqual(['sage']);
  });

  it('uses the quick model as before when nobody is away', async () => {
    const quick = vi.fn<QuickIntentFunction>(async () => ({ addressed: 'sage', wants: 'answer', other: null, confidence: 0.99 }));
    const { controller, turns, summon } = harness({ quick });
    await controller.respondToPerson({ requestId: 'r1', text: 'Sage?' });
    expect(quick).toHaveBeenCalled();
    expect(turns).toEqual(['sage']);
    expect(summon).not.toHaveBeenCalled();
  });

  it('calls over an away avatar that the line is aimed at, then runs its turn', async () => {
    const { controller, turns, summon } = harness({ away: ['sage'], intent: sayOf('sage') });
    const result = await controller.respondToPerson({ requestId: 'r1', text: 'Sage, come and look' });
    expect(summon).toHaveBeenCalledWith('sage', 'summoned');
    expect(turns).toEqual(['sage']);
    expect(result.text).toBe('sage speaks.');
  });

  it('with one avatar here, still asks the model who is meant', async () => {
    const { controller, turns, summon } = harness({ away: ['sage', 'rex'], intent: sayOf('rex') });
    await controller.respondToPerson({ requestId: 'r1', text: 'Rex, are you there?' });
    expect(summon).toHaveBeenCalledWith('rex', 'summoned');
    expect(turns).toEqual(['rex']);
  });

  it('does not call anybody when the avatar meant is here', async () => {
    const { controller, turns, summon } = harness({ away: ['sage'], intent: sayOf('echo') });
    await controller.respondToPerson({ requestId: 'r1', text: 'Echo?' });
    expect(summon).not.toHaveBeenCalled();
    expect(turns).toEqual(['echo']);
  });

  it('never counts away avatars as part of everyone', async () => {
    const { controller, turns, summon } = harness({ away: ['sage'], intent: async () => ({ addressed: 'everyone', wants: 'answer', other: null }) });
    await controller.respondToPerson({ requestId: 'r1', text: 'Hey all' });
    await settle();
    expect(turns.sort()).toEqual(['echo', 'rex']);
    expect(summon).not.toHaveBeenCalled();
  });

  it('falls back to someone who is here when the model cannot say', async () => {
    const { controller, turns } = harness({ away: ['echo'], intent: async () => { throw new Error('down'); } });
    await controller.respondToPerson({ requestId: 'r1', text: 'Anyone?' });
    expect(turns).toEqual(['sage']);
  });

  it('tells Kevin and runs nothing when the avatar does not come', async () => {
    const { controller, turns, errors } = harness({ away: ['sage'], intent: sayOf('sage'), summon: async () => false });
    const result = await controller.respondToPerson({ requestId: 'r1', text: 'Sage?' });
    expect(result.cancelled).toBe(true);
    expect(turns).toEqual([]);
    expect(errors).toEqual(['sage: Sage did not come over.']);
    // The slot is free again for the next line.
    expect(controller.manager.state().speaking).toBeNull();
  });

  it('remembers who Kevin talked with, wherever they are now', async () => {
    const { controller, places } = harness({ intent: sayOf('sage') });
    expect(controller.recentPartner()).toBeNull();
    await controller.respondToPerson({ requestId: 'r1', text: 'Sage?' });
    places.startMove('sage', 'next-door', 'chose to');
    expect(controller.recentPartner()).toBe('sage');
  });
});

describe('the chat-model intent prompt', () => {
  it('lists away avatars as callable and accepts them as options', () => {
    const input: IntentInput = {
      text: 'Sage, come over',
      recent: [],
      candidates: [{ avatarId: 'echo', name: 'Echo' }],
      hostId: 'echo',
      partnerId: null,
      away: [{ avatarId: 'sage', name: 'Sage' }],
    };
    const prompt = buildIntentPrompt(input, () => 'Kevin');
    expect(prompt.system).toContain('Now the actual room: Echo (host).');
    expect(prompt.system).toContain('In another place right now, and Kevin can call them over: Sage.');
    expect(prompt.system).toContain('addressed = echo | sage | everyone | unclear');
    expect(prompt.keys.get('sage')?.avatarId).toBe('sage');
  });

  it('is unchanged without away avatars', () => {
    const input: IntentInput = { text: 'hi', recent: [], candidates: [{ avatarId: 'echo', name: 'Echo' }, { avatarId: 'sage', name: 'Sage' }], hostId: 'echo', partnerId: null };
    expect(buildIntentPrompt(input, () => 'Kevin').system).not.toContain('another place');
  });
});
