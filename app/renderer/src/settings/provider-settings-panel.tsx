import { useMemo, useState, type ReactNode } from 'react';
import type {
  ProviderSettings,
  ProviderSettingsPatch,
} from '../../../main/src/config/provider-settings.js';
import type { LocalVoiceStatus } from '../../../main/src/local-voice/types.js';
import type { AvatarMotionStatus } from '../avatar/types.js';
import type { PushToTalkStatus } from '../../../main/src/talk/types.js';
import type { WakeWordOption } from '../../../main/src/wake-word/types.js';
import type { WakeWordBridge } from '../preload-api.js';
import { WakeWordTraining, describeWakeWordOption, useWakeWordLibrary } from './wake-word-training.js';

/** Suggestions only: every model field also takes any other model name. */
const OPENAI_LLM_MODELS = ['gpt-4.1-mini', 'gpt-4.1', 'gpt-4.1-nano', 'gpt-4o-mini', 'gpt-4o'];
const OPENAI_STT_MODELS = ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'];
/** Realtime API models; OpenAI is retiring the /v1/audio/speech ones (tts-1, gpt-4o-mini-tts). */
const OPENAI_TTS_MODELS = ['gpt-realtime-2.1-mini', 'gpt-realtime-2.1', 'gpt-realtime-2'];
const OPENAI_MOTION_MODELS = ['gpt-4.1-mini', 'gpt-4.1'];
/** The Realtime API's voices. */
export const OPENAI_TTS_VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'];

/** The fields of `draft` that differ from `saved`, so only real changes are stored. */
export function diffProviderSettings(saved: ProviderSettings, draft: ProviderSettings): ProviderSettingsPatch {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as (keyof ProviderSettings)[]) {
    const next = draft[key];
    const current = saved[key];
    if (typeof next === 'object' && typeof current === 'object') {
      const changed = Object.fromEntries(
        Object.entries(next).filter(([field, value]) => (current as Record<string, unknown>)[field] !== value),
      );
      if (Object.keys(changed).length > 0) {
        patch[key] = changed;
      }
    } else if (next !== current) {
      patch[key] = next;
    }
  }
  return patch as ProviderSettingsPatch;
}

export interface ProviderSettingsPanelProps {
  settings: ProviderSettings | null;
  hasApiKey: boolean;
  voiceStatus: LocalVoiceStatus | null | undefined;
  motionStatus: AvatarMotionStatus | null;
  onSave(patch: ProviderSettingsPatch): Promise<void>;
  /** Whether the saved push-to-talk key could be registered. */
  pushToTalkStatus?: PushToTalkStatus | null;
  /** Lists the wake words and trains new ones; without it only the current wake word shows. */
  wakeWordBridge?: WakeWordBridge;
  disabled?: boolean;
}

export function ProviderSettingsPanel({
  settings,
  hasApiKey,
  voiceStatus,
  motionStatus,
  onSave,
  pushToTalkStatus = null,
  wakeWordBridge,
  disabled = false,
}: ProviderSettingsPanelProps) {
  const wakeWords = useWakeWordLibrary(wakeWordBridge);
  const [draft, setDraft] = useState<ProviderSettings | null>(settings);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ kind: 'info' | 'error'; text: string } | null>(null);

  // Take in settings saved elsewhere (or the first load) unless there are unsaved edits.
  const [base, setBase] = useState<ProviderSettings | null>(settings);
  if (settings !== base) {
    const dirty = base && draft ? Object.keys(diffProviderSettings(base, draft)).length > 0 : false;
    setBase(settings);
    if (!dirty) {
      setDraft(settings);
    }
  }

  const patch = useMemo(() => (settings && draft ? diffProviderSettings(settings, draft) : {}), [settings, draft]);
  const dirty = Object.keys(patch).length > 0;

  if (!draft || !settings) {
    return <p className="kiosk__helper">Loading settings…</p>;
  }

  const update = <K extends keyof ProviderSettings>(section: K, value: Partial<ProviderSettings[K]> | ProviderSettings[K]) => {
    setMessage(null);
    setDraft((previous) => {
      if (!previous) {
        return previous;
      }
      const current = previous[section];
      return {
        ...previous,
        [section]: typeof current === 'object' ? { ...current, ...(value as object) } : value,
      };
    });
  };

  const save = async () => {
    setSaving(true);
    setMessage(null);
    try {
      await onSave(patch);
      setMessage({ kind: 'info', text: 'Settings saved and applied.' });
    } catch (error) {
      setMessage({ kind: 'error', text: error instanceof Error ? error.message : 'Failed to save settings.' });
    } finally {
      setSaving(false);
    }
  };

  const busy = disabled || saving;
  const usesOpenAi =
    draft.llm.provider === 'openai' ||
    draft.stt.provider === 'openai' ||
    draft.tts.provider === 'openai' ||
    draft.motion.provider === 'openai';
  const kokoroVoices = voiceStatus?.speech.voices ?? [];
  const kokoroDefault = voiceStatus?.speech.defaultVoice ?? null;
  const kokoroOptions =
    draft.tts.kokoroVoice && !kokoroVoices.includes(draft.tts.kokoroVoice)
      ? [draft.tts.kokoroVoice, ...kokoroVoices]
      : kokoroVoices;
  const openAiVoiceOptions = OPENAI_TTS_VOICES.includes(draft.tts.openaiVoice)
    ? OPENAI_TTS_VOICES
    : [draft.tts.openaiVoice, ...OPENAI_TTS_VOICES];
  const localSttModel = voiceStatus?.stt?.provider !== 'openai' ? (voiceStatus?.stt?.model ?? voiceStatus?.speech.sttModel) : null;
  const runningMotionBackend = motionStatus?.provider !== 'openai' ? motionStatus?.backend : null;
  // The status is for the saved key, so it says nothing about an unsaved edit.
  const savedShortcutStatus = pushToTalkStatus?.shortcut === settings.talk.shortcut ? pushToTalkStatus : null;
  const shortcutActive = Boolean(savedShortcutStatus?.registered);
  const shortcutError = savedShortcutStatus?.error;
  const wakeWordOptions: WakeWordOption[] = wakeWords.options ?? [];
  if (!wakeWordOptions.some((option) => option.model === draft.wakeWord.model)) {
    wakeWordOptions.unshift({
      model: draft.wakeWord.model,
      label: draft.wakeWord.model.split(/[\\/]/).pop()?.replace(/\.onnx$/i, '') ?? draft.wakeWord.model,
      source: 'trained',
    });
  }

  return (
    <div className="providerSettings">
      {usesOpenAi && !hasApiKey ? (
        <p className="kiosk__error" role="alert">
          OpenAI is selected but no OpenAI API key is set. Add one below.
        </p>
      ) : null}

      <SettingsGroup title="Language model" id="llm">
        <ProviderSelect
          id="settings-llm-provider"
          value={draft.llm.provider}
          onChange={(provider) => update('llm', { provider: provider as ProviderSettings['llm']['provider'] })}
          options={[
            ['local', 'Local (llama-server)'],
            ['openai', 'OpenAI'],
          ]}
          disabled={busy}
        />
        {draft.llm.provider === 'local' ? (
          <>
            <TextField
              id="settings-llm-local-url"
              label="Server URL"
              value={draft.llm.localBaseUrl}
              onChange={(localBaseUrl) => update('llm', { localBaseUrl })}
              disabled={busy}
            />
            <TextField
              id="settings-llm-local-model"
              label="Model"
              value={draft.llm.localModel}
              onChange={(localModel) => update('llm', { localModel })}
              disabled={busy}
            />
          </>
        ) : (
          <TextField
            id="settings-llm-openai-model"
            label="Model"
            value={draft.llm.openaiModel}
            onChange={(openaiModel) => update('llm', { openaiModel })}
            suggestions={OPENAI_LLM_MODELS}
            disabled={busy}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Speech-to-text" id="stt">
        <ProviderSelect
          id="settings-stt-provider"
          value={draft.stt.provider}
          onChange={(provider) => update('stt', { provider: provider as ProviderSettings['stt']['provider'] })}
          options={[
            ['local', 'Local (speech service)'],
            ['openai', 'OpenAI'],
          ]}
          disabled={busy}
        />
        {draft.stt.provider === 'local' ? (
          <p className="kiosk__helper">
            {localSttModel ? `Running: ${localSttModel}. ` : ''}
            The speech service picks the model when it starts (Qwen3-ASR, or faster-whisper with STT_ENGINE=whisper).
          </p>
        ) : (
          <TextField
            id="settings-stt-openai-model"
            label="Model"
            value={draft.stt.openaiModel}
            onChange={(openaiModel) => update('stt', { openaiModel })}
            suggestions={OPENAI_STT_MODELS}
            disabled={busy}
          />
        )}
      </SettingsGroup>

      <SettingsGroup title="Text-to-speech" id="tts">
        <ProviderSelect
          id="settings-tts-provider"
          value={draft.tts.provider}
          onChange={(provider) => update('tts', { provider: provider as ProviderSettings['tts']['provider'] })}
          options={[
            ['kokoro', 'Kokoro (local)'],
            ['openai', 'OpenAI'],
          ]}
          disabled={busy}
        />
        {draft.tts.provider === 'kokoro' ? (
          <div className="control">
            <label htmlFor="settings-tts-kokoro-voice">Voice</label>
            <select
              id="settings-tts-kokoro-voice"
              value={draft.tts.kokoroVoice}
              onChange={(event) => update('tts', { kokoroVoice: event.target.value })}
              disabled={busy}
            >
              <option value="">Service default{kokoroDefault ? ` (${kokoroDefault})` : ''}</option>
              {kokoroOptions.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
            {kokoroVoices.length === 0 ? (
              <p className="kiosk__helper">The speech service is not answering, so its voice list is unavailable.</p>
            ) : null}
          </div>
        ) : (
          <>
            <TextField
              id="settings-tts-openai-model"
              label="Model"
              value={draft.tts.openaiModel}
              onChange={(openaiModel) => update('tts', { openaiModel })}
              suggestions={OPENAI_TTS_MODELS}
              disabled={busy}
            />
            <div className="control">
              <label htmlFor="settings-tts-openai-voice">Voice</label>
              <select
                id="settings-tts-openai-voice"
                value={draft.tts.openaiVoice}
                onChange={(event) => update('tts', { openaiVoice: event.target.value })}
                disabled={busy}
              >
                {openAiVoiceOptions.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </select>
            </div>
            <div className="control">
              <label htmlFor="settings-tts-openai-instructions">Voice style</label>
              <textarea
                id="settings-tts-openai-instructions"
                rows={2}
                placeholder="e.g. Warm and upbeat, with a light British accent."
                value={draft.tts.openaiInstructions}
                onChange={(event) => update('tts', { openaiInstructions: event.target.value })}
                disabled={busy}
              />
            </div>
            <p className="kiosk__helper">
              Speaks through the OpenAI Realtime API, which reads each sentence aloud as written.
            </p>
          </>
        )}
      </SettingsGroup>

      <SettingsGroup title="Motion" id="motion">
        <ProviderSelect
          id="settings-motion-provider"
          value={draft.motion.provider}
          onChange={(provider) => update('motion', { provider: provider as ProviderSettings['motion']['provider'] })}
          options={[
            ['local', 'Local (motion service, live)'],
            ['openai', 'OpenAI (keyframe clips)'],
          ]}
          disabled={busy}
        />
        {draft.motion.provider === 'local' ? (
          <>
            <div className="control">
              <label htmlFor="settings-motion-backend">Model</label>
              <select
                id="settings-motion-backend"
                value={draft.motion.localBackend}
                onChange={(event) =>
                  update('motion', { localBackend: event.target.value === 'kimodo' ? 'kimodo' : 'ardy' })
                }
                disabled={busy}
              >
                <option value="ardy">ARDY (live streaming)</option>
                <option value="kimodo">Kimodo (whole clips)</option>
              </select>
              <p className="kiosk__helper">
                {runningMotionBackend ? `Running: ${runningMotionBackend}. ` : ''}
                pnpm dev:run starts the motion service with this model; stop a running one for a change to apply.
              </p>
            </div>
            <TextField
              id="settings-motion-url"
              label="Service URL"
              value={draft.motion.localServiceUrl}
              onChange={(localServiceUrl) => update('motion', { localServiceUrl })}
              disabled={busy}
            />
          </>
        ) : (
          <>
            <TextField
              id="settings-motion-openai-model"
              label="Model"
              value={draft.motion.openaiModel}
              onChange={(openaiModel) => update('motion', { openaiModel })}
              suggestions={OPENAI_MOTION_MODELS}
              disabled={busy}
            />
            <p className="kiosk__helper">
              OpenAI writes whole keyframe clips when you generate an animation on the Character tab. There is no
              live motion: replies play your saved animations.
            </p>
          </>
        )}
      </SettingsGroup>

      {draft.stt.provider === 'local' || draft.tts.provider === 'kokoro' ? (
        <SettingsGroup title="Speech service" id="speech">
          <TextField
            id="settings-speech-url"
            label="Service URL"
            value={draft.speechServiceUrl}
            onChange={(speechServiceUrl) => update('speechServiceUrl', speechServiceUrl)}
            disabled={busy}
          />
        </SettingsGroup>
      ) : null}

      <SettingsGroup title="Wake word" id="wake">
        <div className="control">
          <label htmlFor="settings-wake-model">Listen for</label>
          <select
            id="settings-wake-model"
            value={draft.wakeWord.model}
            onChange={(event) => update('wakeWord', { model: event.target.value })}
            disabled={busy}
          >
            {wakeWordOptions.map((option) => (
              <option key={option.model} value={option.model}>
                {describeWakeWordOption(option)}
                {option.source === 'trained' ? ' (trained here)' : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="control">
          <label htmlFor="settings-wake-threshold">Detection threshold</label>
          <input
            id="settings-wake-threshold"
            type="number"
            min={0.1}
            max={0.95}
            step={0.05}
            value={draft.wakeWord.threshold}
            onChange={(event) => {
              const threshold = Number(event.target.value);
              if (Number.isFinite(threshold) && threshold > 0 && threshold < 1) {
                update('wakeWord', { threshold });
              }
            }}
            disabled={busy}
          />
        </div>
        <p className="kiosk__helper">
          Higher means fewer false wakes but more missed ones. 0.5 suits most models; try 0.7 if she wakes on her own.
        </p>
        {wakeWordBridge ? (
          <WakeWordTraining training={wakeWords.training} onTrain={wakeWords.train} onCancel={wakeWords.cancel} disabled={disabled} />
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Talking without the wake word" id="talk">
        <ShortcutField
          id="settings-talk-shortcut"
          label="Push-to-talk key"
          value={draft.talk.shortcut}
          onChange={(shortcut) => update('talk', { shortcut })}
          disabled={busy}
        />
        <p className="kiosk__helper">
          Works from any app. Press it and speak; press it again to send straight away instead of waiting for a pause.
          During a reply it stops the reply and listens.
          {shortcutActive ? ` Active: ${formatShortcut(settings.talk.shortcut)}.` : ''}
        </p>
        {shortcutError ? (
          <p className="kiosk__error" role="alert">
            {shortcutError}
          </p>
        ) : null}
        <div className="control">
          <label htmlFor="settings-talk-tap">
            <input
              id="settings-talk-tap"
              type="checkbox"
              checked={draft.talk.tapToTalk}
              onChange={(event) => update('talk', { tapToTalk: event.target.checked })}
              disabled={busy}
            />{' '}
            Tap the conversation screen to talk
          </label>
        </div>
      </SettingsGroup>

      <div className="secretCard__actions providerSettings__actions">
        <button type="button" onClick={() => void save()} disabled={busy || !dirty}>
          {saving ? 'Saving…' : 'Save settings'}
        </button>
        <button type="button" onClick={() => setDraft(settings)} disabled={busy || !dirty}>
          Discard changes
        </button>
      </div>
      {message ? (
        <p role={message.kind === 'error' ? 'alert' : 'status'} className={message.kind === 'error' ? 'kiosk__error' : 'kiosk__info'}>
          {message.text}
        </p>
      ) : null}
    </div>
  );
}

function SettingsGroup({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <fieldset className="providerSettings__group" aria-labelledby={`settings-${id}-title`}>
      <legend id={`settings-${id}-title`}>{title}</legend>
      {children}
    </fieldset>
  );
}

function ProviderSelect({
  id,
  value,
  onChange,
  options,
  disabled,
}: {
  id: string;
  value: string;
  onChange(value: string): void;
  options: [string, string][];
  disabled: boolean;
}) {
  return (
    <div className="control">
      <label htmlFor={id}>Provider</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)} disabled={disabled}>
        {options.map(([optionValue, label]) => (
          <option key={optionValue} value={optionValue}>
            {label}
          </option>
        ))}
      </select>
    </div>
  );
}

function TextField({
  id,
  label,
  value,
  onChange,
  suggestions,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  suggestions?: string[];
  disabled: boolean;
}) {
  return (
    <div className="control">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        list={suggestions ? `${id}-options` : undefined}
        spellCheck={false}
        disabled={disabled}
      />
      {suggestions ? (
        <datalist id={`${id}-options`}>
          {suggestions.map((suggestion) => (
            <option key={suggestion} value={suggestion} />
          ))}
        </datalist>
      ) : null}
    </div>
  );
}

const KEY_NAMES: Record<string, string> = {
  Space: 'Space',
  Enter: 'Enter',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
  Backquote: '`',
  Pause: 'Pause',
  ScrollLock: 'Scrolllock',
  MediaPlayPause: 'MediaPlayPause',
  MediaTrackNext: 'MediaNextTrack',
  MediaTrackPrevious: 'MediaPreviousTrack',
  MediaStop: 'MediaStop',
};

/** Keys that are fine as a global shortcut on their own, because nothing types them. */
const STANDALONE_KEY = /^(F\d{1,2}|Pause|Scrolllock|Media\w+)$/;

export type ShortcutCapture = { accelerator: string } | { error: string } | null;

/**
 * The Electron accelerator for a key press, e.g. Ctrl+Shift+Space. Null while only modifiers are
 * down; an error for a key that would stop typing in every other app.
 */
export function acceleratorFromKeyEvent(event: {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}): ShortcutCapture {
  const { code } = event;
  let key: string | undefined;
  if (/^Key[A-Z]$/.test(code)) {
    key = code.slice(3);
  } else if (/^Digit\d$/.test(code)) {
    key = code.slice(5);
  } else if (/^Numpad\d$/.test(code)) {
    key = `num${code.slice(6)}`;
  } else if (/^F\d{1,2}$/.test(code)) {
    key = code;
  } else {
    key = KEY_NAMES[code];
  }
  if (!key) {
    return /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/.test(code) ? null : { error: `${code} can't be used as a shortcut.` };
  }
  const modifiers = [
    event.ctrlKey ? 'Ctrl' : null,
    event.altKey ? 'Alt' : null,
    event.shiftKey ? 'Shift' : null,
    event.metaKey ? 'Super' : null,
  ].filter((modifier): modifier is string => modifier !== null);
  const typesText = modifiers.length === 0 || (modifiers.length === 1 && modifiers[0] === 'Shift');
  if (typesText && !STANDALONE_KEY.test(key)) {
    return { error: 'Add Ctrl or Alt: on its own that key would stop working in every other app.' };
  }
  return { accelerator: [...modifiers, key].join('+') };
}

/** An accelerator as people read it: CommandOrControl is Ctrl on Windows. */
export function formatShortcut(accelerator: string): string {
  return accelerator.replace(/\b(CommandOrControl|CmdOrCtrl|Control)\b/g, 'Ctrl').replace(/\+/g, ' + ');
}

function ShortcutField({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: string;
  onChange(value: string): void;
  disabled: boolean;
}) {
  const [hint, setHint] = useState<string | null>(null);
  return (
    <div className="control">
      <label htmlFor={id}>{label}</label>
      <div className="providerSettings__shortcut">
        <input
          id={id}
          type="text"
          readOnly
          value={value ? formatShortcut(value) : ''}
          placeholder="Off"
          aria-describedby={`${id}-hint`}
          onKeyDown={(event) => {
            if (event.key === 'Tab') {
              return;
            }
            event.preventDefault();
            const plain = !event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey;
            if (plain && event.key === 'Escape') {
              event.currentTarget.blur();
              return;
            }
            if (plain && (event.key === 'Backspace' || event.key === 'Delete')) {
              setHint(null);
              onChange('');
              return;
            }
            const capture = acceleratorFromKeyEvent(event);
            if (!capture) {
              return;
            }
            if ('error' in capture) {
              setHint(capture.error);
              return;
            }
            setHint(null);
            onChange(capture.accelerator);
          }}
          onBlur={() => setHint(null)}
          disabled={disabled}
        />
        <button type="button" onClick={() => onChange('')} disabled={disabled || !value}>
          Turn off
        </button>
      </div>
      <p id={`${id}-hint`} className={hint ? 'kiosk__error' : 'kiosk__helper'}>
        {hint ?? 'Click the box and press the keys you want. Backspace clears it.'}
      </p>
    </div>
  );
}
