import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { CharacterSettingsControls } from '../../src/avatar/character-settings.js';
import { SceneCast } from '../../src/avatar/scene-cast.js';
import type { CharacterSettingsContext } from '../../src/avatar/use-character-settings.js';

const echo = { id: 'echo', name: 'Echo', vrmModelId: 'm1' };
const sage = { id: 'sage', name: 'Sage', vrmModelId: null, prompt: 'Be calm.' };
const luna = { id: 'luna', name: 'Luna', vrmModelId: 'm2' };
const models = [
  { id: 'm1', name: 'Body One', thumbnailDataUrl: 'data:image/png;base64,AAA' },
  { id: 'm2', name: 'Body Two', thumbnailDataUrl: null },
  { id: 'm3', name: 'Body Three', thumbnailDataUrl: 'data:image/png;base64,BBB' },
];

function makeApi() {
  return {
    list: vi.fn(async () => [echo, sage]),
    add: vi.fn(async (input: { name: string }) => ({ id: 'x', name: input.name, vrmModelId: null })),
    update: vi.fn(async (id: string, changes: object) => ({ ...sage, id, ...changes })),
    remove: vi.fn(async () => undefined),
  };
}

describe('SceneCast', () => {
  it('shows a card per profile in order, the Host badge and who shares Echo\'s body', () => {
    render(<SceneCast api={makeApi()} profiles={[echo, sage, luna]} models={models} />);
    expect(screen.getByRole('heading', { name: 'In the scene' })).toBeInTheDocument();
    expect(screen.getByText(/Echo is the host and answers when no one is named/)).toBeInTheDocument();
    const cards = within(screen.getByRole('list', { name: 'Characters in the scene' })).getAllByRole('listitem');
    expect(cards.map((card) => card.getAttribute('data-testid'))).toEqual(['scene-card-echo', 'scene-card-sage', 'scene-card-luna']);
    expect(within(cards[0]).getByText('Host')).toBeInTheDocument();
    expect(within(cards[1]).queryByText('Host')).toBeNull();
    expect(within(cards[1]).getByText("Shares Echo's body")).toBeInTheDocument();
    expect(within(cards[0]).queryByText("Shares Echo's body")).toBeNull();
    expect(within(cards[2]).queryByText("Shares Echo's body")).toBeNull();
    expect(cards[0].querySelector('img')?.getAttribute('src')).toBe('data:image/png;base64,AAA');
    expect(cards[2].querySelector('img')).toBeNull();
  });

  it('adds a library character in one click, then refreshes', async () => {
    const api = makeApi();
    const onChanged = vi.fn();
    render(<SceneCast api={api} profiles={[echo]} models={models} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add Body Two to scene' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ name: 'Body Two', vrmModelId: 'm2' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('offers only library characters nobody in the scene wears', () => {
    const { rerender } = render(<SceneCast api={makeApi()} profiles={[echo, luna]} models={models} />);
    const tiles = within(screen.getByRole('list', { name: 'Characters you can add' }));
    expect(tiles.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Add Body Three to scene']);
    rerender(<SceneCast api={makeApi()} profiles={[echo, luna, { id: 'r', name: 'R', vrmModelId: 'm3' }]} models={models} />);
    expect(screen.queryByRole('list', { name: 'Characters you can add' })).toBeNull();
    expect(screen.getByText(/already in the scene/)).toBeInTheDocument();
  });

  it('adds by name, with an optional prompt, and clears the form', async () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo]} models={[]} />);
    fireEvent.change(screen.getByLabelText('New character name'), { target: { value: ' Rex ' } });
    fireEvent.change(screen.getByLabelText('New character prompt'), { target: { value: 'Be bold.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ name: 'Rex', prompt: 'Be bold.' }));
    await waitFor(() => expect((screen.getByLabelText('New character name') as HTMLInputElement).value).toBe(''));
    fireEvent.change(screen.getByLabelText('New character name'), { target: { value: 'Pip' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    await waitFor(() => expect(api.add).toHaveBeenLastCalledWith({ name: 'Pip' }));
  });

  it('asks for a name before adding by name', () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo]} models={[]} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add character' }));
    expect(screen.getByRole('alert').textContent).toBe('Give the character a name.');
    expect(api.add).not.toHaveBeenCalled();
  });

  it('edits name and body on one row, with no settings until the app supplies them', async () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} />);
    expect(screen.queryByLabelText('Name of Sage')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
    const name = screen.getByLabelText('Name of Sage');
    fireEvent.change(name, { target: { value: 'Sagey' } });
    fireEvent.blur(name);
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { name: 'Sagey' }));
    fireEvent.change(screen.getByLabelText('Body of Sage'), { target: { value: 'm3' } });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { vrmModelId: 'm3' }));
    fireEvent.change(screen.getByLabelText('Body of Sage'), { target: { value: '' } });
    await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { vrmModelId: null }));
    expect(name.closest('.sceneCard__pair')).toBe(screen.getByLabelText('Body of Sage').closest('.sceneCard__pair'));
    expect(screen.queryByLabelText('Prompt of Sage')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
    expect(screen.queryByLabelText('Name of Sage')).toBeNull();
  });

  it('does not save an unchanged or blank name', () => {
    const api = makeApi();
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
    const name = screen.getByLabelText('Name of Sage') as HTMLInputElement;
    fireEvent.change(name, { target: { value: '  ' } });
    fireEvent.blur(name);
    expect(api.update).not.toHaveBeenCalled();
    expect(name.value).toBe('Sage');
  });

  it('locks Echo\'s body and explains why', () => {
    render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: 'Edit Echo' }));
    expect(screen.getByLabelText('Body of Echo')).toBeDisabled();
    expect(screen.getByText('Echo wears the active character picked below.')).toBeInTheDocument();
  });

  it('confirms before removing, and Echo has no Remove', async () => {
    const api = makeApi();
    const onChanged = vi.fn();
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} onChanged={onChanged} />);
    expect(screen.queryByRole('button', { name: 'Remove Echo from the scene' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sage from the scene' }));
    expect(screen.getByText('Remove Sage from the scene?')).toBeInTheDocument();
    expect(api.remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel removing Sage' }));
    expect(screen.queryByText('Remove Sage from the scene?')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sage from the scene' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Sage' }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith('sage'));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('shows a readable error', async () => {
    const api = makeApi();
    api.remove.mockRejectedValueOnce(new Error("Error invoking remote method 'avatars:remove': Error: Cannot remove the last avatar."));
    render(<SceneCast api={api} profiles={[echo, sage]} models={models} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove Sage from the scene' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm removing Sage' }));
    expect((await screen.findByRole('alert')).textContent).toBe('Cannot remove the last avatar.');
  });

  it('notes that others stand beside Echo when a room is active with 2+ avatars', () => {
    const { rerender } = render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} roomActive />);
    expect(screen.getByRole('note').textContent).toContain('every avatar walks, gestures, keeps clear of the others and wanders when idle');
    rerender(<SceneCast api={makeApi()} profiles={[echo]} models={models} roomActive />);
    expect(screen.queryByRole('note')).toBeNull();
  });

  it('renders nothing without the bridge', () => {
    const { container, rerender } = render(<SceneCast profiles={[]} models={[]} />);
    expect(container.firstChild).toBeNull();
    rerender(<SceneCast api={{} as never} profiles={[]} models={[]} />);
    expect(container.firstChild).toBeNull();
  });

  describe('settings in the Edit panel', () => {
    const voiceOptions = (selected: string | null) => ({ engine: 'kokoro' as const, label: 'Kokoro', voices: ['af_heart', 'am_adam'], defaultVoice: 'af_heart', selected });

    function makeContext(overrides: Partial<CharacterSettingsContext> = {}) {
      const echoControls: CharacterSettingsControls = {
        prompt: { value: 'Echo prompt', onChange: vi.fn(), onBlur: vi.fn() },
        habits: { value: 'Echo habits', onChange: vi.fn(), onBlur: vi.fn(), maxLength: 500 },
        voice: { kind: 'engine', options: voiceOptions('af_heart'), onChange: vi.fn() },
      };
      const avatarApi = {
        getVoicePreference: vi.fn(async () => null as string | null),
        setVoicePreference: vi.fn(async () => undefined),
        getPromptPreference: vi.fn(async (): Promise<string | null> => null),
        setPromptPreference: vi.fn(async () => undefined),
        getIdleHabits: vi.fn(async () => 'Hums.'),
        setIdleHabits: vi.fn(async () => undefined),
      };
      const getVoiceOptions = vi.fn(async () => voiceOptions('am_adam'));
      const context: CharacterSettingsContext = {
        avatarApi,
        getVoiceOptions,
        isLocalBackend: true,
        realtimeVoices: ['alloy', 'ash'],
        echo: echoControls,
        ...overrides,
      };
      return { context, echoControls, avatarApi, getVoiceOptions };
    }

    it('Echo\'s card shows the controls the app hands over and never calls the per-avatar API for her', () => {
      const { context, echoControls, avatarApi, getVoiceOptions } = makeContext();
      render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} settings={context} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Echo' }));
      const prompt = screen.getByLabelText('Prompt of Echo') as HTMLTextAreaElement;
      expect(prompt.value).toBe('Echo prompt');
      fireEvent.change(prompt, { target: { value: 'More' } });
      expect(echoControls.prompt.onChange).toHaveBeenCalledWith('More');
      fireEvent.blur(prompt);
      expect(echoControls.prompt.onBlur).toHaveBeenCalled();
      const habits = screen.getByLabelText('Idle habits of Echo') as HTMLTextAreaElement;
      expect(habits.value).toBe('Echo habits');
      expect(habits.maxLength).toBe(500);
      fireEvent.blur(habits);
      expect(echoControls.habits.onBlur).toHaveBeenCalled();
      const voice = screen.getByLabelText('Voice of Echo') as HTMLSelectElement;
      expect(voice.value).toBe('af_heart');
      fireEvent.change(voice, { target: { value: 'am_adam' } });
      expect(echoControls.voice.onChange).toHaveBeenCalledWith('am_adam');
      expect(avatarApi.getIdleHabits).not.toHaveBeenCalled();
      expect(getVoiceOptions).not.toHaveBeenCalled();
    });

    it('a character sharing Echo\'s body edits its profile prompt and its own habits and voice', async () => {
      const api = makeApi();
      const onChanged = vi.fn();
      const { context, avatarApi, getVoiceOptions } = makeContext();
      render(<SceneCast api={api} profiles={[echo, sage]} models={models} settings={context} onChanged={onChanged} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
      const prompt = screen.getByLabelText('Prompt of Sage') as HTMLTextAreaElement;
      expect(prompt.value).toBe('Be calm.');
      expect(avatarApi.getPromptPreference).not.toHaveBeenCalled();
      fireEvent.blur(prompt);
      expect(api.update).not.toHaveBeenCalled();
      fireEvent.change(prompt, { target: { value: 'Be bold.' } });
      fireEvent.blur(prompt);
      await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { prompt: 'Be bold.' }));
      await waitFor(() => expect(onChanged).toHaveBeenCalled());
      fireEvent.change(prompt, { target: { value: '' } });
      fireEvent.blur(prompt);
      await waitFor(() => expect(api.update).toHaveBeenCalledWith('sage', { prompt: '' }));
      expect(avatarApi.setPromptPreference).not.toHaveBeenCalled();

      const habits = screen.getByLabelText('Idle habits of Sage') as HTMLTextAreaElement;
      await waitFor(() => expect(habits.value).toBe('Hums.'));
      expect(avatarApi.getIdleHabits).toHaveBeenCalledWith('sage');
      fireEvent.blur(habits);
      expect(avatarApi.setIdleHabits).not.toHaveBeenCalled();
      fireEvent.change(habits, { target: { value: '  Naps.  ' } });
      fireEvent.blur(habits);
      await waitFor(() => expect(avatarApi.setIdleHabits).toHaveBeenCalledWith('Naps.', 'sage'));

      const voice = screen.getByLabelText('Voice of Sage') as HTMLSelectElement;
      await waitFor(() => expect(voice.value).toBe('am_adam'));
      expect(getVoiceOptions).toHaveBeenCalledWith('sage');
      fireEvent.change(voice, { target: { value: '' } });
      await waitFor(() => expect(avatarApi.setVoicePreference).toHaveBeenCalledWith('', 'kokoro', 'sage'));
    });

    it('a character with a body of its own saves its prompt for that body and shows the profile prompt only as a starting point', async () => {
      const api = makeApi();
      const { context, avatarApi } = makeContext();
      const withFallback = { ...luna, prompt: 'Fallback.' };
      const { rerender } = render(<SceneCast api={api} profiles={[echo, withFallback]} models={models} settings={context} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Luna' }));
      const prompt = screen.getByLabelText('Prompt of Luna') as HTMLTextAreaElement;
      await waitFor(() => expect(prompt.value).toBe('Fallback.'));
      expect(avatarApi.getPromptPreference).toHaveBeenCalledWith('luna');
      fireEvent.change(prompt, { target: { value: 'Luna is shy.' } });
      fireEvent.blur(prompt);
      await waitFor(() => expect(avatarApi.setPromptPreference).toHaveBeenCalledWith('Luna is shy.', 'luna'));
      expect(api.update).not.toHaveBeenCalled();

      // A saved prompt wins over the fallback.
      avatarApi.getPromptPreference.mockResolvedValue('Saved for the body.');
      rerender(<SceneCast api={api} profiles={[echo, { ...luna, prompt: 'Fallback.' }, { id: 'rex', name: 'Rex', vrmModelId: 'm3' }]} models={models} settings={context} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Rex' }));
      await waitFor(() => expect((screen.getByLabelText('Prompt of Rex') as HTMLTextAreaElement).value).toBe('Saved for the body.'));
    });

    it('a character wearing the very body Echo wears keeps a profile prompt like one sharing it', async () => {
      const api = makeApi();
      const { context, avatarApi } = makeContext();
      render(<SceneCast api={api} profiles={[echo, { id: 'twin', name: 'Twin', vrmModelId: 'm1', prompt: 'Twin.' }]} models={models} settings={context} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Twin' }));
      const prompt = screen.getByLabelText('Prompt of Twin') as HTMLTextAreaElement;
      expect(prompt.value).toBe('Twin.');
      fireEvent.change(prompt, { target: { value: 'Twin two.' } });
      fireEvent.blur(prompt);
      await waitFor(() => expect(api.update).toHaveBeenCalledWith('twin', { prompt: 'Twin two.' }));
      expect(avatarApi.setPromptPreference).not.toHaveBeenCalled();
    });

    it('labels every field with the character\'s name so two open cards never clash', () => {
      const { context } = makeContext();
      render(<SceneCast api={makeApi()} profiles={[echo, sage, luna]} models={models} settings={context} />);
      for (const name of ['Echo', 'Sage', 'Luna']) fireEvent.click(screen.getByRole('button', { name: `Edit ${name}` }));
      const ids = new Set<string>();
      for (const name of ['Echo', 'Sage', 'Luna']) {
        for (const label of ['Prompt', 'Idle habits', 'Voice']) {
          const field = screen.getByLabelText(`${label} of ${name}`);
          expect(field.id).not.toBe('');
          expect(ids.has(field.id)).toBe(false);
          ids.add(field.id);
          expect(document.querySelector(`label[for="${CSS.escape(field.id)}"]`)?.textContent).toBe(label);
        }
      }
    });

    it('offers the OpenAI backend\'s voices when the app does not speak locally', async () => {
      const { context, avatarApi, getVoiceOptions } = makeContext({ isLocalBackend: false });
      avatarApi.getVoicePreference.mockResolvedValue('ash');
      render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} settings={context} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
      const voice = screen.getByLabelText('Voice of Sage') as HTMLSelectElement;
      await waitFor(() => expect(voice.value).toBe('ash'));
      expect(avatarApi.getVoicePreference).toHaveBeenCalledWith(undefined, 'sage');
      expect(getVoiceOptions).not.toHaveBeenCalled();
      expect([...voice.options].map((option) => option.value)).toEqual(['alloy', 'ash']);
      fireEvent.change(voice, { target: { value: 'alloy' } });
      await waitFor(() => expect(avatarApi.setVoicePreference).toHaveBeenCalledWith('alloy', undefined, 'sage'));
    });

    it('shows a readable error when a save fails', async () => {
      const { context, avatarApi } = makeContext();
      avatarApi.setIdleHabits.mockRejectedValueOnce(new Error("Error invoking remote method 'avatar:idle-habits:set': Error: Nope."));
      render(<SceneCast api={makeApi()} profiles={[echo, sage]} models={models} settings={context} />);
      fireEvent.click(screen.getByRole('button', { name: 'Edit Sage' }));
      const habits = screen.getByLabelText('Idle habits of Sage');
      await waitFor(() => expect((habits as HTMLTextAreaElement).value).toBe('Hums.'));
      fireEvent.change(habits, { target: { value: 'x' } });
      fireEvent.blur(habits);
      expect((await screen.findByRole('alert')).textContent).toBe('Nope.');
    });
  });
});
