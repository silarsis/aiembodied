/** One character's personality prompt, idle habits and voice: the settings inside each scene card's Edit panel. */
import { useId } from 'react';
import type { SpeakingVoiceOptions } from '../../../main/src/local-voice/types.js';

export interface TextControl {
  value: string;
  onChange(value: string): void;
  /** Where the value is saved (the field lost focus). */
  onBlur(): void;
  disabled?: boolean;
}

export interface HabitsControl extends TextControl {
  maxLength: number;
}

/**
 * The voice select. `engine` is the local backend: the voices of the engine that speaks now (null while
 * they are being read). `list` is the OpenAI backend: a fixed list of voice names.
 */
export type VoiceControl =
  | { kind: 'engine'; options: SpeakingVoiceOptions | null; onChange(voice: string): void; disabled?: boolean }
  | { kind: 'list'; voices: string[]; value: string; onChange(voice: string): void; disabled?: boolean };

export interface CharacterSettingsControls {
  prompt: TextControl;
  habits: HabitsControl;
  voice: VoiceControl;
}

export const PROMPT_MAX = 4000;

function VoiceSelect({ id, name, voice }: { id: string; name: string; voice: VoiceControl }) {
  if (voice.kind === 'list') {
    return (
      <div className="control">
        <label htmlFor={id}>Voice</label>
        <select
          id={id}
          aria-label={`Voice of ${name}`}
          value={voice.value}
          onChange={(event) => voice.onChange(event.target.value)}
          disabled={voice.disabled || voice.voices.length === 0}
        >
          {voice.voices.map((entry) => (
            <option key={entry} value={entry}>{entry}</option>
          ))}
        </select>
      </div>
    );
  }
  const options = voice.options;
  const helper = options?.engine
    ? `Spoken by ${options.label}. Change the engine in Models and servers, Speaking.`
    : options
      ? 'Nothing is set to speak. Pick a server in Models and servers, Speaking.'
      : 'Reading the voices…';
  return (
    <div className="control">
      <label htmlFor={id}>Voice</label>
      <select
        id={id}
        aria-label={`Voice of ${name}`}
        value={options?.selected ?? ''}
        onChange={(event) => voice.onChange(event.target.value)}
        disabled={voice.disabled || !options?.engine}
      >
        <option value="">Default{options?.defaultVoice ? ` (${options.defaultVoice})` : ''}</option>
        {options?.selected && !options.voices.includes(options.selected) ? (
          <option value={options.selected}>{options.selected} (not available)</option>
        ) : null}
        {(options?.voices ?? []).map((entry) => (
          <option key={entry} value={entry}>{entry}</option>
        ))}
      </select>
      <small className="kiosk__helper">{helper}</small>
    </div>
  );
}

export function CharacterSettings({ name, controls }: { name: string; controls: CharacterSettingsControls }) {
  const uid = useId();
  const { prompt, habits, voice } = controls;
  return (
    <div className="characterSettings">
      <div className="control">
        <label htmlFor={`${uid}-prompt`}>Prompt</label>
        <textarea
          id={`${uid}-prompt`}
          aria-label={`Prompt of ${name}`}
          placeholder="Stay in English and be concise. Add personality here…"
          rows={4}
          maxLength={PROMPT_MAX}
          value={prompt.value}
          onChange={(event) => prompt.onChange(event.target.value)}
          onBlur={prompt.onBlur}
          disabled={prompt.disabled}
        />
        <small className="kiosk__helper">How this character talks and behaves.</small>
      </div>
      <div className="control">
        <label htmlFor={`${uid}-habits`}>Idle habits</label>
        <textarea
          id={`${uid}-habits`}
          aria-label={`Idle habits of ${name}`}
          placeholder="Sits by the window with tea; tidies when bored."
          rows={2}
          maxLength={habits.maxLength}
          value={habits.value}
          onChange={(event) => habits.onChange(event.target.value)}
          onBlur={habits.onBlur}
          disabled={habits.disabled}
        />
        <small className="kiosk__helper">What they do when nobody is talking.</small>
      </div>
      <VoiceSelect id={`${uid}-voice`} name={name} voice={voice} />
    </div>
  );
}
