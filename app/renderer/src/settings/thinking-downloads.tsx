import { useCallback, useEffect, useRef, useState } from 'react';
import type { HfLookup } from '../../../main/src/local-llm/huggingface.js';
import type { LlmDownload, LocalLlmList } from '../../../main/src/local-llm/llm-library.js';
import type { ModelRoutingView } from '../../../main/src/config/config-manager.js';
import type { ModelsBridge } from '../preload-api.js';
import { formatBytes } from './model-downloads.js';

const ACTIVE = new Set(['queued', 'downloading', 'verifying']);
const SLOT_CHOICES = [1, 2, 3, 4];
const CONTEXT_CHOICES = [8192, 16384, 32768, 65536, 131072];

function tokens(count: number): string {
  return count >= 1024 ? `${Math.round(count / 1024)}K` : String(count);
}

/**
 * On the Thinking page: paste a Hugging Face link or name, pick a size, download it, and (by
 * default) switch Thinking to it, which restarts this PC's llama-server with that model.
 */
export function ThinkingDownloads({ api, busy: parentBusy, onView, local = true }: { api: ModelsBridge; busy: boolean; onView(view: ModelRoutingView): void; local?: boolean }) {
  const [ref, setRef] = useState('');
  const [lookup, setLookup] = useState<HfLookup | null>(null);
  const [quant, setQuant] = useState('');
  const [use, setUse] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloads, setDownloads] = useState<LlmDownload[]>([]);
  const [library, setLibrary] = useState<LocalLlmList | null>(null);
  const finished = useRef(new Set<string>());

  const refresh = useCallback(async () => {
    const [all, list] = await Promise.all([
      api.hfDownloads ? api.hfDownloads().catch(() => [] as LlmDownload[]) : Promise.resolve([] as LlmDownload[]),
      api.localLlms ? api.localLlms().catch(() => null) : Promise.resolve(null),
    ]);
    setDownloads(all);
    setLibrary(list);
    // A download that switched Thinking over changed the routes too.
    let switched = false;
    for (const entry of all) {
      const settled = !ACTIVE.has(entry.state) && (entry.state !== 'done' || !entry.use || entry.result);
      if (settled && !finished.current.has(entry.id)) {
        finished.current.add(entry.id);
        if (entry.state === 'done' && entry.use) switched = true;
      }
    }
    if (switched) onView(await api.get());
  }, [api, onView]);

  useEffect(() => {
    void Promise.resolve().then(() => refresh());
  }, [refresh]);

  // Keep polling while a download runs, and until a finished one has put its model to use.
  const active = downloads.some((entry) => ACTIVE.has(entry.state) || (entry.state === 'done' && entry.use && !entry.result));
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [active, refresh]);

  const look = async (text = ref) => {
    if (!api.hfLookup || !text.trim()) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.hfLookup(text.trim());
      setLookup(result);
      setQuant(result.selected ?? '');
    } catch (err) {
      setLookup(null);
      setError(err instanceof Error ? err.message : 'Hugging Face lookup failed.');
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    if (!api.hfDownload || !lookup?.repo || !quant) return;
    setBusy(true);
    setError(null);
    try {
      await api.hfDownload(lookup.repo, quant, use);
      setLookup(null);
      setRef('');
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download could not start.');
    } finally {
      setBusy(false);
    }
  };

  const pick = async (id: string | null) => {
    if (!api.useLocalLlm) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.useLocalLlm(id);
      setLibrary(result.library);
      onView(result.models);
      setNotice(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not switch the model.');
    } finally {
      setBusy(false);
    }
  };

  // Saving the slots or context restarts llama-server, the same way picking a model does.
  const saveSettings = async (change: { slots?: number; contextPerSlot?: number }) => {
    if (!api.useLocalLlm || !library) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await api.useLocalLlm(library.selected ?? null, { ...library.settings, ...change });
      setLibrary(result.library);
      onView(result.models);
      setNotice(result.message);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not change the slots.');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    if (!api.deleteLocalLlm) return;
    setBusy(true);
    setError(null);
    try {
      setLibrary(await api.deleteLocalLlm(id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not delete it.');
    } finally {
      setBusy(false);
    }
  };

  if (!api.hfLookup) return null;
  const disabled = busy || parentBusy;
  const selectedModel = library?.models.find((model) => model.id === library.selected);
  const chosen = lookup?.quants.find((entry) => entry.id === quant);
  return (
    <div className="modelsDialog__list modelsDialog__downloads">
      <span className="modelsDialog__group">Download a thinking model from Hugging Face</span>
      <p className="kiosk__helper">
        Runs on this PC’s llama-server. Paste a link or repo name (GGUF repos such as unsloth/Qwen3-8B-GGUF), or type words to search.
      </p>
      <form
        className="modelsDialog__fields"
        onSubmit={(event) => {
          event.preventDefault();
          void look();
        }}
      >
        <label htmlFor="models-hf-ref">Hugging Face model</label>
        <input
          id="models-hf-ref"
          value={ref}
          placeholder="https://huggingface.co/… , owner/repo, owner/repo:Q4_K_M or search words"
          onChange={(event) => {
            setRef(event.target.value);
            setLookup(null);
          }}
          disabled={disabled}
        />
        <span />
        <span className="modelsDialog__actions">
          <button type="submit" disabled={disabled || !ref.trim()}>
            {busy && !lookup ? 'Looking up…' : 'Look up'}
          </button>
        </span>
      </form>
      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      {notice ? <p className="kiosk__helper">{notice}</p> : null}
      {lookup && lookup.suggestions.length ? (
        <div className="modelsDialog__plan" aria-label="Hugging Face GGUF models">
          {lookup.note ? <small className="kiosk__helper">{lookup.note}</small> : <span>Pick one:</span>}
          <div className="modelsDialog__chips">
            {lookup.suggestions.map((entry) => (
              <button
                key={entry.repo}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setRef(entry.repo);
                  void look(entry.repo);
                }}
              >
                {entry.repo} <small>{entry.downloads.toLocaleString()} downloads</small>
              </button>
            ))}
          </div>
        </div>
      ) : lookup && !lookup.quants.length && lookup.note ? (
        <p className="kiosk__helper">{lookup.note}</p>
      ) : null}
      {lookup?.repo && lookup.quants.length ? (
        <div className="modelsDialog__plan" aria-label="Hugging Face model">
          <b>{lookup.repo}</b>
          <label className="modelsDialog__inline">
            Size{' '}
            <select value={quant} onChange={(event) => setQuant(event.target.value)} disabled={disabled}>
              {lookup.quants.map((entry) => (
                <option key={entry.id} value={entry.id}>
                  {entry.label} · {formatBytes(entry.sizeBytes)}
                  {entry.files.length > 1 ? ` (${entry.files.length} parts)` : ''}
                </option>
              ))}
            </select>
          </label>
          <small className="kiosk__helper">
            Smaller sizes load faster and use less memory; Q4_K_M is a good balance. Running it takes a little more memory than the file size.
            {lookup.contextLength ? ` Made for up to ${lookup.contextLength.toLocaleString()} tokens of context.` : ''}
          </small>
          {lookup.note ? <small className="kiosk__helper">{lookup.note}</small> : null}
          <label className="modelsDialog__check">
            <input type="checkbox" checked={use} onChange={(event) => setUse(event.target.checked)} disabled={disabled} />
            Use it for Thinking when it’s downloaded (restarts llama-server)
          </label>
          <span className="modelsDialog__actions">
            <button type="button" className="modelsDialog__primary" onClick={() => void start()} disabled={disabled || !quant}>
              Download{chosen ? ` ${formatBytes(chosen.sizeBytes)}` : ''}
            </button>
          </span>
        </div>
      ) : null}
      {downloads.map((entry) => (
        <div key={entry.id} className="modelsDialog__download">
          <span>
            <b>{entry.repo}</b> <small>{entry.label}</small>
          </span>
          {ACTIVE.has(entry.state) ? (
            <>
              <progress max={entry.total || undefined} value={entry.received} aria-label={`Downloading ${entry.repo} ${entry.label}`} />
              <small>{entry.state === 'verifying' ? 'Checking the file…' : `${formatBytes(entry.received)} of ${formatBytes(entry.total)}`}</small>
              <button type="button" onClick={() => void api.hfCancel?.(entry.id).then(() => refresh())}>
                Cancel
              </button>
            </>
          ) : (
            <small className={entry.state === 'done' ? undefined : 'kiosk__error'}>
              {entry.state === 'done'
                ? entry.use
                  ? (entry.result ?? 'Downloaded. Switching Thinking to it…')
                  : 'Downloaded. Pick it below to use it.'
                : entry.state === 'cancelled'
                  ? 'Cancelled. Download it again to carry on where it stopped.'
                  : (entry.error ?? 'Failed.')}
            </small>
          )}
        </div>
      ))}
      {library ? (
        <div className="modelsDialog__list" aria-label="Thinking models on this PC">
          <span className="modelsDialog__group">On this PC</span>
          <div className="modelsDialog__download">
            <span>
              <b>Start script default</b> <small>Qwen Flash-Next, or LOCAL_LLM_GGUF</small>
            </span>
            {library.selected ? (
              <button type="button" onClick={() => void pick(null)} disabled={disabled}>
                Use
              </button>
            ) : (
              <small>In use</small>
            )}
          </div>
          {library.models.map((model) => (
            <div key={model.id} className="modelsDialog__download">
              <span>
                <b>{model.repo}</b> <small>{model.quant.split('/').at(-1)?.replace(/\.gguf$/i, '')} · {formatBytes(model.sizeBytes)}</small>
              </span>
              {library.selected === model.id ? (
                <small>In use</small>
              ) : (
                <span className="modelsDialog__actions">
                  <button type="button" onClick={() => void pick(model.id)} disabled={disabled}>
                    Use
                  </button>
                  <button type="button" onClick={() => void remove(model.id)} disabled={disabled}>
                    Delete
                  </button>
                </span>
              )}
            </div>
          ))}
          {local ? (
            <div className="modelsDialog__plan" aria-label="llama-server slots">
              <label className="modelsDialog__inline">
                Conversations at once{' '}
                <select
                  value={library.settings.slots}
                  onChange={(event) => void saveSettings({ slots: Number(event.target.value) })}
                  disabled={disabled}
                >
                  {[...new Set([...SLOT_CHOICES, library.settings.slots])].sort((a, b) => a - b).map((count) => (
                    <option key={count} value={count}>
                      {count}
                    </option>
                  ))}
                </select>
              </label>
              <small className="kiosk__helper">One per avatar talking; each keeps its own cache.</small>
              <label className="modelsDialog__inline">
                Context per conversation{' '}
                <select
                  value={library.settings.contextPerSlot}
                  onChange={(event) => void saveSettings({ contextPerSlot: Number(event.target.value) })}
                  disabled={disabled}
                >
                  {[...new Set([...CONTEXT_CHOICES, library.settings.contextPerSlot])].sort((a, b) => a - b).map((count) => (
                    <option key={count} value={count} disabled={count !== library.settings.contextPerSlot && count > (selectedModel?.contextLength ?? Infinity)}>
                      {tokens(count)}
                      {selectedModel?.contextLength && count > selectedModel.contextLength ? ' (more than this model supports)' : ''}
                    </option>
                  ))}
                </select>
              </label>
              <small className="kiosk__helper">
                llama-server reserves {tokens(library.settings.slots * Math.min(library.settings.contextPerSlot, selectedModel?.contextLength ?? Infinity))} tokens of context in all.
                Changing either restarts it.
              </small>
            </div>
          ) : null}
          <small className="kiosk__helper">
            Saved in <code>{library.folder}</code> (set LOCAL_LLM_MODELS_DIR to use another drive).
          </small>
        </div>
      ) : null}
    </div>
  );
}
