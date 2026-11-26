import { useEffect, useRef, useState } from 'react';
import { createFurnitureScene, type FurnitureScene } from './furniture-scene.js';

/** One piece in 3D, in metres, next to a 1.7 m person. Give it a `key` per model so a new one starts with a fresh view and loading state. */
export function FurnitureViewer({ modelData, label }: { modelData: ArrayBuffer; label: string }) {
  const host = useRef<HTMLDivElement>(null);
  const scene = useRef<FurnitureScene | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const loading = host.current
      ? createFurnitureScene(host.current, modelData)
      : Promise.resolve(null);
    void loading
      .then((created) => {
        if (!created) return;
        if (cancelled) created.dispose();
        else {
          scene.current = created;
          setReady(true);
        }
      })
      .catch((reason: unknown) => {
        if (!cancelled)
          setError(reason instanceof Error ? reason.message : 'Could not open the model.');
      });
    return () => {
      cancelled = true;
      scene.current?.dispose();
      scene.current = null;
    };
  }, [modelData]);

  return (
    <div className="avatarModelViewer__stage furnitureViewer">
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      <div ref={host} className="avatarModelPreview__canvas" aria-label={label} />
      {!ready && !error ? (
        <p role="status" className="avatarModelViewer__loading">
          Loading the 3D model…
        </p>
      ) : null}
      <div className="avatarModelViewer__views">
        <button type="button" disabled={!ready} onClick={() => scene.current?.reset()}>
          Reset view
        </button>
      </div>
      <p className="avatarModelViewer__hint">
        Drag to spin · scroll to zoom · right-drag to pan · squares are 0.5 m
      </p>
    </div>
  );
}
