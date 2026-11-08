import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ModelServerView } from '../../../main/src/config/config-manager.js';
import type { SpeechTtsEngine } from '../../../main/src/local-voice/speech-service-client.js';
import { SpeakingEngineFields } from '../../src/settings/speaking-engines.js';

const server: ModelServerView = { id: 'local-speech', name: 'This PC', type: 'speech', url: 'http://127.0.0.1:8192', builtIn: true, managed: true, hasKey: false };

function engines(kittenInstalled = false, downloading = false): SpeechTtsEngine[] {
  return [
    { id: 'kokoro', label: 'Kokoro', available: true, error: null, models: [{ id: 'kokoro', label: 'kokoro', installed: true, voices: ['bf_lily', 'af_heart'], defaultVoice: 'bf_lily', download: null }] },
    {
      id: 'kitten',
      label: 'Kitten TTS',
      available: true,
      error: null,
      models: [
        {
          id: 'mini-0.8',
          label: 'Kitten mini 0.8',
          installed: kittenInstalled,
          sizeMb: 80,
          voices: ['Rosie', 'Bella'],
          defaultVoice: 'Rosie',
          download: downloading ? { status: 'downloading', received: 40e6, total: 80e6, error: null } : null,
        },
        { id: 'nano-0.8', label: 'Kitten nano 0.8', installed: false, sizeMb: 25, voices: ['Rosie'], defaultVoice: 'Rosie', download: null },
      ],
    },
    {
      id: 'piper',
      label: 'Piper',
      available: false,
      error: 'ModuleNotFoundError: piper',
      models: [{ id: 'en_GB-alba-medium', label: 'en_GB-alba-medium', installed: false, voices: ['en_GB-alba-medium'], defaultVoice: 'en_GB-alba-medium', download: null }],
    },
  ];
}

describe('SpeakingEngineFields', () => {
  it('switches engine, downloads a Kitten model and shows its progress', async () => {
    let list = engines();
    const api = {
      speechEngines: vi.fn(async () => list),
      speechDownload: vi.fn(async () => {
        list = engines(false, true);
        return list;
      }),
    };
    const onRoute = vi.fn();
    const { rerender } = render(<SpeakingEngineFields api={api} server={server} route={{ server: 'local-speech', model: 'bf_lily' }} busy={false} onRoute={onRoute} />);

    const engine = (await screen.findByLabelText('Engine')) as HTMLSelectElement;
    expect(engine.value).toBe('kokoro');
    // An old saved Kokoro voice is the default voice.
    expect((screen.getByLabelText('Default voice') as HTMLSelectElement).value).toBe('bf_lily');
    expect(screen.getByRole('option', { name: /Piper \(not installed/ })).toHaveProperty('disabled', true);

    fireEvent.change(engine, { target: { value: 'kitten' } });
    expect(onRoute).toHaveBeenCalledWith({ server: 'local-speech', model: 'kitten:mini-0.8', voice: undefined });

    rerender(<SpeakingEngineFields api={api} server={server} route={{ server: 'local-speech', model: 'kitten:mini-0.8' }} busy={false} onRoute={onRoute} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Download' }));
    await waitFor(() => expect(api.speechDownload).toHaveBeenCalledWith('local-speech', 'kitten', 'mini-0.8'));
    expect(await screen.findByText('Downloading… 40 MB of 80 MB')).toBeTruthy();

    list = engines(true);
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Download' })).toBeNull(), { timeout: 3000 });
    fireEvent.change(screen.getByLabelText('Default voice'), { target: { value: 'Bella' } });
    expect(onRoute).toHaveBeenLastCalledWith({ server: 'local-speech', model: 'kitten:mini-0.8', voice: 'Bella' });
  });

  it('says so when the speech service has no engine list', async () => {
    const api = { speechEngines: vi.fn(async () => null), speechDownload: vi.fn() };
    render(<SpeakingEngineFields api={api} server={server} route={{ server: 'local-speech' }} busy={false} onRoute={vi.fn()} />);
    expect(await screen.findByText(/too old to offer Kitten and Piper/)).toBeTruthy();
  });
});
