import { describe, expect, it } from 'vitest';
import { buildAnimationInstructions } from '../../src/avatar/animation-instructions.js';
import { buildSceneInstructions, describeAvatarWhere, objectAffordances } from '../../src/rooms/scene-instructions.js';
import { builtInRoom } from './fixtures.js';

describe('scene instructions', () => {
  const room = builtInRoom('reading-room');

  it('lists the room name and what each object allows, from its tags', () => {
    const text = buildSceneInstructions(room, true);
    expect(text).toContain('Reading room');
    expect(text).toContain('sofa (sit, go to / look at)');
    expect(text).toContain('coffee table (go to / look at, put things on)');
    expect(text).toContain('mug (pick up)');
    expect(text).toContain('bookshelf (go to / look at)');
    // Objects with nothing to do are left out.
    expect(text).not.toContain('rug');
    expect(text).not.toContain('floor lamp');
  });

  it('says where the others are when it is known, else keeps the plain line', () => {
    const text = buildSceneInstructions(room, true, '', [
      { name: 'Sage', where: 'sitting on the sofa' },
      { name: 'Rex', where: null },
      'Ada',
    ]);
    expect(text).toContain('Sage is sitting on the sofa. Rex is in the room with you. Ada is in the room with you.');
    expect(buildSceneInstructions(room, true, '', [{ name: 'Sage' }])).toBe(buildSceneInstructions(room, true, '', ['Sage']));
  });

  it('describes where an avatar is from its seat or the nearest listed object', () => {
    expect(describeAvatarWhere(room, { seatedOn: 'sofa' })).toBe('sitting on the sofa');
    expect(describeAvatarWhere(room, { position: { x: -2.6, z: -0.5 } })).toBe('standing near the bookshelf');
    // The lamp and the rug have nothing to do, so they are never "near".
    expect(describeAvatarWhere(room, { position: { x: -2.55, z: -2.15 } })).not.toContain('lamp');
    expect(describeAvatarWhere(room, { position: { x: 40, z: 40 } })).toBeNull();
    expect(describeAvatarWhere(room, {})).toBeNull();
    expect(describeAvatarWhere(null, { seatedOn: 'sofa' })).toBeNull();
  });

  it('explains the tags in a couple of sentences, with the example and the ordering rules', () => {
    const text = buildSceneInstructions(room, true);
    for (const tag of ['{go:<object>}', '{look:<object>}', '{sit:<object>}', '{stand}', '{come}', '{pick:<object>}', '{put:<object>@<surface>}']) {
      expect(text).toContain(tag);
    }
    expect(text).toContain('Use these only when they fit the conversation');
    expect(text).toContain('one after another, in the order written');
    expect(text).toContain('`{go:bookshelf}{move:runs a finger along the book spines}`');
  });

  it('names the other avatars in the room, and is unchanged without any', () => {
    const plain = buildSceneInstructions(room, true, 'sat down');
    expect(buildSceneInstructions(room, true, 'sat down', [])).toBe(plain);
    expect(buildSceneInstructions(room, true)).toBe(buildSceneInstructions(room, true, '', []));
    const withOthers = buildSceneInstructions(room, true, '', ['Sage', 'Rex']);
    expect(withOthers).toContain('Sage is in the room with you. Rex is in the room with you.');
    expect(withOthers.startsWith(buildSceneInstructions(room, true).replace(/\.$/, ''))).toBe(true);
    expect(buildSceneInstructions(null, true, '', ['Sage'])).toBe('');
  });

  it('is empty in 2D or without the motion service', () => {
    expect(buildSceneInstructions(null, true)).toBe('');
    expect(buildSceneInstructions(undefined, true)).toBe('');
    expect(buildSceneInstructions(room, false)).toBe('');
  });

  it('only offers pick up for dynamic objects with a grab tag', () => {
    const mug = room.objects.find((object) => object.id === 'mug')!;
    expect(objectAffordances(mug)).toEqual(['pick up']);
    expect(objectAffordances({ ...mug, dynamic: false })).toEqual([]);
  });

  it('is appended to the animation instructions, leaving them unchanged without a room', () => {
    const plain = buildAnimationInstructions(['wave'], ['relaxed-neutral'], true);
    expect(buildAnimationInstructions(['wave'], ['relaxed-neutral'], true, '')).toBe(plain);
    const inRoom = buildAnimationInstructions(['wave'], ['relaxed-neutral'], true, buildSceneInstructions(room, true));
    expect(inRoom.startsWith(plain)).toBe(true);
    expect(inRoom).toContain('You are standing in a 3D room');
    expect(inRoom.startsWith('Available animations:')).toBe(true);
  });

  it('adds one line about what the avatar did while idle, only in a room with live motion', () => {
    const base = buildSceneInstructions(room, true);
    const note = 'walked to the bookshelf (browses the books); sat down on the armchair';
    const text = buildSceneInstructions(room, true, note);
    expect(text).toBe(`${base} Just before this, while idle, you: ${note}.`);
    expect(buildSceneInstructions(room, true, '  ')).toBe(base);
    expect(buildSceneInstructions(null, true, note)).toBe('');
    expect(buildSceneInstructions(room, false, note)).toBe('');
  });

  it('matches the instructions of the studio flat too', () => {
    const flat = builtInRoom('studio-flat');
    const text = buildSceneInstructions(flat, true);
    expect(text).toContain(flat.name);
    expect(text).toMatch(/\(sit/);
  });
});
