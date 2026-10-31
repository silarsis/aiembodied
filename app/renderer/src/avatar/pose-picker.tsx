import { useControlsVisible } from '../settings/controls-drawer.js';
import { useEffect, useRef, useState } from 'react';
import type { AvatarBridge, AvatarPoseSummary } from './types.js';
import type { AvatarAnimationBus, VRMPoseData } from './animation-bus.js';

/** Temporary previews restore the last applied pose, or resume idle if none was selected. */
export function PosePicker({
  poses,
  avatarApi,
  bus,
  enabled,
  modelId,
}: {
  poses: AvatarPoseSummary[];
  avatarApi?: AvatarBridge;
  bus: AvatarAnimationBus;
  enabled: boolean;
  modelId: string | null;
}) {
  const visible = useControlsVisible() && enabled;
  const neutralId = poses.find((pose) => pose.id === 'builtin:relaxed-neutral')?.id ?? null;
  const [selected, setSelected] = useState<string | null>(neutralId);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(neutralId);
  const previewRef = useRef(false);
  const request = useRef(0);
  const currentModel = useRef(modelId);

  const apply = async (id: string | null) => {
    const ticket = ++request.current;
    if (!id) {
      bus.signalResponse();
      return true;
    }
    try {
      const pose = await avatarApi?.loadPose(id);
      if (ticket !== request.current) return false;
      if (!pose || typeof pose !== 'object') throw new Error('This pose could not be loaded.');
      bus.applyPose(pose as VRMPoseData, 'controls-preview');
      setError(null);
      return true;
    } catch (cause) {
      if (ticket !== request.current) return false;
      setError(cause instanceof Error ? cause.message : 'This pose could not be loaded.');
      return false;
    }
  };

  const restore = () => {
    if (!previewRef.current) return;
    previewRef.current = false;
    setPreview(null);
    void apply(selectedRef.current);
  };

  useEffect(() => {
    if (currentModel.current !== modelId) {
      currentModel.current = modelId;
      ++request.current;
      selectedRef.current = neutralId;
      previewRef.current = false;
      setSelected(neutralId);
      setPreview(null);
      setError(null);
    } else {
      if (!selectedRef.current && neutralId) {
        selectedRef.current = neutralId;
        setSelected(neutralId);
      }
      if (!visible) restore();
    }
    // Restoration reads the latest committed selection through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, modelId, neutralId]);

  useEffect(
    () => () => {
      ++request.current;
    },
    [],
  );

  if (poses.length === 0) return null;
  return (
    <div className="posePicker">
      <p className="posePicker__label">Poses · hover or focus to preview</p>
      <div className="posePicker__chips">
        {poses.map((pose) => (
          <button
            key={pose.id}
            type="button"
            aria-pressed={selected === pose.id}
            disabled={!visible || !modelId}
            onMouseEnter={() => {
              previewRef.current = true;
              setPreview(pose.name);
              void apply(pose.id);
            }}
            onFocus={() => {
              previewRef.current = true;
              setPreview(pose.name);
              void apply(pose.id);
            }}
            onMouseLeave={restore}
            onBlur={restore}
            onClick={() => {
              previewRef.current = false;
              setPreview(null);
              void apply(pose.id).then((applied) => {
                if (applied) {
                  selectedRef.current = pose.id;
                  setSelected(pose.id);
                }
              });
            }}
          >
            {pose.name}
          </button>
        ))}
      </div>
      {preview ? (
        <p className="posePicker__preview" role="status">
          Previewing · {preview}
        </p>
      ) : null}
      {error ? (
        <p className="kiosk__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
