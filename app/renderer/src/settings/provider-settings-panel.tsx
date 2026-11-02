import { useMemo, useState, type ReactNode } from 'react';
import type {
  ProviderSettings,
  ProviderSettingsPatch,
} from '../../../main/src/config/provider-settings.js';
import type { PushToTalkStatus } from '../../../main/src/talk/types.js';
import type { WakeWordOption } from '../../../main/src/wake-word/types.js';
import type { WakeWordBridge } from '../preload-api.js';
import { WakeWordTraining, describeWakeWordOption, useWakeWordLibrary } from './wake-word-training.js';

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
  onSave(patch: ProviderSettingsPatch): Promise<void>;
  /** Whether the saved push-to-talk key could be registered. */
  pushToTalkStatus?: PushToTalkStatus | null;
  /** Lists the wake words and trains new ones; without it only the current wake word shows. */
  wakeWordBridge?: WakeWordBridge;
  disabled?: boolean;
  renderLayout?: (sections: { devices: ReactNode; actions: ReactNode }) => ReactNode;
}

export function ProviderSettingsPanel({
  settings,
  onSave,
  pushToTalkStatus = null,
  wakeWordBridge,
  disabled = false,
  renderLayout,
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
    const loading = <p className="kiosk__helper">Loading settings…</p>;
    return renderLayout ? renderLayout({ devices: loading, actions: null }) : loading;
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

  const devices = (
    <div className="providerSettings">
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


    </div>
  );
  const actions = (
    <>
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
    </>
  );
  return renderLayout ? renderLayout({ devices, actions }) : <div className="providerSettings">{devices}{actions}</div>;
}

function SettingsGroup({ title, id, children }: { title: string; id: string; children: ReactNode }) {
  return (
    <fieldset className="providerSettings__group" aria-labelledby={`settings-${id}-title`}>
      <legend id={`settings-${id}-title`}>{title}</legend>
      {children}
    </fieldset>
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
