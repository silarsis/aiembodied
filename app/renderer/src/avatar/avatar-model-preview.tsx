import { useEffect, useRef, useState } from 'react';
import { createModelReviewScene, type ModelReviewScene } from './model-review-scene.js';
import type { AvatarPoseSummary } from './types.js';

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

/**
 * Interactive review of a generated candidate: orbit, front/side/back, saved poses and the
 * model's own expressions. Uses its own scene, so it never changes the active avatar.
 * Give it a `key` per model so a different candidate starts with fresh controls.
 */
export function AvatarModelViewer({
  modelData,
  poses = [],
  loadPose,
  label = 'Generated avatar',
}: {
  modelData: ArrayBuffer;
  poses?: AvatarPoseSummary[];
  loadPose?: (id: string) => Promise<unknown>;
  label?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const review = useRef<ModelReviewScene | null>(null);
  const [expressions, setExpressions] = useState<string[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pose, setPose] = useState<string | null>(null);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [expression, setExpression] = useState('');
  const poseTicket = useRef(0);
  const poseData = useRef<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    // Bundle the code eagerly: rebuilding dist can remove a lazy chunk expected by an open app.
    // The scene, model and WebGL context are still created only when this viewer mounts.
    const loading = host.current
      ? createModelReviewScene(host.current, modelData)
      : Promise.resolve(null);
    void loading
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
    };
  }, [modelData]);

  const ready = expressions !== null;
  const applyPose = async (id: string) => {
    if (!loadPose) return;
    const ticket = ++poseTicket.current;
    setPose(id);
    setPoseError(null);
    try {
      const data = await loadPose(id);
      if (ticket !== poseTicket.current) return;
      poseData.current = data;
      review.current?.pose(data);
      setExpression('');
    } catch (err) {
      if (ticket === poseTicket.current)
        setPoseError(err instanceof Error ? err.message : 'This pose could not be loaded.');
    }
  };

  return (
    <div className="avatarModelViewer">
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      <div className="avatarModelViewer__stage">
        <div ref={host} className="avatarModelPreview__canvas" aria-label={label} />
        {!ready && !error ? (
          <p role="status" className="avatarModelViewer__loading">
            Loading the 3D avatar…
          </p>
        ) : null}
        <div className="avatarModelViewer__views" aria-label="Camera views">
          {(['front', 'side', 'back'] as const).map((direction) => (
            <button
              key={direction}
              type="button"
              disabled={!ready}
              onClick={() => review.current?.view(direction)}
            >
              {direction === 'front' ? 'Front' : direction === 'side' ? 'Side' : 'Back'}
            </button>
          ))}
        </div>
        <p className="avatarModelViewer__hint">Drag to spin · scroll to zoom · right-drag to pan</p>
      </div>
      <div className="avatarModelViewer__tools" aria-label="Model inspection controls">
        {poses.length && loadPose ? (
          <div className="avatarModelViewer__poses" role="group" aria-label="Poses">
            {poses.map((item) => (
              <button
                key={item.id}
                type="button"
                className="avatarStudio__chip"
                aria-pressed={pose === item.id}
                disabled={!ready}
                onClick={() => void applyPose(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
        ) : null}
        {poseError ? (
          <p role="alert" className="kiosk__error">
            {poseError}
          </p>
        ) : null}
        <label className="avatarStudio__field">
          <span>Expression</span>
          <select
            disabled={!ready}
            value={expression}
            onChange={(event) => {
              setExpression(event.target.value);
              if (!event.target.value && poseData.current) review.current?.pose(poseData.current);
              else review.current?.expression(event.target.value);
            }}
          >
            <option value="">{pose ? 'From pose' : 'Neutral'}</option>
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
    </div>
  );
}
