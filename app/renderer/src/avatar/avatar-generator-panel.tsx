import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AvatarBridge, AvatarGenerationStatus } from './types.js';
import { generatePoseSnapshot } from './pose-snapshot-generator.js';
import baseNeutralPose from '../../../main/src/avatar/base-poses/relaxed-neutral.pose.json';

interface AvatarGeneratorPanelProps {
  avatarApi?: AvatarBridge;
  /** Called after a generated avatar is saved and made active. */
  onAccepted?: (vrmId: string) => void | Promise<void>;
  pollIntervalMs?: number;
}

const ACTIVE_STATES: ReadonlySet<AvatarGenerationStatus['status']> = new Set([
  'queued',
  'concept',
  'meshing',
  'rigging',
  'texturing',
  'packaging',
]);

/**
 * Describe a character, have the local ComfyUI pipeline repaint the base VRM to match, then
 * keep or discard the result.
 */
export function AvatarGeneratorPanel({
  avatarApi,
  onAccepted,
  pollIntervalMs = 2000,
}: AvatarGeneratorPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [mode, setMode] = useState<'new-character' | 'restyle'>('new-character');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<AvatarGenerationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{ key: string; image?: string; error?: string } | null>(
    null,
  );
  const [previewAttempt, setPreviewAttempt] = useState(0);

  const available = Boolean(avatarApi?.generateAvatar && avatarApi.getAvatarGenerationStatus);
  const running = status ? ACTIVE_STATES.has(status.status) : false;
  const completed = status?.status === 'completed';
  const previewKey = `${jobId}:${previewAttempt}`;
  const resultPreview = preview?.key === previewKey ? preview.image : undefined;
  const previewError = preview?.key === previewKey ? preview.error : undefined;

  useEffect(() => {
    if (!completed || !jobId) return;
    let cancelled = false;
    const renderResult = async () => {
      try {
        if (!avatarApi?.loadGeneratedAvatarPreview)
          throw new Error('Restart the app to enable the finished model preview.');
        const modelData = await avatarApi.loadGeneratedAvatarPreview(jobId);
        if (cancelled) return;
        const snapshot = await generatePoseSnapshot({ modelData, poseData: baseNeutralPose });
        if (!cancelled) setPreview({ key: previewKey, image: snapshot.dataUrl });
      } catch (err) {
        if (!cancelled)
          setPreview({
            key: previewKey,
            error: err instanceof Error ? err.message : 'Could not render the finished model.',
          });
      }
    };
    void renderResult();
    return () => {
      cancelled = true;
    };
  }, [avatarApi, completed, jobId, previewKey]);

  useEffect(() => {
    if (
      !jobId ||
      !avatarApi?.getAvatarGenerationStatus ||
      (status && !ACTIVE_STATES.has(status.status))
    ) {
      return undefined;
    }
    let cancelled = false;
    const timer = setInterval(() => {
      avatarApi
        .getAvatarGenerationStatus(jobId)
        .then((next) => {
          if (!cancelled) {
            setStatus(next);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(
              err instanceof Error ? err.message : 'Lost track of the avatar generation job.',
            );
            setJobId(null);
            setStatus(null);
          }
        });
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [avatarApi, jobId, pollIntervalMs, status]);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (!avatarApi?.generateAvatar || !prompt.trim()) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const job = await avatarApi.generateAvatar({ prompt: prompt.trim(), mode });
        setJobId(job.jobId);
        setStatus({ jobId: job.jobId, status: 'queued', progress: 0, message: 'Queued' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start avatar generation.');
      } finally {
        setBusy(false);
      }
    },
    [avatarApi, prompt, mode],
  );

  const handleAccept = useCallback(async () => {
    if (!avatarApi?.acceptGeneratedAvatar || !jobId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { vrmId } = await avatarApi.acceptGeneratedAvatar(jobId);
      setJobId(null);
      setStatus(null);
      setPrompt('');
      await onAccepted?.(vrmId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the generated avatar.');
    } finally {
      setBusy(false);
    }
  }, [avatarApi, jobId, onAccepted]);

  const handleDiscard = useCallback(async () => {
    if (!avatarApi?.rejectGeneratedAvatar || !jobId) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await avatarApi.rejectGeneratedAvatar(jobId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to discard the generated avatar.');
    } finally {
      setJobId(null);
      setStatus(null);
      setBusy(false);
    }
  }, [avatarApi, jobId]);

  const handlePromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setPrompt(event.target.value);
  }, []);

  if (!available) {
    return null;
  }

  const percent = Math.round((status?.progress ?? 0) * 100);

  return (
    <div className="faces__section" aria-labelledby="avatar-generator-heading">
      <h3 className="faces__heading" id="avatar-generator-heading">
        Create an avatar
      </h3>
      <p className="kiosk__info">
        {mode === 'new-character'
          ? 'Experimental: generate a new stylised 3D humanoid, then add a body rig and animated eyes and mouth. Use adult proportions, short or swept-back hair and close-fitting clothes. Loose garments, long hair, articulated fingers and hair physics are not supported yet. The facial features use a simple cartoon style.'
          : 'Repaint the bundled avatar’s hair and clothing textures. Face shape, hairstyle, body and outfit shape stay the same.'}{' '}
        Generation can take several minutes; you can keep using the app while it runs.
      </p>

      <form className="faces__form" onSubmit={handleSubmit} aria-label="Generate avatar">
        <label className="faces__field">
          <span>Creation method</span>
          <select
            value={mode}
            disabled={busy || Boolean(jobId)}
            onChange={(event) => setMode(event.target.value as 'new-character' | 'restyle')}
          >
            <option value="new-character">New 3D character (experimental)</option>
            <option value="restyle">Recolour the base avatar</option>
          </select>
        </label>
        <label className="faces__field">
          <span>Avatar description</span>
          <textarea
            value={prompt}
            onChange={handlePromptChange}
            rows={3}
            maxLength={1000}
            placeholder="Swept-back auburn hair, rounded face, sage green explorer jumpsuit, tan boots"
            disabled={busy || Boolean(jobId)}
          />
        </label>
        <button
          type="submit"
          className="faces__submit"
          disabled={busy || Boolean(jobId) || !prompt.trim()}
        >
          Generate
        </button>
      </form>

      {error ? (
        <p className="kiosk__error" role="alert">
          {error}
        </p>
      ) : null}

      {status ? (
        <div className="faces__uploadResult" role="status">
          {status.previewDataUrl ? (
            <figure>
              <img
                src={status.previewDataUrl}
                alt="Generated concept"
                className="faces__uploadThumbnail"
              />
              <figcaption>Concept illustration — the finished model may differ.</figcaption>
            </figure>
          ) : null}
          {running ? (
            <>
              <p>{status.message ?? 'Working…'}</p>
              <progress max={100} value={percent} aria-label="Avatar generation progress">
                {percent}%
              </progress>
            </>
          ) : null}
          {completed ? (
            <>
              {resultPreview ? (
                <figure>
                  <img
                    src={resultPreview}
                    alt="Finished avatar model"
                    className="faces__resultPreview"
                  />
                  <figcaption>Finished model — this is the avatar that Keep applies.</figcaption>
                </figure>
              ) : previewError ? (
                <>
                  <p className="kiosk__error" role="alert">
                    {previewError}
                  </p>
                  <button type="button" onClick={() => setPreviewAttempt((attempt) => attempt + 1)}>
                    Retry preview
                  </button>
                </>
              ) : (
                <p>Rendering the finished model for review…</p>
              )}
              <p>Review the finished model before making it the active avatar.</p>
            </>
          ) : null}
          {status.status === 'failed' ? (
            <p className="kiosk__error">
              Generation failed: {status.errorMessage ?? 'unknown error'}
            </p>
          ) : null}
          <div className="faceCard__actions">
            {status.status === 'completed' ? (
              <button
                type="button"
                onClick={() => void handleAccept()}
                disabled={busy || !resultPreview}
              >
                Keep avatar
              </button>
            ) : null}
            <button type="button" onClick={() => void handleDiscard()} disabled={busy}>
              {running ? 'Cancel' : 'Discard'}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
