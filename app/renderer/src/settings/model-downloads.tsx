import { useCallback, useEffect, useRef, useState } from 'react';
import type { CivitaiLookup } from '../../../main/src/avatar/generation/civitai.js';
import type { ModelDownload } from '../../../main/src/avatar/generation/model-downloads.js';
import type { ModelServerView } from '../../../main/src/config/config-manager.js';
import type { ModelsBridge } from '../preload-api.js';

const ACTIVE = new Set(['queued', 'downloading', 'verifying']);

export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes) return '0 MB';
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`;
}

/** "Download a model" on a ComfyUI server's page: paste a Civitai link, check it, download it there. */
export function ModelDownloads({ api, server, onFinished }: { api: ModelsBridge; server: ModelServerView; onFinished(): void }) {
  const [ref, setRef] = useState('');
  const [lookup, setLookup] = useState<CivitaiLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<ModelDownload[]>([]);
  const [addon, setAddon] = useState<{ installed: boolean; folder: string } | null>(null);
  const finished = useRef(new Set<string>());

  const checkAddon = useCallback(async () => {
    if (!api.comfyAddon) return;
    try {
      setAddon(await api.comfyAddon(server.id));
    } catch {
      setAddon(null);
    }
  }, [api, server.id]);

  const refresh = useCallback(async () => {
    if (!api.downloads) return;
    const all = (await api.downloads().catch(() => [] as ModelDownload[])).filter((entry) => entry.serverId === server.id);
    setDownloads(all);
    // A finished download changes the server's model list.
    let changed = false;
    for (const entry of all) {
      if (!ACTIVE.has(entry.state) && !finished.current.has(entry.id)) {
        finished.current.add(entry.id);
        if (entry.state === 'done') changed = true;
      }
    }
    if (changed) onFinished();
  }, [api, server.id, onFinished]);

  useEffect(() => {
    void Promise.resolve().then(() => Promise.all([checkAddon(), refresh()]));
  }, [checkAddon, refresh]);

  const active = downloads.some((entry) => ACTIVE.has(entry.state));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const look = async (versionId?: number) => {
    if (!api.civitaiLookup || !ref.trim()) return;
    setBusy(true);
    setError(null);
    try {
      setLookup(await api.civitaiLookup(ref.trim(), versionId));
    } catch (err) {
      setLookup(null);
      setError(err instanceof Error ? err.message : 'Civitai lookup failed.');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!api.download || !lookup) return;
    setBusy(true);
    setError(null);
    try {
      await api.download(server.id, ref.trim(), lookup.plan.versionId);
      setLookup(null);
      setRef('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download could not start.');
    } finally {
      setBusy(false);
    }
  };

  const needsAddon = !server.managed && addon && !addon.installed;
  const plan = lookup?.plan;
  return (
    <div className="modelsDialog__list modelsDialog__downloads">
      <span className="modelsDialog__group">Download a model</span>
      {needsAddon ? (
        <div className="modelsDialog__addon" role="note">
          <p>
            <b>{server.name} needs the aiembodied add-on</b> before the app can download models to it. Copy this folder into that
            machine’s <code>ComfyUI/custom_nodes</code> and restart its ComfyUI:
          </p>
          <code className="modelsDialog__path">{addon.folder}</code>
          <p className="kiosk__helper">It’s also in the repo at app/main/assets/avatar-generation/comfyui-aiembodied. It adds no nodes.</p>
          <button type="button" onClick={() => void checkAddon()}>
            Check again
          </button>
        </div>
      ) : null}
      <form
        className="modelsDialog__fields"
        onSubmit={(event) => {
          event.preventDefault();
          void look();
        }}
      >
        <label htmlFor="models-civitai-ref">Civitai link</label>
        <input
          id="models-civitai-ref"
          value={ref}
          placeholder="https://civitai.com/models/… or urn:air:…:civitai:123@456"
          onChange={(event) => {
            setRef(event.target.value);
            setLookup(null);
          }}
          disabled={busy}
        />
        <span />
        <span className="modelsDialog__actions">
          <button type="submit" disabled={busy || !ref.trim()}>
            {busy && !lookup ? 'Looking up…' : 'Look up'}
          </button>
        </span>
      </form>
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      {plan && lookup ? (
        <div className="modelsDialog__plan" aria-label="Civitai model">
          <b>{plan.title}</b>
          <span>
            {plan.type}
            {plan.baseModel ? ` · ${plan.baseModel}` : ''} · {plan.file.name} · {formatBytes(plan.file.sizeKB * 1024)} → {plan.folder}
          </span>
          {lookup.versions.length > 1 ? (
            <label className="modelsDialog__inline">
              Version{' '}
              <select value={plan.versionId} onChange={(event) => void look(Number(event.target.value))} disabled={busy}>
                {lookup.versions.map((version) => (
                  <option key={version.id} value={version.id}>
                    {version.name}
                    {version.baseModel ? ` (${version.baseModel})` : ''}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          {plan.note ? <small className="kiosk__helper">{plan.note}</small> : null}
          <span className="modelsDialog__actions">
            <button type="button" className="modelsDialog__primary" onClick={() => void start()} disabled={busy || Boolean(needsAddon)}>
              Download to {server.name}
            </button>
          </span>
        </div>
      ) : null}
      {downloads.map((entry) => (
        <div key={entry.id} className="modelsDialog__download">
          <span>
            <b>{entry.filename}</b> <small>{entry.folder}</small>
          </span>
          {ACTIVE.has(entry.state) ? (
            <>
              <progress max={entry.total ?? undefined} value={entry.received} aria-label={`Downloading ${entry.filename}`} />
              <small>
                {entry.state === 'verifying' ? 'Checking the file…' : `${formatBytes(entry.received)}${entry.total ? ` of ${formatBytes(entry.total)}` : ''}`}
              </small>
              <button type="button" onClick={() => void api.cancelDownload?.(entry.id).then(() => refresh())}>
                Cancel
              </button>
            </>
          ) : (
            <small className={entry.state === 'done' ? undefined : 'kiosk__error'}>
              {entry.state === 'done' ? `Downloaded.${entry.note ? ` ${entry.note}` : ''}` : entry.state === 'cancelled' ? 'Cancelled.' : entry.error ?? 'Failed.'}
            </small>
          )}
        </div>
      ))}
    </div>
  );
}
