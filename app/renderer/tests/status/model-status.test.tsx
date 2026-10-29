import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import { AssistantStatusPanel } from '../../src/status/assistant-status.js';
import { describeModels } from '../../src/status/model-status.js';

const voice = (overrides: Partial<LocalVoiceStatus> = {}): LocalVoiceStatus => ({
  llm: { available: true, model: 'qwen-next-flash', baseUrl: 'http://127.0.0.1:1234/v1' },
  stt: { available: true, model: 'qwen3-asr', url: 'http://127.0.0.1:1235/v1' },
  speech: {
    available: true,
    ready: true,
    sttModel: 'qwen3-asr',
    ttsModel: 'kokoro',
    voices: ['bf_lily'],
    defaultVoice: 'bf_lily',
    error: null,
  },
  ...overrides,
});

const motion = { available: true, ready: true, backend: 'ardy', device: 'cuda:0' };

describe('describeModels', () => {
  it('labels OpenAI parts and needs only the key for them', () => {
    const models = describeModels(
      voice({
        llm: { available: true, model: 'gpt-4.1-mini', baseUrl: 'https://api.openai.com/v1', provider: 'openai' },
        tts: { provider: 'openai', available: true, ready: true, model: 'gpt-4o-mini-tts', voice: 'alloy', error: null },
        speech: { ...voice().speech, available: false, ready: false },
      }),
      { provider: 'openai', available: true, ready: false, backend: null, device: null, model: 'gpt-4.1-mini' },
    );
    const byId = Object.fromEntries(models.map((m) => [m.id, m]));
    expect(byId.llm).toMatchObject({ state: 'ready', model: 'OpenAI gpt-4.1-mini' });
    expect(byId.tts).toMatchObject({ state: 'ready', model: 'OpenAI gpt-4o-mini-tts alloy' });
    expect(byId.motion).toMatchObject({ state: 'ready', model: 'OpenAI gpt-4.1-mini' });
  });

  it('reports every model loaded when all checks pass', () => {
    const models = describeModels(voice(), motion);
    expect(models.map((m) => [m.id, m.state])).toEqual([
      ['llm', 'ready'],
      ['stt', 'ready'],
      ['tts', 'ready'],
      ['motion', 'ready'],
    ]);
    expect(models.find((m) => m.id === 'tts')?.model).toBe('kokoro bf_lily');
  });

  it('shows a down STT server even while the speech service itself is ready', () => {
    const models = describeModels(voice({ stt: { available: false, model: 'qwen3-asr', url: 'http://127.0.0.1:1235/v1' } }), motion);
    const stt = models.find((m) => m.id === 'stt');
    expect(stt?.state).toBe('down');
    expect(stt?.detail).toBe('not answering at http://127.0.0.1:1235/v1');
    expect(models.find((m) => m.id === 'tts')?.state).toBe('ready');
  });

  it('follows the speech service for in-process STT', () => {
    const status = voice({ stt: { available: false, model: 'large-v3-turbo', url: null } });
    status.speech.ready = false;
    expect(describeModels(status, motion).find((m) => m.id === 'stt')?.state).toBe('loading');
  });

  it('distinguishes loading, failed and not running', () => {
    const status = voice({ llm: { available: false, model: 'qwen-next-flash', baseUrl: 'http://llm' } });
    status.speech.error = 'kokoro model missing';
    const models = describeModels(status, { ...motion, ready: false });
    expect(models.find((m) => m.id === 'llm')?.state).toBe('down');
    expect(models.find((m) => m.id === 'tts')).toMatchObject({ state: 'error', detail: 'kokoro model missing' });
    expect(models.find((m) => m.id === 'motion')?.state).toBe('loading');
  });

  it('shows everything as not running when the checks themselves fail', () => {
    expect(describeModels(null, null).every((m) => m.state === 'down')).toBe(true);
  });
});

describe('AssistantStatusPanel models', () => {
  it('lists each model with its state', () => {
    render(
      <AssistantStatusPanel
        activity={{ phase: 'waiting', since: Date.now() }}
        wakeScore={null}
        toolCalls={[]}
        models={describeModels(voice({ stt: { available: false, model: 'qwen3-asr', url: 'http://asr' } }), motion)}
      />,
    );

    const items = within(screen.getByTestId('model-status')).getAllByRole('listitem');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('Language model');
    expect(items[0]).toHaveTextContent('loaded');
    expect(items[1]).toHaveAttribute('data-state', 'down');
    expect(items[1]).toHaveTextContent('not running');
  });

  it('says it is checking before the first result, and hides the section when there are no local models', () => {
    const { rerender } = render(
      <AssistantStatusPanel activity={{ phase: 'off', since: 0 }} wakeScore={null} toolCalls={[]} models={null} />,
    );
    expect(screen.getByText('Checking…')).toBeInTheDocument();

    rerender(<AssistantStatusPanel activity={{ phase: 'off', since: 0 }} wakeScore={null} toolCalls={[]} />);
    expect(screen.queryByText('Models')).not.toBeInTheDocument();
  });
});
