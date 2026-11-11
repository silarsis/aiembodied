import { describe, expect, it } from 'vitest';
import { composeAvatarPrompt, readTagInstructions } from '../src/avatars/tag-instructions.js';

const tags = { shared: 'SHARED tags', moveOnly: 'MOVE only' };

describe('composeAvatarPrompt', () => {
  it('appends the shared tags to the persona after a blank line', () => {
    expect(composeAvatarPrompt({ name: 'Sage', persona: 'You are calm.', ownModel: false, tags })).toBe('You are calm.\n\nSHARED tags');
  });

  it('gives an avatar with its own body only the move tags', () => {
    expect(composeAvatarPrompt({ name: 'Sage', persona: 'You are calm.', ownModel: true, tags })).toBe('You are calm.\n\nMOVE only');
  });

  it('uses a default persona when none is saved', () => {
    expect(composeAvatarPrompt({ name: 'Sage', persona: undefined, ownModel: false, tags })).toBe(
      'You are Sage, an AI character who shares a room with Kevin and Echo.\n\nSHARED tags',
    );
  });

  it('leaves the persona alone before tags are sent', () => {
    const none = { shared: '', moveOnly: '' };
    expect(composeAvatarPrompt({ name: 'Sage', persona: 'You are calm.', ownModel: false, tags: none })).toBe('You are calm.');
    expect(composeAvatarPrompt({ name: 'Sage', persona: undefined, ownModel: false, tags: none })).toBeUndefined();
  });
});

describe('composeAvatarPrompt with the scene', () => {
  const withScene = { ...tags, scene: 'ROOM text', sceneFor: { sage: 'ROOM text, Echo is in the room with you.' } };

  it('appends the scene after the tag instructions for the avatar\'s own variant, else the shared one', () => {
    expect(composeAvatarPrompt({ name: 'Sage', persona: 'You are calm.', ownModel: false, tags: withScene, avatarId: 'sage' })).toBe(
      'You are calm.\n\nSHARED tags ROOM text, Echo is in the room with you.',
    );
    expect(composeAvatarPrompt({ name: 'Rex', persona: 'You are calm.', ownModel: true, tags: withScene, avatarId: 'rex' })).toBe(
      'You are calm.\n\nMOVE only ROOM text',
    );
    expect(composeAvatarPrompt({ name: 'Rex', persona: 'p', ownModel: true, tags: withScene })).toBe('p\n\nMOVE only ROOM text');
  });

  it('adds no scene when there is none or no tag instructions', () => {
    expect(composeAvatarPrompt({ name: 'Sage', persona: 'p', ownModel: false, tags })).toBe('p\n\nSHARED tags');
    expect(composeAvatarPrompt({ name: 'Sage', persona: 'p', ownModel: false, tags: { shared: '', moveOnly: '', scene: 'ROOM' } })).toBe('p');
  });
});

describe('readTagInstructions', () => {
  it('reads the scene text and per-avatar scene text, dropping bad values', () => {
    expect(readTagInstructions({ shared: 'a', moveOnly: 'b', scene: ' room ', sceneFor: { sage: ' x ', rex: 5, big: 'y'.repeat(20_001) } })).toEqual({
      shared: 'a',
      moveOnly: 'b',
      scene: 'room',
      sceneFor: { sage: 'x' },
    });
    expect(readTagInstructions({ shared: 'a', scene: 'z'.repeat(20_001), sceneFor: 'no' })).toEqual({ shared: 'a', moveOnly: '' });
  });

  it('accepts strings and drops anything else or too long', () => {
    expect(readTagInstructions({ shared: ' a ', moveOnly: 'b' })).toEqual({ shared: 'a', moveOnly: 'b' });
    expect(readTagInstructions({ shared: 5, moveOnly: 'x'.repeat(20_001) })).toEqual({ shared: '', moveOnly: '' });
    expect(readTagInstructions(null)).toEqual({ shared: '', moveOnly: '' });
  });
});
