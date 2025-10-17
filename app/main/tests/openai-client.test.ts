import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { getOpenAIClient, clearOpenAIClientCache } from '../src/openai/client.js';

const TEST_KEY = 'sk-test';

describe('getOpenAIClient', () => {
  beforeEach(() => {
    clearOpenAIClientCache();
  });

  afterEach(() => {
    clearOpenAIClientCache();
  });

  it('throws when provided API key is empty', () => {
    expect(() => getOpenAIClient('')).toThrow(
      'An OpenAI API key is required to create a client instance.',
    );
    expect(() => getOpenAIClient('   ')).toThrow(
      'An OpenAI API key is required to create a client instance.',
    );
  });

  it('caches OpenAI clients by normalized API key', () => {
    const first = getOpenAIClient(TEST_KEY);
    const second = getOpenAIClient(`  ${TEST_KEY}   `);

    expect(second).toBe(first);
  });

  it('creates new clients when the API key changes', () => {
    const first = getOpenAIClient(TEST_KEY);
    const second = getOpenAIClient(`${TEST_KEY}-other`);

    expect(second).not.toBe(first);
  });
});
