import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AvatarBridge, AvatarGenerationStatus } from './types.js';
import { generatePoseSnapshot } from './pose-snapshot-generator.js';
import { AvatarImagePreview } from './avatar-image-preview.js';
import { AvatarModelPreview } from './avatar-model-preview.js';
import { readAvatarReference, type AvatarReferenceImage } from './reference-image-upload.js';
import { useImageModels } from './use-image-models.js';
import { useControlsVisible } from '../settings/controls-drawer.js';
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
  const [imageSource, setImageSource] = useState<'text' | 'upload'>('text');
  const [referenceImage, setReferenceImage] = useState<AvatarReferenceImage | null>(null);
  const [mode, setMode] = useState<'new-character' | 'restyle'>('new-character');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<AvatarGenerationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<{
    key: string;
    image?: string;
    modelData?: ArrayBuffer;
    error?: string;
  } | null>(null);
  const [previewAttempt, setPreviewAttempt] = useState(0);

  const available = Boolean(avatarApi?.generateAvatar && avatarApi.getAvatarGenerationStatus);
  const running = status ? ACTIVE_STATES.has(status.status) : false;
  const completed = status?.status === 'completed';
  const previewKey = `${jobId}:${previewAttempt}`;
  const resultPreview = preview?.key === previewKey ? preview.image : undefined;
  const resultModel = preview?.key === previewKey ? preview.modelData : undefined;
  const previewError = preview?.key === previewKey ? preview.error : undefined;
  const usingUpload = mode === 'new-character' && imageSource === 'upload';
  const canRegenerate = Boolean(
    jobId && status?.status === 'awaiting_confirmation' && !usingUpload,
  );
  const models = useImageModels(avatarApi, useControlsVisible() && !usingUpload);
  const modelUnavailable =
    !usingUpload && models.supported && (models.loading || !models.selectedModelId);

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
        if (!cancelled) setPreview({ key: previewKey, image: snapshot.dataUrl, modelData });
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
      if (
        !avatarApi?.generateAvatar ||
        modelUnavailable ||
        (jobId && !canRegenerate) ||
        (usingUpload ? !referenceImage : !prompt.trim())
      ) {
        return;
      }
      setBusy(true);
      setError(null);
      try {
        if (jobId) {
          if (!avatarApi.rejectGeneratedAvatar)
            throw new Error('Restart the app to replace this concept image.');
          await avatarApi.rejectGeneratedAvatar(jobId);
          setJobId(null);
          setStatus(null);
        }
        const job = await avatarApi.generateAvatar({
          prompt: prompt.trim(),
          mode,
          ...(usingUpload && referenceImage ? { referenceImage } : {}),
          ...(!usingUpload && models.selectedModelId
            ? { imageModelId: models.selectedModelId }
            : {}),
        });
        setJobId(job.jobId);
        setStatus({ jobId: job.jobId, status: 'queued', progress: 0, message: 'Queued' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start avatar generation.');
      } finally {
        setBusy(false);
      }
    },
    [
      avatarApi,
      prompt,
      mode,
      usingUpload,
      referenceImage,
      jobId,
      canRegenerate,
      modelUnavailable,
      models.selectedModelId,
    ],
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
      setReferenceImage(null);
      await onAccepted?.(vrmId);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save the generated avatar.');
    } finally {
      setBusy(false);
    }
  }, [avatarApi, jobId, onAccepted]);

  const handleConfirmConcept = useCallback(
    async (acceptWarnings = false) => {
      if (!jobId) return;
      setBusy(true);
      setError(null);
      try {
        if (!avatarApi?.confirmAvatarConcept)
          throw new Error('Restart the app to continue from the concept review.');
        if (acceptWarnings) await avatarApi.confirmAvatarConcept(jobId, { acceptWarnings: true });
        else await avatarApi.confirmAvatarConcept(jobId);
        setStatus(await avatarApi.getAvatarGenerationStatus(jobId));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not continue avatar generation.');
      } finally {
        setBusy(false);
      }
    },
    [avatarApi, jobId],
  );

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

  const handleReferenceUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setReferenceImage(null);
    setError(null);
    if (!file) return;
    setBusy(true);
    try {
      setReferenceImage(await readAvatarReference(file));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the image.');
    } finally {
      setBusy(false);
    }
  };

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
          ? 'Experimental: generate a new stylised 3D humanoid, then fit an animated face and body rig locally. Images are guided toward the tested humanoid proportions. Detected compatibility warnings are reviewed before 3D work, with an option to continue anyway. Use a clear front-facing humanoid face, short or swept-back hair. Clothing is optional; keep limbs clearly separated. Loose garments, long hair, articulated fingers and hair physics are not supported yet. Review the finished face carefully.'
          : 'Repaint the bundled avatar’s hair and clothing textures. Face shape, hairstyle, body and outfit shape stay the same.'}{' '}
        Generation can take several minutes; you can keep using the app while it runs. We’ll pause
        after the concept image so you can approve it before continuing.
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
        {mode === 'new-character' ? (
          <fieldset className="avatarImageSource" disabled={busy || Boolean(jobId)}>
            <legend>Start from</legend>
            <label>
              <input
                type="radio"
                name="avatar-image-source"
                value="text"
                checked={imageSource === 'text'}
                onChange={() => setImageSource('text')}
              />{' '}
              Text description
            </label>
            <label>
              <input
                type="radio"
                name="avatar-image-source"
                value="upload"
                checked={imageSource === 'upload'}
                onChange={() => setImageSource('upload')}
              />{' '}
              Upload an image
            </label>
          </fieldset>
        ) : null}
        {usingUpload ? (
          <>
            <label className="faces__field">
              <span>Character reference image</span>
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                disabled={busy || Boolean(jobId)}
                onChange={(event) => void handleReferenceUpload(event)}
              />
            </label>
            <p className="kiosk__info">
              Use a front-facing, full-body character with arms and legs separated. PNG, JPEG or
              WebP, up to 4096 × 4096 pixels and 25 MB. Uploads skip image generation; the current
              3D pipeline fits the visible face for animation locally. Use one front-facing
              character on a plain white background, with open eyes and closed lips.
            </p>
            {referenceImage && !jobId ? (
              <AvatarImagePreview
                src={`data:image/png;base64,${referenceImage.data}`}
                alt="Uploaded reference"
                caption="Your reference image. Click to enlarge."
              />
            ) : null}
          </>
        ) : null}
        {!usingUpload && models.supported ? (
          <div className="faces__field avatarImageModel">
            <label htmlFor="avatar-image-model">Image model</label>
            <select
              id="avatar-image-model"
              value={models.selectedModelId ?? ''}
              disabled={busy || models.loading || Boolean(jobId && !canRegenerate)}
              onChange={(event) => void models.select(event.target.value)}
            >
              {!models.selectedModelId ? (
                <option value="">
                  {models.loading ? 'Finding installed models…' : 'No available image models'}
                </option>
              ) : null}
              {models.models.map((model) => (
                <option key={model.id} value={model.id} disabled={!model.available}>
                  {model.name}
                  {model.available ? '' : ' (unavailable)'}
                </option>
              ))}
            </select>
            <button
              type="button"
              disabled={busy || models.loading || Boolean(jobId && !canRegenerate)}
              onClick={() => void models.refresh()}
            >
              Refresh models
            </button>
            {models.error ? (
              <p className="kiosk__error" role="alert">
                {models.error}
              </p>
            ) : null}
            {!models.loading && !models.error && !models.selectedModelId ? (
              <p className="kiosk__info">
                No supported image models are ready. Install the required models in ComfyUI and
                refresh, or upload an image.
              </p>
            ) : null}
          </div>
        ) : null}
        <label className="faces__field">
          <span>{usingUpload ? 'Avatar name (optional)' : 'Avatar description'}</span>
          <textarea
            value={prompt}
            onChange={handlePromptChange}
            rows={3}
            maxLength={1000}
            placeholder={
              usingUpload
                ? 'Name this avatar'
                : 'Swept-back auburn hair, rounded face, sage green explorer jumpsuit, tan boots'
            }
            disabled={busy || Boolean(jobId && !canRegenerate)}
          />
        </label>
        <button
          type="submit"
          className="faces__submit"
          disabled={
            busy ||
            modelUnavailable ||
            Boolean(jobId && !canRegenerate) ||
            (usingUpload ? !referenceImage : !prompt.trim())
          }
        >
          {usingUpload ? 'Review uploaded image' : canRegenerate ? 'Regenerate image' : 'Generate'}
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
            <AvatarImagePreview
              src={status.previewDataUrl}
              alt={usingUpload ? 'Uploaded reference' : 'Generated concept'}
              caption={
                usingUpload
                  ? 'Your reference image — the finished model may differ. Click to enlarge.'
                  : 'Concept illustration — the finished model may differ. Click to enlarge.'
              }
            />
          ) : null}
          {running ? (
            <>
              <p>{status.message ?? 'Working…'}</p>
              <progress max={100} value={percent} aria-label="Avatar generation progress">
                {percent}%
              </progress>
            </>
          ) : null}
          {status.status === 'awaiting_confirmation' ? (
            <>
              <p>Review the image. Generation is paused until you confirm.</p>
              {status.warnings?.length ? (
                <section
                  className="avatarCompatibilityWarning"
                  role="alert"
                  aria-label="Avatar compatibility warnings"
                >
                  <strong>This image is outside the tested animation template.</strong>
                  <ul>
                    {status.warnings.map((warning) => (
                      <li key={warning.code}>{warning.message}</li>
                    ))}
                  </ul>
                  <p>
                    You can edit the prompt and regenerate, upload another image, or continue
                    anyway. Joint placement and animation may be distorted, and creation can still
                    fail. You will review the finished avatar before keeping it.
                  </p>
                </section>
              ) : null}
              <button
                type="button"
                className="faces__submit"
                onClick={() => void handleConfirmConcept(Boolean(status.warnings?.length))}
                disabled={busy}
              >
                {status.warnings?.length
                  ? 'Accept warnings — continue anyway'
                  : mode === 'new-character'
                    ? 'Use this image — create 3D avatar'
                    : 'Use this image — continue recolouring'}
              </button>
            </>
          ) : null}
          {completed ? (
            <>
              {resultPreview && resultModel ? (
                <AvatarModelPreview thumbnail={resultPreview} modelData={resultModel} />
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
