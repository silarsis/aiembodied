import { useState } from 'react';
import type { BackgroundController } from './use-backgrounds.js';

export function BackgroundControls({ backgrounds }: { backgrounds: BackgroundController }) {
  const [prompt, setPrompt] = useState('');
  const [notice, setNotice] = useState('');
  if (!backgrounds.available)
    return <p className="kiosk__helper">Background controls are available in the desktop app.</p>;
  return (
    <div className="backgroundControls">
      {backgrounds.loading ? <p role="status">Loading backgrounds…</p> : null}
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
              onClick={() => void backgrounds.select(item.id)}
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
