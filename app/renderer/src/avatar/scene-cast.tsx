/** "In the scene" at the top of the Characters pop-up: who is in the scene, add from the library or by name, edit, remove. */
import { useState } from 'react';
import type { AvatarProfile, AvatarsBridge } from '../../../main/src/avatars/bridge-types.js';
import { CharacterSettings } from './character-settings.js';
import { useCharacterSettings, type CharacterSettingsContext, type Run } from './use-character-settings.js';

export interface SceneCastModel {
  id: string;
  name: string;
  thumbnailDataUrl?: string | null;
}

const ECHO_ID = 'echo';
const NAME_MAX = 80;
const PROMPT_MAX = 4000;

interface Props {
  api?: AvatarsBridge;
  profiles: AvatarProfile[];
  models: SceneCastModel[];
  /** A 3D room is the stage; rooms still show only Echo. */
  roomActive?: boolean;
  /** Called after any successful change so the app can re-read the list at once. */
  onChanged?: () => void | Promise<void>;
  /** How to read and save each character's prompt, idle habits and voice. Without it Edit has only name and body. */
  settings?: CharacterSettingsContext;
  /** Puts the host (Echo) in another body: makes that model the active one. Without it Echo's body can't be changed here. */
  onPickHostBody?: (modelId: string) => Promise<void>;
  /** Deletes an avatar from the library. Without it the pictures have no Delete. */
  onDeleteModel?: (modelId: string) => Promise<void>;
}

function message(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/^Error invoking remote method '[^']*': (Error: )?/, '');
}

function Thumbnail({ url, name }: { url: string | null | undefined; name: string }) {
  return (
    <div className="sceneCard__thumb" aria-hidden="true">
      {url ? <img src={url} alt="" loading="lazy" /> : <span>{name.trim().charAt(0).toUpperCase() || '?'}</span>}
    </div>
  );
}

/**
 * The library as a grid of pictures to pick a body from. The picked one is highlighted. With `echoLook`
 * the first tile means "no body of its own": a copy of whatever Echo wears.
 */
function AvatarPicker({ label, models, selected, onSelect, echoLook = false, disabled = false, deletion }: {
  label: string;
  models: SceneCastModel[];
  selected: string | null;
  onSelect: (modelId: string | null) => void;
  echoLook?: boolean;
  disabled?: boolean;
  /** Offers Delete on each avatar. `wornBy` names who wears it; `locked` says why it can't go, if it can't. */
  deletion?: {
    onDelete: (modelId: string) => void;
    wornBy: (modelId: string) => string[];
    locked: (modelId: string) => string | null;
  };
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmModel = confirming ? models.find((model) => model.id === confirming) : undefined;
  const wearers = confirmModel && deletion ? deletion.wornBy(confirmModel.id) : [];
  return (
    <>
      <div className="avatarPicker" role="group" aria-label={label}>
        {echoLook ? (
          <button
            type="button"
            className="avatarPicker__tile"
            aria-pressed={selected === null}
            aria-label="Same look as Echo"
            title="Same look as Echo"
            disabled={disabled}
            onClick={() => onSelect(null)}
          >
            <span className="avatarPicker__img avatarPicker__img--echo" aria-hidden="true">E</span>
            <span className="avatarPicker__name">Like Echo</span>
          </button>
        ) : null}
        {models.map((model) => {
          const tile = (
            <button
              key={model.id}
              type="button"
              className="avatarPicker__tile"
              aria-pressed={selected === model.id}
              aria-label={model.name}
              title={model.name}
              disabled={disabled}
              onClick={() => onSelect(model.id)}
            >
              {model.thumbnailDataUrl ? (
                <img className="avatarPicker__img" src={model.thumbnailDataUrl} alt="" loading="lazy" />
              ) : (
                <span className="avatarPicker__img" aria-hidden="true">{model.name.trim().charAt(0).toUpperCase() || '?'}</span>
              )}
              <span className="avatarPicker__name">{model.name}</span>
            </button>
          );
          if (!deletion) return tile;
          const locked = deletion.locked(model.id);
          return (
            <div key={model.id} className="avatarPicker__cell">
              {tile}
              <button
                type="button"
                className="avatarPicker__delete"
                aria-label={`Delete ${model.name}`}
                title={locked ?? `Delete ${model.name} from the library`}
                disabled={Boolean(locked) || confirming === model.id}
                onClick={() => setConfirming(model.id)}
              >
                ×
              </button>
            </div>
          );
        })}
        {models.length === 0 && !echoLook ? <p className="kiosk__helper">No avatars in the library yet. Upload a .vrm or make one in the studio below.</p> : null}
      </div>
      {confirmModel && deletion ? (
        <div className="sceneCard__confirm" role="group" aria-label={`Delete ${confirmModel.name}`}>
          <span>
            Delete {confirmModel.name} from the library? This can&apos;t be undone.
            {wearers.length > 0 ? ` ${wearers.join(', ')} will look like Echo instead.` : ''}
          </span>
          <button
            type="button"
            aria-label={`Confirm deleting ${confirmModel.name}`}
            onClick={() => {
              setConfirming(null);
              deletion.onDelete(confirmModel.id);
            }}
          >
            Delete
          </button>
          <button type="button" aria-label={`Cancel deleting ${confirmModel.name}`} onClick={() => setConfirming(null)}>Cancel</button>
        </div>
      ) : null}
    </>
  );
}

/** Settings of a character other than Echo, read and saved under its avatar id. */
function OtherSettings({ context, api, profile, ownBody, run }: {
  context: CharacterSettingsContext;
  api: AvatarsBridge;
  profile: AvatarProfile;
  ownBody: boolean;
  run: Run;
}) {
  const controls = useCharacterSettings({ context, avatarsApi: api, profile, ownBody, run });
  return <CharacterSettings name={profile.name} controls={controls} />;
}

/** The edit fields: name and body on one row, then the character's own settings. */
function CardEditor({ api, profile, models, ownBody, settings, run, onPickHostBody }: {
  api: AvatarsBridge;
  profile: AvatarProfile;
  models: SceneCastModel[];
  ownBody: boolean;
  settings?: CharacterSettingsContext;
  run: Run;
  onPickHostBody?: (modelId: string) => Promise<void>;
}) {
  const [name, setName] = useState(profile.name);
  const isEcho = profile.id === ECHO_ID;
  // Echo always wears the active model, so its body is changed by activating another one.
  const pickBody = (modelId: string) => {
    if (isEcho) {
      if (modelId && onPickHostBody && modelId !== profile.vrmModelId) void run(() => onPickHostBody(modelId));
      return;
    }
    void run(() => api.update(profile.id, { vrmModelId: modelId || null }));
  };
  return (
    <div className="sceneCard__edit">
      <label className="sceneCard__field">
        <span>Name</span>
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
          />
      </label>
      {settings ? (
        isEcho ? (
          <CharacterSettings name={profile.name} controls={settings.echo} />
        ) : (
          // Another body means other saved settings, so the editor starts over.
          <OtherSettings key={profile.vrmModelId ?? ''} context={settings} api={api} profile={profile} ownBody={ownBody} run={run} />
        )
      ) : null}
      <div className="sceneCard__field">
        <span>Avatar</span>
        <AvatarPicker
          label={`Avatar of ${profile.name}`}
          models={models}
          selected={profile.vrmModelId ?? null}
          echoLook={!isEcho}
          disabled={isEcho && !onPickHostBody}
          onSelect={(modelId) => pickBody(modelId ?? '')}
        />
      </div>
      {isEcho ? <small className="kiosk__helper">Prompt and voice are saved per avatar, so a new avatar brings its own.</small> : null}
    </div>
  );
}
function CastCard({ api, profile, models, echoModelId, settings, run, onPickHostBody }: {
  api: AvatarsBridge;
  profile: AvatarProfile;
  models: SceneCastModel[];
  echoModelId: string | null;
  settings?: CharacterSettingsContext;
  run: Run;
  onPickHostBody?: (modelId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const isEcho = profile.id === ECHO_ID;
  const body = profile.vrmModelId ? models.find((model) => model.id === profile.vrmModelId) : undefined;
  const ownsBody = Boolean(profile.vrmModelId);
  // A character wearing the very body Echo wears shares it, and so shares nothing saved for that body.
  const ownBody = ownsBody && profile.vrmModelId !== echoModelId;

  return (
    <li className="sceneCard" data-testid={`scene-card-${profile.id}`}>
      <div className="sceneCard__row">
        <Thumbnail url={body?.thumbnailDataUrl} name={profile.name} />
        <div className="sceneCard__info">
          <h4 className="sceneCard__name">
            {profile.name}
            {isEcho ? <span className="sceneCard__badge">Host</span> : null}
          </h4>
          {isEcho || ownsBody ? (
            body ? <p className="sceneCard__meta">{body.name}</p> : null
          ) : (
            <p className="sceneCard__meta">Looks like Echo (its own copy)</p>
          )}
        </div>
        <div className="sceneCard__actions">
          <button
            type="button"
            aria-label={`Edit ${profile.name}`}
            aria-expanded={editing}
            onClick={() => setEditing(!editing)}
          >
            {editing ? 'Done' : 'Edit'}
          </button>
          {isEcho ? null : (
            <button
              type="button"
              className="sceneCard__remove"
              aria-label={`Remove ${profile.name} from the scene`}
              onClick={() => setConfirming(true)}
              disabled={confirming}
            >
              Remove
            </button>
          )}
        </div>
      </div>
      {confirming ? (
        <div className="sceneCard__confirm" role="group" aria-label={`Remove ${profile.name}`}>
          <span>Remove {profile.name} from the scene?</span>
          <button type="button" aria-label={`Confirm removing ${profile.name}`} onClick={() => void run(() => api.remove(profile.id))}>Confirm</button>
          <button type="button" aria-label={`Cancel removing ${profile.name}`} onClick={() => setConfirming(false)}>Cancel</button>
        </div>
      ) : null}
      {editing ? <CardEditor api={api} profile={profile} models={models} ownBody={ownBody} settings={settings} run={run} onPickHostBody={onPickHostBody} /> : null}
    </li>
  );
}

export function SceneCast({ api, profiles, models, roomActive = false, onChanged, settings, onPickHostBody, onDeleteModel }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
  const [newModelId, setNewModelId] = useState<string | null>(null);
  if (!api || typeof api.add !== 'function') return null;

  const run: Run = async (action) => {
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

  const echoModelId = profiles.find((profile) => profile.id === ECHO_ID)?.vrmModelId ?? null;
  const newModel = newModelId ? models.find((model) => model.id === newModelId) : undefined;

  const addCharacter = async () => {
    // A blank name takes the picked avatar's name.
    const name = newName.trim() || newModel?.name.trim() || '';
    if (!name) {
      setError('Give the character a name.');
      return;
    }
    const ok = await run(() =>
      api.add({ name, ...(newModel ? { vrmModelId: newModel.id } : {}), ...(newPrompt.trim() ? { prompt: newPrompt } : {}) }),
    );
    if (ok) {
      setNewName('');
      setNewPrompt('');
      setNewModelId(null);
    }
  };

  return (
    <section className="sceneCast" aria-labelledby="scene-cast-title" data-testid="scene-cast">
      <h2 id="scene-cast-title">In the scene</h2>
      <p className="kiosk__helper">
        Everyone here hears the room and can be spoken to by name. Echo is the host and answers when no one is named.
      </p>
      {roomActive && profiles.length >= 2 ? (
        <p className="kiosk__helper" role="note">In rooms every avatar walks, gestures, keeps clear of the others and wanders when idle.</p>
      ) : null}
      <ul className="sceneCast__list" aria-label="Characters in the scene">
        {profiles.map((profile) => (
          <CastCard api={api} key={profile.id} profile={profile} models={models} echoModelId={echoModelId} settings={settings} run={run} onPickHostBody={onPickHostBody} />
        ))}
      </ul>

      <form
        className="sceneCast__add"
        aria-label="Add a character"
        onSubmit={(event) => {
          event.preventDefault();
          void addCharacter();
        }}
      >
        <h3 className="faces__heading">Add a character</h3>
        <label className="sceneCard__field">
          <span>Name</span>
          <input
            aria-label="New character name"
            placeholder={newModel ? newModel.name : 'Name'}
            value={newName}
            maxLength={NAME_MAX}
            onChange={(event) => setNewName(event.target.value)}
          />
        </label>
        <label className="sceneCard__field">
          <span>Prompt</span>
          <textarea aria-label="New character prompt" placeholder="Prompt (optional)" rows={2} value={newPrompt} maxLength={PROMPT_MAX} onChange={(event) => setNewPrompt(event.target.value)} />
        </label>
        <div className="sceneCard__field">
          <span>Avatar</span>
          <AvatarPicker
            label="Avatar for the new character"
            models={models}
            selected={newModelId}
            echoLook
            onSelect={setNewModelId}
            deletion={
              onDeleteModel
                ? {
                    wornBy: (modelId) => profiles.filter((profile) => profile.id !== ECHO_ID && profile.vrmModelId === modelId).map((profile) => profile.name),
                    locked: (modelId) => (modelId === echoModelId ? 'Echo is wearing this. Give Echo another avatar first.' : null),
                    onDelete: (modelId) => {
                      if (newModelId === modelId) setNewModelId(null);
                      void run(() => onDeleteModel(modelId));
                    },
                  }
                : undefined
            }
          />
        </div>
        <div className="sceneCast__addActions">
          <button type="submit">Add character</button>
        </div>
      </form>
      {error ? <p className="kiosk__error" role="alert">{error}</p> : null}
    </section>
  );
}
