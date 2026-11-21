import { useEffect, useState } from 'react';
import type { FurnitureBridge, FurnitureItem } from '../preload-api.js';
import { FurnitureViewer } from './furniture-viewer.js';
import { useFurniture, type FurnitureController } from './use-furniture.js';

const MAX_PROMPT = 1000;

/** "0.85 × 0.85 × 0.95 m", as width × depth × height. */
export function formatSize([width, height, depth]: FurnitureItem['dimensions']): string {
  return `${width.toFixed(2)} × ${depth.toFixed(2)} × ${height.toFixed(2)} m`;
}

function FurnitureGenerator({ controller, onCreated }: { controller: FurnitureController; onCreated: (item: FurnitureItem) => void }) {
  const [prompt, setPrompt] = useState('');
  return (
    <form
      className="faces__form"
      aria-label="Generate furniture"
      onSubmit={(event) => {
        event.preventDefault();
        void controller.generate(prompt.trim()).then((item) => {
          if (!item) return;
          setPrompt('');
          onCreated(item);
        });
      }}
    >
      <label className="faces__field">
        <span>Furniture description</span>
        <textarea
          rows={3}
          maxLength={MAX_PROMPT}
          value={prompt}
          placeholder="A worn brown leather armchair with wooden legs…"
          onChange={(event) => setPrompt(event.target.value)}
        />
      </label>
      <button type="submit" className="faces__submit" disabled={!prompt.trim()}>
        Generate furniture
      </button>
    </form>
  );
}

/** The 3D view of the selected piece, with edit (the prompt, run again) and delete. */
function FurnitureDetail({ item, controller, onDeleted }: { item: FurnitureItem; controller: FurnitureController; onDeleted: () => void }) {
  const [draft, setDraft] = useState(item.prompt);
  const [confirming, setConfirming] = useState(false);
  const [loaded, setLoaded] = useState<{ id: string; at: string; data: ArrayBuffer | null; error: string | null } | null>(null);
  const model = loaded?.id === item.id ? loaded : null;
  const busy = item.status === 'generating';

  // The model changes when a run finishes (updatedAt moves); the old one stays in view while a run works.
  useEffect(() => {
    if (!item.hasModel || busy) return;
    let cancelled = false;
    controller
      .model(item.id)
      .then((data) => {
        if (!cancelled) setLoaded({ id: item.id, at: item.updatedAt, data, error: null });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoaded({ id: item.id, at: item.updatedAt, data: null, error: reason instanceof Error ? reason.message : 'Could not load the model.' });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the controller is rebuilt on every render; the model is a function of the piece
  }, [item.id, item.updatedAt, item.hasModel, busy]);

  return (
    <section className="furnitureDetail" aria-label={`${item.name} in 3D`}>
      <h3>{item.name}</h3>
      {item.hasModel && model?.data ? (
        <FurnitureViewer key={`${item.id}-${model.at}`} modelData={model.data} label={`${item.name} in 3D`} />
      ) : (
        <p className="kiosk__helper" role="status">
          {busy ? (item.message ?? 'Working…') : (model?.error ?? 'There is no 3D model for this piece yet.')}
        </p>
      )}
      {item.hasModel ? <p className="kiosk__helper">Size: {formatSize(item.dimensions)} (width × depth × height)</p> : null}
      {busy && item.hasModel ? <p role="status">{item.message ?? 'Working…'}</p> : null}
      {item.error ? (
        <p role="alert" className="kiosk__error">
          {item.error}
        </p>
      ) : null}
      <form
        className="faces__form"
        aria-label="Edit furniture"
        onSubmit={(event) => {
          event.preventDefault();
          void controller.edit(item.id, draft.trim());
        }}
      >
        <label className="faces__field">
          <span>Description</span>
          <textarea rows={3} maxLength={MAX_PROMPT} value={draft} onChange={(event) => setDraft(event.target.value)} disabled={busy} />
        </label>
        <button type="submit" className="faces__submit" disabled={busy || !draft.trim()}>
          {busy ? 'Working…' : 'Regenerate'}
        </button>
      </form>
      {confirming ? (
        <p className="furnitureDetail__confirm" role="group" aria-label={`Delete ${item.name}?`}>
          <span>Delete {item.name}?</span>
          <button
            type="button"
            className="backgroundCard__delete"
            onClick={() => {
              void controller.remove(item.id).then(onDeleted);
            }}
          >
            Yes
          </button>
          <button type="button" onClick={() => setConfirming(false)}>
            No
          </button>
        </p>
      ) : (
        <button type="button" className="backgroundCard__delete" onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
    </section>
  );
}

export function FurnitureControls({ bridge }: { bridge: FurnitureBridge | undefined }) {
  const controller = useFurniture(bridge);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  if (!controller.available) return <p className="kiosk__helper">Furniture is available in the desktop app.</p>;
  const selected = controller.items.find((item) => item.id === selectedId) ?? null;
  return (
    <div className="furnitureControls">
      <FurnitureGenerator controller={controller} onCreated={(item) => setSelectedId(item.id)} />
      <p className="kiosk__helper">
        Describe one piece. It is drawn, turned into a 3D model and scaled to the size such a piece really is. This takes
        minutes, one piece at a time; you can keep using the app.
      </p>
      {controller.error ? (
        <p role="alert" className="kiosk__error">
          {controller.error}
        </p>
      ) : null}
      {controller.loading ? <p role="status">Loading furniture…</p> : null}
      <div className="backgroundControls__grid" aria-label="Furniture pieces">
        {controller.items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="backgroundCard"
            aria-pressed={item.id === selectedId}
            onClick={() => setSelectedId(item.id)}
          >
            {item.thumbnailDataUrl ? <img src={item.thumbnailDataUrl} alt="" /> : <span className="backgroundCard__plain" />}
            <span>{item.name}</span>
            <span className="kiosk__helper">
              {item.status === 'generating'
                ? (item.message ?? 'Working…')
                : item.status === 'failed'
                  ? `Failed: ${item.error ?? 'unknown error'}`
                  : formatSize(item.dimensions)}
            </span>
          </button>
        ))}
      </div>
      {controller.items.length === 0 && !controller.loading ? <p className="kiosk__helper">No furniture yet.</p> : null}
      {selected ? <FurnitureDetail key={selected.id} item={selected} controller={controller} onDeleted={() => setSelectedId(null)} /> : null}
    </div>
  );
}
