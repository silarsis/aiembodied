import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ModelReviewScene } from './model-review-scene.js';

const expressionLabels: Record<string, string> = {
  happy: 'Happiness',
  sad: 'Sadness',
  angry: 'Anger',
  fear: 'Fear',
  disgust: 'Disgust',
  surprised: 'Surprise',
  relaxed: 'Relaxed',
  blink: 'Blink',
  blinkLeft: 'Left blink',
  blinkRight: 'Right blink',
  aa: 'Speech: Ah',
  ih: 'Speech: Ih',
  ou: 'Speech: Oo',
  ee: 'Speech: Ee',
  oh: 'Speech: Oh',
  lookLeft: 'Look left',
  lookRight: 'Look right',
  lookUp: 'Look up',
  lookDown: 'Look down',
};

function ModelDialog({ modelData, onDismiss }: { modelData: ArrayBuffer; onDismiss(): void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const review = useRef<ModelReviewScene | null>(null);
  const [expressions, setExpressions] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const element = dialog.current;
    element?.showModal();
    let cancelled = false;
    void import('./model-review-scene.js')
      .then(({ createModelReviewScene }) => {
        if (cancelled || !host.current) return null;
        return createModelReviewScene(host.current, modelData);
      })
      .then((scene) => {
        if (!scene) return;
        if (cancelled) scene.dispose();
        else {
          review.current = scene;
          setExpressions(scene.expressions);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Could not open the model.');
      });
    return () => {
      cancelled = true;
      review.current?.dispose();
      review.current = null;
      element?.close();
    };
  }, [modelData]);
  const ready = expressions !== null;
  return createPortal(
    <dialog
      ref={dialog}
      className="avatarPreview__dialog avatarModelPreview__dialog"
      aria-label="Inspect finished avatar"
      onClose={onDismiss}
      onCancel={(event) => {
        event.preventDefault();
        onDismiss();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <div className="avatarPreview__header">
        <strong>Inspect finished avatar</strong>
        <button type="button" onClick={onDismiss} aria-label="Close model preview">
          ✕ Close
        </button>
      </div>
      <p className="avatarModelPreview__hint">
        Drag to rotate · Scroll or pinch to zoom · Right-drag or two fingers to pan
      </p>
      {error ? (
        <p role="alert" className="kiosk__error">
          {error} Close and reopen to retry.
        </p>
      ) : null}
      {!ready && !error ? <p role="status">Loading interactive model…</p> : null}
      <div ref={host} className="avatarModelPreview__canvas" />
      <div className="avatarModelPreview__tools" aria-label="Model inspection controls">
        {(['front', 'side', 'back'] as const).map((direction) => (
          <button
            key={direction}
            type="button"
            disabled={!ready}
            onClick={() => review.current?.view(direction)}
          >
            {direction === 'front' ? 'Front / reset' : direction === 'side' ? 'Side' : 'Back'}
          </button>
        ))}
        <label>
          Expression{' '}
          <select
            disabled={!ready}
            defaultValue=""
            onChange={(event) => review.current?.expression(event.target.value)}
          >
            <option value="">Neutral</option>
            {(expressions ?? [])
              .filter((name) => name !== 'neutral')
              .map((name) => (
                <option key={name} value={name}>
                  {expressionLabels[name] ?? name}
                </option>
              ))}
          </select>
        </label>
      </div>
      <p className="avatarModelPreview__hint">
        This is the generated candidate. Close to keep or discard it.
      </p>
    </dialog>,
    document.body,
  );
}

export function AvatarModelPreview({
  thumbnail,
  modelData,
}: {
  thumbnail: string;
  modelData: ArrayBuffer;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <figure className="avatarPreview">
      <button
        type="button"
        className="avatarPreview__thumbnail"
        aria-label="Inspect finished avatar model"
        aria-haspopup="dialog"
        title="Inspect in 3D"
        onClick={() => setExpanded(true)}
      >
        <img src={thumbnail} alt="Finished avatar model" />
      </button>
      <figcaption>Finished model — click to rotate, zoom and check expressions.</figcaption>
      {expanded ? <ModelDialog modelData={modelData} onDismiss={() => setExpanded(false)} /> : null}
    </figure>
  );
}
