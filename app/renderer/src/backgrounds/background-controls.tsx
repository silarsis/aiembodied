import { useState } from 'react';
import type { BackgroundController } from './use-backgrounds.js';
import type { OnTalk, Restlessness } from '../../../main/src/rooms/idle-settings.js';
import { RoomCards } from './room-cards.js';
import { RoomDescribeForm } from './room-describe-form.js';
import { GeneratedObjects, MakeMissingObjects } from './room-objects.js';

export interface WalkableAreaToggle {
  shown: boolean;
  onChange: (shown: boolean) => void;
}

export function BackgroundControls({
  backgrounds,
  walkableArea,
}: {
  backgrounds: BackgroundController;
  /** Developer toggle for the navmesh overlay; only passed when the metrics HUD flag is on. */
  walkableArea?: WalkableAreaToggle;
}) {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('');
  const [roomPrompt, setRoomPrompt] = useState('');
  const [chosenTab, setChosenTab] = useState<'2d' | '3d' | null>(null);
  if (!backgrounds.available)
    return <p className="kiosk__helper">Background controls are available in the desktop app.</p>;
  const tab = chosenTab ?? backgrounds.activeKind;
  return (
    <div className="backgroundControls">
      <div className="backgroundControls__tabs" role="group" aria-label="Background type">
        {(['2d', '3d'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            className="backgroundControls__tab"
            aria-pressed={tab === kind}
            onClick={() => setChosenTab(kind)}
          >
            {kind === '2d' ? '2D pictures' : '3D rooms'}
          </button>
        ))}
      </div>
      {backgrounds.loading ? <p role="status">Loading backgrounds…</p> : null}
      {tab === '3d' ? (
        <>
          <RoomCards backgrounds={backgrounds} onPickDescription={setRoomPrompt} />
          <RoomDescribeForm backgrounds={backgrounds} prompt={roomPrompt} onPromptChange={setRoomPrompt} />
          <MakeMissingObjects backgrounds={backgrounds} />
          <GeneratedObjects backgrounds={backgrounds} />
          <WhenIdle backgrounds={backgrounds} />
          {walkableArea ? (
            <label className="kiosk__helper">
              <input
                type="checkbox"
                checked={walkableArea.shown}
                onChange={(event) => walkableArea.onChange(event.target.checked)}
              />{' '}
              Show walkable area
            </label>
          ) : null}
        </>
      ) : null}
      {tab === '2d' ? <>
      <div className="backgroundControls__grid" aria-label="Background choices">
        <button
          type="button"
          className="backgroundCard"
          aria-pressed={backgrounds.activeId === null}
          onClick={() => void backgrounds.select(null)}
        >
          <span className="backgroundCard__plain" />
          <span>Plain background</span>
        </button>
        {backgrounds.items.map((item) => (
          <div className="backgroundCard__entry" key={item.id}>
            <button
              type="button"
              className="backgroundCard"
              aria-pressed={item.id === backgrounds.activeId}
              onClick={() => {
                if (item.description && !backgrounds.generating) {
                  setPrompt(item.description);
                  setNotice('');
                }
                void backgrounds.select(item.id);
              }}
            >
              <img src={item.thumbnailDataUrl} alt="" />
              <span>{item.name}</span>
            </button>
            {!item.builtIn ? (
              <button
                type="button"
                className="backgroundCard__delete"
                aria-label={`Delete ${item.name}`}
                onClick={() => void backgrounds.remove(item.id)}
              >
                Delete
              </button>
            ) : null}
          </div>
        ))}
      </div>
      <form
        className="faces__form"
        aria-label="Generate background"
        onSubmit={(event) => {
          event.preventDefault();
          setNotice('');
          void backgrounds.generate(prompt.trim()).then((created) => {
            if (created) {
              setPrompt('');
              setNotice('Background ready. Select it above to use it.');
            }
          });
        }}
      >
        <label className="faces__field">
          <span>Background description</span>
          <textarea
            rows={3}
            maxLength={1000}
            value={prompt}
            placeholder="A peaceful Japanese garden with an open stone path…"
            onChange={(event) => setPrompt(event.target.value)}
            disabled={backgrounds.generating}
          />
        </label>
        <button
          type="submit"
          className="faces__submit"
          disabled={backgrounds.generating || !prompt.trim()}
        >
          {backgrounds.generating ? 'Creating background…' : 'Generate background'}
        </button>
      </form>
      <p className="kiosk__helper">
        Describe a place. A new background is added to your library when it is ready; your current
        scene stays selected. Generation can take several minutes.
      </p>
      {backgrounds.generating ? (
        <p role="status">
          Creating your background. You can keep talking and use the other controls.
        </p>
      ) : null}
      </> : null}
      {notice ? (
        <p role="status" className="kiosk__info">
          {notice}
        </p>
      ) : null}
      {backgrounds.error ? (
        <p role="alert" className="kiosk__error">
          {backgrounds.error}
        </p>
      ) : null}
    </div>
  );
}

const RESTLESSNESS: Array<{ value: Restlessness; label: string }> = [
  { value: 'calm', label: 'Calm' },
  { value: 'normal', label: 'Normal' },
  { value: 'restless', label: 'Restless' },
];
const ON_TALK: Array<{ value: OnTalk; label: string }> = [
  { value: 'turn', label: 'Turn to me where it is' },
  { value: 'come-back', label: 'Come back to me' },
];

/** What the avatar does on its own in a room when nobody is talking. */
function WhenIdle({ backgrounds }: { backgrounds: BackgroundController }) {
  const { idleSettings: settings, setIdleSettings } = backgrounds;
  return (
    <section className="backgroundControls__idle" aria-labelledby="when-idle-title">
      <h3 id="when-idle-title">When idle</h3>
      <label className="kiosk__helper">
        <input
          type="checkbox"
          checked={settings.enabled}
          onChange={(event) => void setIdleSettings({ enabled: event.target.checked })}
        />{' '}
        Wander when nobody is talking
      </label>
      <div className="control">
        <label htmlFor="idle-restlessness">Restlessness</label>
        <select
          id="idle-restlessness"
          value={settings.restlessness}
          disabled={!settings.enabled}
          onChange={(event) => void setIdleSettings({ restlessness: event.target.value as Restlessness })}
        >
          {RESTLESSNESS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <div className="control">
        <label htmlFor="idle-on-talk">When I start talking</label>
        <select
          id="idle-on-talk"
          value={settings.onTalk}
          disabled={!settings.enabled}
          onChange={(event) => void setIdleSettings({ onTalk: event.target.value as OnTalk })}
        >
          {ON_TALK.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </div>
      <p className="kiosk__helper">
        After a quiet minute or so the avatar walks to things it can see, sits, browses or picks something up. Talking always
        wins. Needs the motion service.
      </p>
    </section>
  );
}
