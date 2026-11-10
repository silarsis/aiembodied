import { useCallback, useEffect, useState } from 'react';
import type { VisionStatus } from '../../../main/src/local-vision/vision-model.js';
import type { ModelsBridge } from '../preload-api.js';
import { formatBytes } from './model-downloads.js';

const ACTIVE = new Set(['queued', 'downloading', 'verifying']);

/** The status line for the vision model: Not downloaded, Downloading 43%, or Ready with its files. */
export function visionStatusLine(status: VisionStatus | null): string {
  if (!status) return 'Checking…';
  const download = status.download;
  if (download && ACTIVE.has(download.state)) {
    if (download.state === 'verifying') return 'Checking the files…';
    const percent = download.total > 0 ? Math.min(99, Math.floor((download.received / download.total) * 100)) : 0;
    return `Downloading ${percent}%`;
  }
  if (status.ready && status.pick) {
    const names = [status.pick.model, status.pick.mmproj].map((file) => file.split(/[\\/]/).at(-1) ?? file).join(' + ');
    return `Ready: ${names}, ${formatBytes(status.sizeBytes)}`;
  }
  if (download?.state === 'failed') return `Download failed: ${download.error ?? 'unknown error'}`;
  return 'Not downloaded';
}

/**
 * On the Describe the avatar page, when it runs on this PC's vision model: whether the model is on
 * disk, a button to download the default (Qwen3-VL 8B) and a field for another Hugging Face repo.
 * The app starts the model by itself when a job needs it, and stops it again when idle.
 */
export function VisionDownload({ api, busy: parentBusy }: { api: ModelsBridge; busy: boolean }) {
  const [status, setStatus] = useState<VisionStatus | null>(null);
  const [other, setOther] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!api.visionStatus) return;
    setStatus(await api.visionStatus().catch(() => null));
  }, [api]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  const downloading = Boolean(status?.download && ACTIVE.has(status.download.state));
  useEffect(() => {
    if (!downloading) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [downloading, refresh]);

  const start = async (ref?: string) => {
    if (!api.visionDownload) return;
    setBusy(true);
    setError(null);
    try {
      setStatus(await api.visionDownload(ref));
      if (ref) setOther('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download could not start.');
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!api.visionCancel) return;
    setStatus(await api.visionCancel().catch(() => status));
  };

  if (!api.visionStatus) return null;
  const disabled = busy || parentBusy || downloading;
  return (
    <div className="modelsDialog__list modelsDialog__downloads">
      <span className="modelsDialog__group">Vision model on this PC</span>
      <p className="kiosk__helper">
        Qwen3-VL 8B reads the avatar screenshot. The app starts it when a description is requested and stops it after ten idle minutes, so it
        never sits beside the language model.
      </p>
      <p role="status" aria-label="Vision model status">
        {visionStatusLine(status)}
      </p>
      {downloading && status?.download ? (
        <div className="modelsDialog__download">
          <progress max={status.download.total || undefined} value={status.download.received} aria-label="Downloading the vision model" />
          <small>
            {formatBytes(status.download.received)} of {formatBytes(status.download.total)}
          </small>
          <button type="button" onClick={() => void cancel()}>
            Cancel
          </button>
        </div>
      ) : null}
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      <span className="modelsDialog__actions">
        <button type="button" className="modelsDialog__primary" onClick={() => void start()} disabled={disabled}>
          {status?.ready ? 'Download again' : 'Download vision model (~6 GB)'}
        </button>
      </span>
      <form
        className="modelsDialog__fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (other.trim()) void start(other.trim());
        }}
      >
        <label htmlFor="models-vision-other">Use another model…</label>
        <input
          id="models-vision-other"
          value={other}
          placeholder="https://huggingface.co/… , owner/repo or owner/repo:Q4_K_M (needs an mmproj file)"
          onChange={(event) => setOther(event.target.value)}
          disabled={disabled}
        />
        <span />
        <span className="modelsDialog__actions">
          <button type="submit" disabled={disabled || !other.trim()}>
            Download this one
          </button>
        </span>
      </form>
    </div>
  );
}
