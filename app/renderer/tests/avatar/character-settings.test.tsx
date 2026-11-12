import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { CharacterSettings, type CharacterSettingsControls } from '../../src/avatar/character-settings.js';

function controls(overrides: Partial<CharacterSettingsControls> = {}): CharacterSettingsControls {
  return {
    prompt: { value: 'Calm.', onChange: vi.fn(), onBlur: vi.fn() },
    habits: { value: 'Tea.', onChange: vi.fn(), onBlur: vi.fn(), maxLength: 500 },
    voice: { kind: 'engine', options: { engine: 'kokoro', label: 'Kokoro', voices: ['a', 'b'], defaultVoice: 'a', selected: null }, onChange: vi.fn() },
    ...overrides,
  };
}

describe('CharacterSettings', () => {
  it('shows Prompt, Idle habits and Voice labelled with the character\'s name', () => {
    render(<CharacterSettings name="Sage" controls={controls()} />);
    expect((screen.getByLabelText('Prompt of Sage') as HTMLTextAreaElement).value).toBe('Calm.');
    expect((screen.getByLabelText('Idle habits of Sage') as HTMLTextAreaElement).maxLength).toBe(500);
    expect(screen.getByText('How this character talks and behaves.')).toBeInTheDocument();
    expect(screen.getByText('What they do when nobody is talking.')).toBeInTheDocument();
    expect(screen.getByText(/Spoken by Kokoro/)).toBeInTheDocument();
  });

  it('saves on blur and on change', () => {
    const c = controls();
    render(<CharacterSettings name="Sage" controls={c} />);
    fireEvent.change(screen.getByLabelText('Prompt of Sage'), { target: { value: 'x' } });
    fireEvent.blur(screen.getByLabelText('Prompt of Sage'));
    fireEvent.change(screen.getByLabelText('Idle habits of Sage'), { target: { value: 'y' } });
    fireEvent.blur(screen.getByLabelText('Idle habits of Sage'));
    fireEvent.change(screen.getByLabelText('Voice of Sage'), { target: { value: 'b' } });
    expect(c.prompt.onChange).toHaveBeenCalledWith('x');
    expect(c.prompt.onBlur).toHaveBeenCalled();
    expect(c.habits.onChange).toHaveBeenCalledWith('y');
    expect(c.habits.onBlur).toHaveBeenCalled();
    expect(c.voice.onChange).toHaveBeenCalledWith('b');
  });

  it('lists the default and the engine\'s voices, and keeps a saved voice the engine no longer has', () => {
    const c = controls({ voice: { kind: 'engine', options: { engine: 'piper', label: 'Piper', voices: ['a'], defaultVoice: 'a', selected: 'gone' }, onChange: vi.fn() } });
    render(<CharacterSettings name="Sage" controls={c} />);
    const select = screen.getByLabelText('Voice of Sage') as HTMLSelectElement;
    expect([...select.options].map((o) => o.textContent)).toEqual(['Default (a)', 'gone (not available)', 'a']);
    expect(select.value).toBe('gone');
  });

  it('says what is wrong when nothing speaks or the voices are still loading', () => {
    const { rerender } = render(<CharacterSettings name="Sage" controls={controls({ voice: { kind: 'engine', options: null, onChange: vi.fn() } })} />);
    expect(screen.getByText('Reading the voices…')).toBeInTheDocument();
    expect(screen.getByLabelText('Voice of Sage')).toBeDisabled();
    rerender(
      <CharacterSettings
        name="Sage"
        controls={controls({ voice: { kind: 'engine', options: { engine: null, label: 'Nothing speaks', voices: [], defaultVoice: null, selected: null }, onChange: vi.fn() } })}
      />,
    );
    expect(screen.getByText(/Nothing is set to speak/)).toBeInTheDocument();
    expect(screen.getByLabelText('Voice of Sage')).toBeDisabled();
  });

  it('uses a plain list of voices for the OpenAI backend', () => {
    const onChange = vi.fn();
    const c = controls({ voice: { kind: 'list', voices: ['alloy', 'ash'], value: 'ash', onChange } });
    const { rerender } = render(<CharacterSettings name="Sage" controls={c} />);
    const select = screen.getByLabelText('Voice of Sage') as HTMLSelectElement;
    expect(select.value).toBe('ash');
    fireEvent.change(select, { target: { value: 'alloy' } });
    expect(onChange).toHaveBeenCalledWith('alloy');
    rerender(<CharacterSettings name="Sage" controls={controls({ voice: { kind: 'list', voices: [], value: '', onChange } })} />);
    expect(screen.getByLabelText('Voice of Sage')).toBeDisabled();
  });
});
