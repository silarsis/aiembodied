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

describe('readTagInstructions', () => {
  it('accepts strings and drops anything else or too long', () => {
    expect(readTagInstructions({ shared: ' a ', moveOnly: 'b' })).toEqual({ shared: 'a', moveOnly: 'b' });
    expect(readTagInstructions({ shared: 5, moveOnly: 'x'.repeat(20_001) })).toEqual({ shared: '', moveOnly: '' });
    expect(readTagInstructions(null)).toEqual({ shared: '', moveOnly: '' });
  });
});
