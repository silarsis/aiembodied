/** "Avatars" in Status and diagnostics: add, rename, pick the body of, set the prompt of, and remove avatars. */
import { useState } from 'react';
import type { AvatarProfile, AvatarsBridge } from '../../../main/src/avatars/bridge-types.js';

export interface AvatarManagerModel {
  id: string;
  name: string;
}

const ECHO_ID = 'echo';
const NAME_MAX = 80;
const PROMPT_MAX = 4000;

interface Props {
  api?: AvatarsBridge;
  profiles: AvatarProfile[];
  models: AvatarManagerModel[];
  /** A 3D room is the stage; rooms still show only Echo. */
  roomActive?: boolean;
  /** Called after any successful change so the app can re-read the list at once. */
  onChanged?: () => void | Promise<void>;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

function BodySelect({ value, models, disabled, onChange, label }: {
  value: string | null;
  models: AvatarManagerModel[];
  disabled?: boolean;
  onChange: (id: string | null) => void;
  label: string;
}) {
  return (
    <select aria-label={label} value={value ?? ''} disabled={disabled} onChange={(event) => onChange(event.target.value || null)}>
      <option value="">No body yet</option>
      {models.map((model) => (
        <option key={model.id} value={model.id}>{model.name}</option>
      ))}
    </select>
  );
}

function AvatarRow({ api, profile, models, run }: {
  api: AvatarsBridge;
  profile: AvatarProfile;
  models: AvatarManagerModel[];
  run: (action: () => Promise<unknown>) => Promise<boolean>;
}) {
  const [name, setName] = useState(profile.name);
  const [prompt, setPrompt] = useState(profile.prompt ?? '');
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isEcho = profile.id === ECHO_ID;
  return (
    <li data-testid={`avatar-row-${profile.id}`} style={{ marginBottom: 8 }}>
      <input
        aria-label={`Name of ${profile.name}`}
        value={name}
        maxLength={NAME_MAX}
        onChange={(event) => setName(event.target.value)}
        onBlur={() => {
          const next = name.trim();
          if (next && next !== profile.name) void run(() => api.update(profile.id, { name: next }));
          else setName(profile.name);
        }}
      />{' '}
      <BodySelect
        label={`Body of ${profile.name}`}
        value={profile.vrmModelId}
        models={models}
        disabled={isEcho}
        onChange={(id) => void run(() => api.update(profile.id, { vrmModelId: id }))}
      />{' '}
      <button type="button" onClick={() => setOpen(!open)}>{open ? 'Hide prompt' : 'Prompt'}</button>{' '}
      {isEcho ? null : confirming ? (
        <>
          <button type="button" onClick={() => void run(() => api.remove(profile.id))}>Confirm remove</button>{' '}
          <button type="button" onClick={() => setConfirming(false)}>Cancel</button>
        </>
      ) : (
        <button type="button" onClick={() => setConfirming(true)}>Remove</button>
      )}
      {open ? (
        <div>
          <textarea
            aria-label={`Prompt of ${profile.name}`}
            value={prompt}
            maxLength={PROMPT_MAX}
            rows={4}
            onChange={(event) => setPrompt(event.target.value)}
            onBlur={() => {
              if (prompt.trim() !== (profile.prompt ?? '')) void run(() => api.update(profile.id, { prompt }));
            }}
          />
          {isEcho ? <span className="kiosk__helper"> Echo&apos;s saved character prompt, when set, takes priority.</span> : null}
        </div>
      ) : null}
    </li>
  );
}

export function AvatarManager({ api, profiles, models, roomActive = false, onChanged }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newBody, setNewBody] = useState<string | null>(null);
  const [newPrompt, setNewPrompt] = useState('');
  if (!api || typeof api.add !== 'function') return null;

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    try {
      await action();
      setError(null);
      await onChanged?.();
      return true;
    } catch (caught) {
      setError(message(caught));
      return false;
    }
  };

  const add = async () => {
    const name = newName.trim();
    if (!name) {
      setError('Give the avatar a name.');
      return;
    }
    const ok = await run(() =>
      api.add({ name, ...(newBody ? { vrmModelId: newBody } : {}), ...(newPrompt.trim() ? { prompt: newPrompt } : {}) }),
    );
    if (ok) {
      setNewName('');
      setNewBody(null);
      setNewPrompt('');
    }
  };

  return (
    <div className="kiosk__helper" data-testid="avatar-manager">
      <strong>Avatars</strong>
      {roomActive && profiles.length >= 2 ? (
        <p role="note">Other avatars stand still beside Echo in rooms for now.</p>
      ) : null}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {profiles.map((profile) => (
            <AvatarRow api={api} key={`${profile.id}:${profile.name}:${profile.prompt ?? ''}`} profile={profile} models={models} run={run} />
          ))}
        </ul>
      <div>
        <input aria-label="New avatar name" placeholder="New avatar name" value={newName} maxLength={NAME_MAX} onChange={(event) => setNewName(event.target.value)} />{' '}
        <BodySelect label="New avatar body" value={newBody} models={models} onChange={setNewBody} />{' '}
        <button type="button" onClick={() => void add()}>Add avatar</button>
        <div>
          <textarea aria-label="New avatar prompt" placeholder="Prompt (optional)" rows={2} value={newPrompt} maxLength={PROMPT_MAX} onChange={(event) => setNewPrompt(event.target.value)} />
        </div>
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
