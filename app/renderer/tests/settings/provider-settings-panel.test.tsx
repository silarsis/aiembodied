import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from '../../../main/src/config/provider-settings.js';
import type { LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import {
  ProviderSettingsPanel,
  acceleratorFromKeyEvent,
  diffProviderSettings,
  formatShortcut,
} from '../../src/settings/provider-settings-panel.js';
import { isTalkTapTarget } from '../../src/talk/tap-to-talk.js';
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

  it('records a push-to-talk key and the tap-to-talk switch, and shows a key that could not be registered', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    render(
      <ProviderSettingsPanel
        settings={defaults()}
        hasApiKey={false}
        voiceStatus={voiceStatus}
        motionStatus={null}
        onSave={onSave}
        pushToTalkStatus={{ shortcut: 'CommandOrControl+Shift+Space', registered: false, error: 'Taken by another app.' }}
      />,
    );

    expect(screen.getByRole('alert')).toHaveTextContent('Taken by another app.');
    const field = screen.getByLabelText('Push-to-talk key') as HTMLInputElement;
    expect(field.value).toBe('Ctrl + Shift + Space');

    fireEvent.keyDown(field, { key: 'k', code: 'KeyK' });
    expect(screen.getByText(/Add Ctrl or Alt/)).toBeInTheDocument();
    fireEvent.keyDown(field, { key: 'F9', code: 'F9', altKey: true });
    expect(field.value).toBe('Alt + F9');
    fireEvent.click(screen.getByLabelText('Tap the conversation screen to talk'));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(onSave).toHaveBeenCalledWith({ talk: { shortcut: 'Alt+F9', tapToTalk: false } }));
  });
});

describe('push-to-talk keys', () => {
  const press = (code: string, modifiers: Partial<Record<'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey', boolean>> = {}) =>
    acceleratorFromKeyEvent({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...modifiers });

  it('turns key presses into Electron accelerators', () => {
    expect(press('Space', { ctrlKey: true, shiftKey: true })).toEqual({ accelerator: 'Ctrl+Shift+Space' });
    expect(press('KeyT', { altKey: true })).toEqual({ accelerator: 'Alt+T' });
    expect(press('Digit1', { metaKey: true })).toEqual({ accelerator: 'Super+1' });
    expect(press('ArrowUp', { ctrlKey: true })).toEqual({ accelerator: 'Ctrl+Up' });
    expect(press('F13')).toEqual({ accelerator: 'F13' });
    expect(press('Pause')).toEqual({ accelerator: 'Pause' });
  });

  it('waits while only modifiers are down and refuses keys that would break typing', () => {
    expect(press('ShiftLeft', { shiftKey: true })).toBeNull();
    expect(press('ControlRight', { ctrlKey: true })).toBeNull();
    expect(press('KeyA')).toMatchObject({ error: expect.stringMatching(/Add Ctrl or Alt/) });
    expect(press('KeyA', { shiftKey: true })).toMatchObject({ error: expect.any(String) });
    expect(press('IntlRo', { ctrlKey: true })).toMatchObject({ error: expect.any(String) });
  });

  it('shows CommandOrControl as Ctrl', () => {
    expect(formatShortcut('CommandOrControl+Shift+Space')).toBe('Ctrl + Shift + Space');
  });

  it('starts talking on a tap anywhere except on a control', () => {
    const panel = document.createElement('section');
    panel.innerHTML = '<div id="stage"><canvas></canvas><button><span id="inner">Go</span></button><select></select></div>';
    expect(isTalkTapTarget(panel.querySelector('canvas'))).toBe(true);
    expect(isTalkTapTarget(panel.querySelector('#stage'))).toBe(true);
    expect(isTalkTapTarget(panel.querySelector('#inner'))).toBe(false);
    expect(isTalkTapTarget(panel.querySelector('select'))).toBe(false);
    expect(isTalkTapTarget(null)).toBe(false);
  });
});
