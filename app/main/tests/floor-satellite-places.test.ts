import { describe, expect, it } from 'vitest';
import { FloorController } from '../src/floor/index.js';
import { LOCATIONS_KEY, PLACES_KEY, PlaceManager, scopedPlaces } from '../src/places/place-manager.js';
import { summon } from '../src/places/summon.js';
import type { LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../src/local-voice/types.js';

const PROFILES = [
  { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
  { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
  { id: 'rex', name: 'Rex', vrmModelId: 'm1' },
];

/** Echo and Rex are at bija ('home'), Sage is at the satellite's place ('study'). One floor for each place, as main.ts builds them. */
function harness() {
  const kv = new Map<string, string>([
    [PLACES_KEY, JSON.stringify([{ id: 'study', name: 'the study', node: 'room-1' }])],
    [LOCATIONS_KEY, JSON.stringify({ sage: 'study' })],
  ]);
  const store = { getValue: (key: string) => kv.get(key) ?? null, setValue: (key: string, value: string) => void kv.set(key, value) };
  const registry = { list: () => PROFILES, get: (id: string) => PROFILES.find((p) => p.id === id) ?? null };
  const places = new PlaceManager({ store, registry });
  places.setOnline('study', true);
  const turns: Array<{ place: string; avatar: string }> = [];
  const chatter: Array<{ place: string; avatar: string }> = [];
  const floorFor = (placeId: string) =>
    new FloorController({
      registry,
      places: scopedPlaces(places, placeId),
      store,
      summon: (avatarId, reason) => summon(scopedPlaces(places, placeId), avatarId, reason),
      voice: () => ({ respond: async (request: LocalVoiceRespondRequest) => ({ requestId: request.requestId, text: '', cancelled: false }), cancel: () => undefined }),
      runPersonTurn: async (avatarId, request): Promise<LocalVoiceRespondResult> => {
        turns.push({ place: placeId, avatar: avatarId });
        return { requestId: request.requestId, text: `${avatarId} speaks.`, cancelled: false };
      },
      emitChatter: (avatarId) => void chatter.push({ place: placeId, avatar: avatarId }),
      saveLine: () => undefined,
      now: () => 1_000,
    });
  return { places, home: floorFor('home'), study: floorFor('study'), turns, chatter };
}

describe('one floor for each place', () => {
  it('each scene holds the avatars at that place only', () => {
    const { home, study } = harness();
    expect(home.manager.scene()).toMatchObject({ id: 'home', avatarIds: ['echo', 'rex'], awayIds: ['sage'] });
    expect(study.manager.scene()).toMatchObject({ id: 'study', avatarIds: ['sage'], hostId: 'sage', awayIds: ['echo', 'rex'] });
    expect(study.isMulti()).toBe(false);
    expect(study.hasAway()).toBe(true);
  });

  it('a line from the satellite is answered by the avatar there, not by bija\'s', async () => {
    const { study, turns } = harness();
    const result = await study.respondToPerson({ requestId: 'r1', text: 'Hello?' });
    expect(result.text).toBe('sage speaks.');
    expect(turns).toEqual([{ place: 'study', avatar: 'sage' }]);
  });

  it('a line at bija is answered by an avatar at bija', async () => {
    const { home, turns } = harness();
    await home.respondToPerson({ requestId: 'r2', text: 'Hello?' });
    expect(turns).toHaveLength(1);
    expect(turns[0].place).toBe('home');
    expect(['echo', 'rex']).toContain(turns[0].avatar);
  });

  it('summoning to the satellite waits for the satellite to confirm the arrival', async () => {
    const { places } = harness();
    const study = scopedPlaces(places, 'study');
    const coming = summon(study, 'echo', 'summoned', 5000);
    expect(places.inTransit('echo')).toBe(true);
    places.arrived('echo');
    await expect(coming).resolves.toBe(true);
    expect(places.locationOf('echo')).toBe('study');
    expect(study.isPresent('echo')).toBe(true);
  });

  it('summoning to an offline satellite fails', async () => {
    const { places } = harness();
    places.setOnline('study', false);
    await expect(summon(scopedPlaces(places, 'study'), 'echo', 'summoned', 50)).resolves.toBe(false);
  });
});
