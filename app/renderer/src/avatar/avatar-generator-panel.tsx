import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import type { AvatarBridge, AvatarGenerationStatus } from './types.js';

interface AvatarGeneratorPanelProps {
  avatarApi?: AvatarBridge;
  /** Called after a generated avatar is saved and made active. */
  onAccepted?: (vrmId: string) => void | Promise<void>;
  pollIntervalMs?: number;
}

const ACTIVE_STATES: ReadonlySet<AvatarGenerationStatus['status']> = new Set([
  'queued',
  'concept',
  'texturing',
  'packaging',
]);

/**
 * Describe a character, have the local ComfyUI pipeline repaint the base VRM to match, then
 * keep or discard the result.
 */
export function AvatarGeneratorPanel({ avatarApi, onAccepted, pollIntervalMs = 2000 }: AvatarGeneratorPanelProps) {
  const [prompt, setPrompt] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [status, setStatus] = useState<AvatarGenerationStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const available = Boolean(avatarApi?.generateAvatar && avatarApi.getAvatarGenerationStatus);
  const running = status ? ACTIVE_STATES.has(status.status) : false;

  useEffect(() => {
    if (!jobId || !avatarApi?.getAvatarGenerationStatus || (status && !ACTIVE_STATES.has(status.status))) {
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
            setError(err instanceof Error ? err.message : 'Lost track of the avatar generation job.');
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
        const job = await avatarApi.generateAvatar({ prompt: prompt.trim() });
        setJobId(job.jobId);
        setStatus({ jobId: job.jobId, status: 'queued', progress: 0, message: 'Queued' });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start avatar generation.');
      } finally {
        setBusy(false);
      }
    },
    [avatarApi, prompt],
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
        Generate an avatar
      </h3>
      <p className="kiosk__info">
        Describe a look and your local ComfyUI repaints the default avatar to match. It keeps the rig, expressions
        and lip-sync. It takes about 15 minutes.
      </p>

      <form className="faces__form" onSubmit={handleSubmit} aria-label="Generate avatar">
        <label className="faces__field">
          <span>Description</span>
          <textarea
            value={prompt}
            onChange={handlePromptChange}
            rows={3}
            maxLength={1000}
            placeholder="Teal hair, white hoodie with teal trim, friendly smile"
            disabled={busy || Boolean(jobId)}
          />
        </label>
        <button type="submit" className="faces__submit" disabled={busy || Boolean(jobId) || !prompt.trim()}>
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
            <img src={status.previewDataUrl} alt="Generated concept" className="faces__uploadThumbnail" />
          ) : null}
          {running ? (
            <>
              <p>{status.message ?? 'Working…'}</p>
              <progress max={100} value={percent} aria-label="Avatar generation progress">
                {percent}%
              </progress>
            </>
          ) : null}
          {status.status === 'completed' ? <p>Your avatar is ready. Keep it to make it the active model.</p> : null}
          {status.status === 'failed' ? (
            <p className="kiosk__error">Generation failed: {status.errorMessage ?? 'unknown error'}</p>
          ) : null}
          <div className="faceCard__actions">
            {status.status === 'completed' ? (
              <button type="button" onClick={() => void handleAccept()} disabled={busy}>
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
