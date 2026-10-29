import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from '../../../main/src/config/provider-settings.js';
import type { LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import {
  ProviderSettingsPanel,
  diffProviderSettings,
} from '../../src/settings/provider-settings-panel.js';
import { describeServiceProblem } from '../../src/realtime/local-voice-client.js';

const voiceStatus: LocalVoiceStatus = {
  llm: { available: true, model: 'qwen-next-flash', baseUrl: 'http://127.0.0.1:1234/v1', provider: 'local' },
  stt: { provider: 'local', available: true, model: 'qwen3-asr', url: 'http://127.0.0.1:1235/v1' },
  tts: { provider: 'kokoro', available: true, ready: true, model: 'kokoro', voice: 'bf_lily', error: null },
  speech: {
    available: true,
    ready: true,
    sttModel: 'qwen3-asr',
    ttsModel: 'kokoro',
    voices: ['bf_emma', 'bf_lily', 'bm_george'],
    defaultVoice: 'bf_lily',
    error: null,
  },
};

function defaults(): ProviderSettings {
  return structuredClone(DEFAULT_PROVIDER_SETTINGS);
}

describe('ProviderSettingsPanel', () => {
  it('offers the Kokoro voices the speech service reports and saves only the change', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProviderSettingsPanel settings={defaults()} hasApiKey={false} voiceStatus={voiceStatus} motionStatus={null} onSave={onSave} />,
    );

    const voice = screen.getByLabelText('Voice') as HTMLSelectElement;
    expect(Array.from(voice.options).map((o) => o.value)).toEqual(['', 'bf_emma', 'bf_lily', 'bm_george']);
    expect(voice.options[0]?.textContent).toBe('Service default (bf_lily)');

    const save = screen.getByRole('button', { name: 'Save settings' });
    expect(save).toBeDisabled();
    fireEvent.change(voice, { target: { value: 'bf_emma' } });
    fireEvent.click(save);

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ tts: { kokoroVoice: 'bf_emma' } }));
    expect(await screen.findByRole('status')).toHaveTextContent('Settings saved and applied.');
  });

  it('shows an OpenAI voice dropdown defaulting to alloy, and warns when there is no key', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProviderSettingsPanel settings={defaults()} hasApiKey={false} voiceStatus={voiceStatus} motionStatus={null} onSave={onSave} />,
    );

    fireEvent.change(screen.getByLabelText('Provider', { selector: '#settings-tts-provider' }), { target: { value: 'openai' } });

    const voice = screen.getByLabelText('Voice') as HTMLSelectElement;
    expect(voice.value).toBe('alloy');
    expect(Array.from(voice.options).map((o) => o.value)).toEqual([
      'alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse',
    ]);
    expect((screen.getByLabelText('Model', { selector: '#settings-tts-openai-model' }) as HTMLInputElement).value).toBe(
      'gpt-realtime-2.1-mini',
    );
    expect(screen.getByLabelText('Voice style')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(/no OpenAI API key/i);

    fireEvent.change(voice, { target: { value: 'coral' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ tts: { provider: 'openai', openaiVoice: 'coral' } }));
  });

  it('shows the fields for the chosen provider of each part', () => {
    const settings = defaults();
    settings.llm.provider = 'openai';
    settings.motion.provider = 'openai';
    render(
      <ProviderSettingsPanel settings={settings} hasApiKey voiceStatus={voiceStatus} motionStatus={null} onSave={vi.fn()} />,
    );

    expect((screen.getByLabelText('Model', { selector: '#settings-llm-openai-model' }) as HTMLInputElement).value).toBe(
      'gpt-4.1-mini',
    );
    expect(screen.queryByLabelText('Server URL')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Model', { selector: '#settings-motion-openai-model' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Model', { selector: '#settings-motion-backend' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('provider settings helpers', () => {
  it('diffs only changed fields', () => {
    const saved = defaults();
    const draft = defaults();
    draft.stt.provider = 'openai';
    draft.speechServiceUrl = 'http://other:8192';
    expect(diffProviderSettings(saved, draft)).toEqual({ stt: { provider: 'openai' }, speechServiceUrl: 'http://other:8192' });
    expect(diffProviderSettings(saved, defaults())).toEqual({});
  });

  it('only needs the speech service for the parts that use it', () => {
    const down = { ...voiceStatus.speech, available: false, ready: false };
    expect(describeServiceProblem({ ...voiceStatus, speech: down })).toMatch(/Speech service is not running/);
    expect(
      describeServiceProblem({
        ...voiceStatus,
        speech: down,
        stt: { provider: 'openai', available: true, model: 'gpt-4o-mini-transcribe', url: null },
        tts: { provider: 'openai', available: true, ready: true, model: 'gpt-realtime-2.1-mini', voice: 'alloy', error: null },
      }),
    ).toBeNull();
    expect(
      describeServiceProblem({ ...voiceStatus, llm: { ...voiceStatus.llm, provider: 'openai', available: false } }),
    ).toMatch(/OpenAI API key/);
  });
});
