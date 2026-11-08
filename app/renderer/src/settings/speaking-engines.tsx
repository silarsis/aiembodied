/**
 * Models and servers → Speaking, on a speech service: which text-to-speech engine reads the replies
 * (Kokoro, Kitten TTS or Piper), its model, the default voice, and downloads of Kitten models and
 * Piper voices. Each character can pick its own voice in Character → Voice.
 */
import { useCallback, useEffect, useState } from 'react';
import type { ModelServerView } from '../../../main/src/config/config-manager.js';
import { formatSpeakingModel, parseSpeakingModel, type ModelRoute, type SpeakingEngineId } from '../../../main/src/config/model-routing.js';
import type { SpeechTtsEngine, SpeechTtsModel } from '../../../main/src/local-voice/speech-service-client.js';
import type { ModelsBridge } from '../preload-api.js';

const ENGINE_LABEL: Record<SpeakingEngineId, string> = { kokoro: 'Kokoro', kitten: 'Kitten TTS', piper: 'Piper' };
const ENGINE_HINT: Record<SpeakingEngineId, string> = {
  kokoro: 'Natural and expressive; its pitch moves the most between sentences.',
  kitten: 'The steadiest pitch from sentence to sentence. American voices only.',
  piper: 'Very fast, with British voices; sounds a little more robotic. Each voice is its own download.',
};

function formatSize(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(bytes / 1e6))} MB`;
}

function downloadText(model: SpeechTtsModel): string | null {
  const download = model.download;
  if (!download || model.installed) return null;
  if (download.status === 'error') return `Download failed: ${download.error ?? 'unknown error'}`;
  if (download.status === 'downloading') {
    return download.total ? `Downloading… ${formatSize(download.received)} of ${formatSize(download.total)}` : 'Downloading…';
  }
  return null;
}

export interface SpeakingEngineFieldsProps {
  api: Pick<ModelsBridge, 'speechEngines' | 'speechDownload'>;
  server: ModelServerView;
  route: ModelRoute;
  busy: boolean;
  onRoute(route: ModelRoute): void;
  /** How often to re-read the list while something downloads. */
  pollMs?: number;
}

export function SpeakingEngineFields({ api, server, route, busy, onRoute, pollMs = 1500 }: SpeakingEngineFieldsProps) {
  const [engines, setEngines] = useState<SpeechTtsEngine[] | null | 'loading'>('loading');
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!api.speechEngines) {
      setEngines(null);
      return;
    }
    try {
      setEngines(await api.speechEngines(server.id));
    } catch (err) {
      setEngines(null);
      setError(err instanceof Error ? err.message : 'Could not read the speech service’s engines.');
    }
  }, [api, server.id]);

  useEffect(() => {
    void Promise.resolve().then(load);
  }, [load]);

  const downloading =
    Array.isArray(engines) && engines.some((engine) => engine.models.some((model) => model.download?.status === 'downloading'));
  useEffect(() => {
    if (!downloading) return;
    const timer = window.setInterval(() => void load(), pollMs);
    return () => window.clearInterval(timer);
  }, [downloading, load, pollMs]);

  const picked = parseSpeakingModel(route.model);
  const defaultVoice = picked.legacyVoice ?? route.voice ?? '';

  if (engines === 'loading') {
    return (
      <>
        <span />
        <p className="kiosk__helper">Reading the speech service’s engines…</p>
      </>
    );
  }
  if (!engines) {
    return (
      <>
        <span />
        <p className="kiosk__helper">
          {error ??
            (server.managed
              ? 'The speech service isn’t answering, or is too old to offer Kitten and Piper. Restart it (pnpm dev:run) and refresh.'
              : 'This speech service isn’t answering, or is too old to offer Kitten and Piper.')}{' '}
          <button type="button" onClick={() => void load()}>
            Refresh
          </button>
        </p>
      </>
    );
  }

  const engineInfo = (id: SpeakingEngineId) => engines.find((engine) => engine.id === id);
  const current = engineInfo(picked.engine);
  const kittenModel = picked.engine === 'kitten' ? current?.models.find((model) => model.id === picked.model) : undefined;
  const voices =
    picked.engine === 'piper'
      ? (current?.models ?? []).filter((model) => model.installed).map((model) => model.id)
      : picked.engine === 'kitten'
        ? kittenModel?.voices ?? []
        : current?.models[0]?.voices ?? [];

  const pickEngine = (engine: SpeakingEngineId) => {
    if (engine === picked.engine) return;
    const kitten = engineInfo('kitten')?.models;
    const model = engine === 'kitten' ? (kitten?.find((entry) => entry.installed) ?? kitten?.[0])?.id : undefined;
    // Voices belong to one engine: start the new one on its own default.
    onRoute({ ...route, model: formatSpeakingModel(engine, model), voice: undefined });
  };

  const download = async (engine: SpeakingEngineId, model: string) => {
    if (!api.speechDownload) return;
    setError(null);
    try {
      const next = await api.speechDownload(server.id, engine, model);
      if (next) setEngines(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The download could not start.');
    }
  };

  return (
    <>
      <label htmlFor="models-tts-engine">Engine</label>
      <span className="modelsDialog__model">
        <select id="models-tts-engine" value={picked.engine} onChange={(event) => pickEngine(event.target.value as SpeakingEngineId)} disabled={busy}>
          {(['kokoro', 'kitten', 'piper'] as const).map((id) => {
            const info = engineInfo(id);
            const missing = id !== 'kokoro' && info && !info.available;
            return (
              <option key={id} value={id} disabled={!info || (missing && picked.engine !== id)}>
                {ENGINE_LABEL[id]}
                {!info ? ' (not in this speech service)' : missing ? ' (not installed in the speech service)' : ''}
              </option>
            );
          })}
        </select>
        <small className="kiosk__helper">{ENGINE_HINT[picked.engine]}</small>
        {current && !current.available && current.error ? <small className="kiosk__error">{current.error}</small> : null}
      </span>

      {picked.engine === 'kitten' ? (
        <>
          <label htmlFor="models-tts-kitten">Model</label>
          <span className="modelsDialog__model">
            <select
              id="models-tts-kitten"
              value={picked.model}
              onChange={(event) => onRoute({ ...route, model: formatSpeakingModel('kitten', event.target.value) })}
              disabled={busy}
            >
              {(current?.models ?? []).map((model) => (
                <option key={model.id} value={model.id}>
                  {model.label}
                  {model.sizeMb ? ` · ${model.sizeMb} MB` : ''}
                  {model.installed ? '' : ' · not downloaded'}
                </option>
              ))}
            </select>
            {kittenModel && !kittenModel.installed ? (
              <span className="modelsDialog__modelActions">
                <button
                  type="button"
                  onClick={() => void download('kitten', kittenModel.id)}
                  disabled={busy || kittenModel.download?.status === 'downloading'}
                >
                  Download
                </button>
                {downloadText(kittenModel) ? <small className="kiosk__helper">{downloadText(kittenModel)}</small> : null}
              </span>
            ) : null}
          </span>
        </>
      ) : null}

      {picked.engine === 'piper' ? (
        <>
          <span className="modelsDialog__fieldLabel">Voices</span>
          <ul className="modelsDialog__speechModels" aria-label="Piper voices">
            {(current?.models ?? []).map((model) => (
              <li key={model.id}>
                <span>{model.label}</span>
                {model.installed ? (
                  <small className="kiosk__info">Downloaded</small>
                ) : (
                  <>
                    <button
                      type="button"
                      onClick={() => void download('piper', model.id)}
                      disabled={busy || model.download?.status === 'downloading'}
                      aria-label={`Download ${model.label}`}
                    >
                      Download
                    </button>
                    {downloadText(model) ? <small className="kiosk__helper">{downloadText(model)}</small> : null}
                  </>
                )}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      <label htmlFor="models-tts-default-voice">Default voice</label>
      <span className="modelsDialog__model">
        <select
          id="models-tts-default-voice"
          value={defaultVoice}
          onChange={(event) => onRoute({ ...route, model: formatSpeakingModel(picked.engine, picked.model), voice: event.target.value || undefined })}
          disabled={busy || voices.length === 0}
        >
          <option value="">{picked.engine === 'kokoro' ? 'The speech service’s default' : 'The engine’s default'}</option>
          {defaultVoice && !voices.includes(defaultVoice) ? <option value={defaultVoice}>{defaultVoice} (not available)</option> : null}
          {voices.map((voice) => (
            <option key={voice} value={voice}>
              {voice}
            </option>
          ))}
        </select>
        <small className="kiosk__helper">
          {voices.length === 0 && picked.engine !== 'kokoro'
            ? 'Download a model above first.'
            : 'Each character can pick its own voice in Character → Voice.'}
        </small>
        {error ? <small className="kiosk__error">{error}</small> : null}
      </span>
    </>
  );
}
