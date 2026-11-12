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
function CardEditor({ api, profile, models, ownBody, settings, run }: {
  api: AvatarsBridge;
  profile: AvatarProfile;
  models: SceneCastModel[];
  ownBody: boolean;
  settings?: CharacterSettingsContext;
  run: Run;
}) {
  const [name, setName] = useState(profile.name);
  const isEcho = profile.id === ECHO_ID;
  return (
    <div className="sceneCard__edit">
      <div className="sceneCard__pair">
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
        <label className="sceneCard__field">
          <span>Body</span>
          <select
            aria-label={`Body of ${profile.name}`}
            value={profile.vrmModelId ?? ''}
            disabled={isEcho}
            onChange={(event) => void run(() => api.update(profile.id, { vrmModelId: event.target.value || null }))}
          >
            <option value="">{isEcho ? 'Active character' : "Same look as Echo"}</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>{model.name}</option>
            ))}
          </select>
        </label>
      </div>
      {isEcho ? <small className="kiosk__helper">Echo wears the active character picked below.</small> : null}
      {settings ? (
        isEcho ? (
          <CharacterSettings name={profile.name} controls={settings.echo} />
        ) : (
          // Another body means other saved settings, so the editor starts over.
          <OtherSettings key={profile.vrmModelId ?? ''} context={settings} api={api} profile={profile} ownBody={ownBody} run={run} />
        )
      ) : null}
    </div>
  );
}

function CastCard({ api, profile, models, echoModelId, settings, run }: {
  api: AvatarsBridge;
  profile: AvatarProfile;
  models: SceneCastModel[];
  echoModelId: string | null;
  settings?: CharacterSettingsContext;
  run: Run;
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
      {editing ? <CardEditor api={api} profile={profile} models={models} ownBody={ownBody} settings={settings} run={run} /> : null}
    </li>
  );
}

export function SceneCast({ api, profiles, models, roomActive = false, onChanged, settings }: Props) {
  const [error, setError] = useState<string | null>(null);
  const [newName, setNewName] = useState('');
  const [newPrompt, setNewPrompt] = useState('');
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
  const worn = new Set(profiles.map((profile) => profile.vrmModelId).filter((id): id is string => Boolean(id)));
  const available = models.filter((model) => !worn.has(model.id));

  const addByName = async () => {
    const name = newName.trim();
    if (!name) {
      setError('Give the character a name.');
      return;
    }
    const ok = await run(() => api.add({ name, ...(newPrompt.trim() ? { prompt: newPrompt } : {}) }));
    if (ok) {
      setNewName('');
      setNewPrompt('');
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
          <CastCard api={api} key={profile.id} profile={profile} models={models} echoModelId={echoModelId} settings={settings} run={run} />
        ))}
      </ul>

      <h3 className="faces__heading">Add a character</h3>
      {available.length > 0 ? (
        <ul className="sceneCast__tiles" aria-label="Characters you can add">
          {available.map((model) => (
            <li key={model.id} className="faceCard faceCard--compact">
              <div className="faceCard__preview" aria-hidden="true">
                {model.thumbnailDataUrl ? <img src={model.thumbnailDataUrl} alt="" loading="lazy" /> : <div className="faceCard__placeholder">No thumbnail</div>}
              </div>
              <div className="faceCard__info"><h4>{model.name}</h4></div>
              <div className="faceCard__actions">
                <button type="button" aria-label={`Add ${model.name} to scene`} onClick={() => void run(() => api.add({ name: model.name, vrmModelId: model.id }))}>
                  Add to scene
                </button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="kiosk__helper">Every character in your library is already in the scene.</p>
      )}

      <form
        className="sceneCast__byName"
        aria-label="Add by name"
        onSubmit={(event) => {
          event.preventDefault();
          void addByName();
        }}
      >
        <h3 className="faces__heading">Add by name</h3>
        <p className="kiosk__helper">A new character who looks like Echo, as its own figure on stage. Give it its own voice and habits with Edit.</p>
        <div className="sceneCast__byNameRow">
          <input aria-label="New character name" placeholder="Name" value={newName} maxLength={NAME_MAX} onChange={(event) => setNewName(event.target.value)} />
          <button type="submit">Add character</button>
        </div>
        <textarea aria-label="New character prompt" placeholder="Prompt (optional)" rows={2} value={newPrompt} maxLength={PROMPT_MAX} onChange={(event) => setNewPrompt(event.target.value)} />
      </form>
      {error ? <p className="kiosk__error" role="alert">{error}</p> : null}
    </section>
  );
}
