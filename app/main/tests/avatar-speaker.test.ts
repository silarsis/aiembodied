import { describe, expect, it } from 'vitest';
import { tagEvent, tagResult } from '../src/avatars/speaker.js';
import { FloorController } from '../src/floor/index.js';
import type { LocalVoiceEvent, LocalVoiceRespondRequest, LocalVoiceRespondResult } from '../src/local-voice/types.js';

describe('avatar speaker stamping', () => {
  it('stamps events and results, echo included', () => {
    const event: LocalVoiceEvent = { requestId: 'r', type: 'sentence', index: 0, text: 'Hi', wav: new Uint8Array(1) };
    expect(tagEvent(event, 'echo').avatarId).toBe('echo');
    expect(tagEvent(event, 'sage').avatarId).toBe('sage');
    expect(event.avatarId).toBeUndefined();
    const result: LocalVoiceRespondResult = { requestId: 'r', text: 'Hi', cancelled: false };
    expect(tagResult(result, 'echo')).toEqual({ ...result, avatarId: 'echo' });
  });

  it('a floor-routed answer to "Sage, ..." carries Sage on events and result', async () => {
    const sent: LocalVoiceEvent[] = [];
    const profiles = [
      { id: 'echo', name: 'Echo', vrmModelId: 'm1' },
      { id: 'sage', name: 'Sage', vrmModelId: 'm1' },
    ];
    const run = async (avatarId: string, request: LocalVoiceRespondRequest): Promise<LocalVoiceRespondResult> => {
      sent.push(tagEvent({ requestId: request.requestId, type: 'sentence', index: 0, text: 'Hi', wav: new Uint8Array(1) }, avatarId));
      return tagResult({ requestId: request.requestId, text: 'Hi', cancelled: false }, avatarId);
    };
    const floor = new FloorController({
      registry: { list: () => profiles, get: (id) => profiles.find((p) => p.id === id) ?? null },
      store: { getValue: () => null, setValue: () => undefined },
      voice: () => null,
      runPersonTurn: run,
      saveLine: () => undefined,
      bid: async () => [],
      now: () => 1_000,
    });
    const result = await floor.respondToPerson({ requestId: 'q1', text: 'Sage, what do you think?' });
    expect(result.avatarId).toBe('sage');
    expect(sent.map((e) => e.avatarId)).toEqual(['sage']);
    expect(sent[0]?.requestId).toBe('q1');
  });
});
