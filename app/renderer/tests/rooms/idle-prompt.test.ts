import { describe, expect, it } from 'vitest';
import { buildIdlePrompt, describeState, idleSystemPrompt, nearestObject, timeOfDay } from '../../src/rooms/idle-prompt.js';
import type { IdleInput } from '../../src/rooms/idle-types.js';
import { visibleObjects } from '../../src/rooms/room-visibility.js';
import { INITIAL_STATE } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

const room = builtInRoom('reading-room');

function input(overrides: Partial<IdleInput> = {}): IdleInput {
  return {
    name: 'Mei',
    personality: 'Mei is gentle and curious. '.repeat(30),
    habits: 'Sits by the window with tea.',
    room,
    visible: visibleObjects(room, 21 / 9),
    state: INITIAL_STATE,
    position: [0, 0, -0.3],
    recent: ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((letter) => `did ${letter}`),
    now: new Date(2026, 10, 9, 19, 40),
    ...overrides,
  };
}

describe('idle prompt', () => {
  it('tells the model to answer with 1 to 3 tags and lists the syntax', () => {
    const system = idleSystemPrompt('Mei');
    expect(system).toContain('You decide what Mei does on their own in a room while nobody is talking to them.');
    expect(system).toContain('Reply with only 1 to 3 action tags, nothing else.');
    for (const tag of ['{go:<object>}', '{look:<object>}', '{sit:<object>}', '{stand}', '{pick:<object>}', '{put:<object>@<surface>}', '{come}', '{move:', '{wait}']) {
      expect(system).toContain(tag);
    }
  });

  it('describes the character, the room, what can be reached, the state, the recent actions and the time', () => {
    const { system, user } = buildIdlePrompt(input());
    expect(system).toContain('Mei');
    expect(user).toContain('Character: Mei');
    const personality = user.split('\n').find((line) => line.startsWith('Personality: ')) ?? '';
    expect(personality.length).toBeLessThanOrEqual('Personality: '.length + 300);
    expect(user).toContain('Idle habits: Sits by the window with tea.');
    expect(user).toContain('Room: Reading room. A warm reading room');
    expect(user).toContain('- sofa (sit, go to / look at)');
    expect(user).toContain('- bookshelf (go to / look at); idle idea: browse the books');
    expect(user).toContain('- mug (pick up)');
    expect(user).toContain('- coffee table (go to / look at, put things on)');
    expect(user).not.toContain('- rug');
    expect(user).toContain('Right now: standing in the middle of the room');
    // Only the last five recent actions.
    expect(user).toContain('- did c\n- did d\n- did e\n- did f\n- did g');
    expect(user).not.toContain('did b');
    expect(user).toContain('Time: evening, 19:40');
    expect(user.trimEnd().endsWith('Prefer variety. Use {wait} to stay as you are.')).toBe(true);
  });

  it('leaves out empty parts', () => {
    const { user } = buildIdlePrompt(input({ habits: '  ', personality: '', recent: [], visible: [] }));
    expect(user).not.toContain('Idle habits');
    expect(user).not.toContain('Personality');
    expect(user).toContain('What they did recently: nothing yet');
    expect(user).toContain('- nothing in particular');
  });

  it('names the time of day', () => {
    expect(timeOfDay(new Date(2026, 0, 1, 7, 5))).toBe('morning, 07:05');
    expect(timeOfDay(new Date(2026, 0, 1, 14, 0))).toBe('afternoon, 14:00');
    expect(timeOfDay(new Date(2026, 0, 1, 23, 30))).toBe('night, 23:30');
    expect(timeOfDay(new Date(2026, 0, 1, 2, 0))).toBe('night, 02:00');
  });

  it('describes where the avatar is: near something, seated, holding something', () => {
    expect(nearestObject(room.objects, [-2.0, 0, -0.5])?.id).toBe('bookshelf');
    expect(nearestObject(room.objects, [0, 0, 1.5])).toBeNull();
    expect(describeState(input({ position: [-2.0, 0, -0.5] }))).toBe('standing near the bookshelf');
    const seated: IdleInput['state'] = { posture: 'seated', held: null, seat: { objectId: 'armchair', session: 's', frame: { origin: { x: 0, z: 0, yaw: 0 }, scale: 1 }, approach: [0, 0, 0], facing: 0 } };
    expect(describeState(input({ state: seated }))).toBe('seated on the armchair');
    expect(describeState(input({ state: { ...INITIAL_STATE, held: { objectId: 'mug', hand: 'left' } } }))).toBe(
      'standing in the middle of the room, holding the mug',
    );
  });

  it('lists where the other avatars are, and leaves the prompt as it was with none', () => {
    const base = buildIdlePrompt(input());
    expect(buildIdlePrompt(input({ others: [] }))).toEqual(base);
    expect(base.user).not.toContain('Others in the room');
    const { user } = buildIdlePrompt(input({ others: [{ name: 'Echo', where: 'sitting on the sofa' }, { name: 'Rex', where: null }] }));
    expect(user).toContain('Others in the room:\n- Echo is sitting on the sofa\n- Rex is in the room');
  });

  it('names the avatar it decides for', () => {
    const { system, user } = buildIdlePrompt(input({ name: 'Sage' }));
    expect(system).toContain('You decide what Sage does on their own');
    expect(user).toContain('Character: Sage');
  });
});
