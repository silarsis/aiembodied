import { useEffect, useState } from 'react';
import type { AvatarBridge, AvatarImageModelSelection, AvatarLoraChoice, AvatarLoraSummary, BaseModelSuggestions } from './types.js';

const FAMILY_LABELS: Record<string, string> = {
  sd1: 'SD 1.5',
  sdxl: 'SDXL',
  'z-image-turbo': 'Z-Image Turbo',
  'qwen-image-2.1': 'Qwen-Image 2.1',
};

function gb(bytes: number): string {
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

function baseLabel(lora: AvatarLoraSummary): string {
  return lora.baseModel ?? (lora.family ? FAMILY_LABELS[lora.family] ?? lora.family : 'unknown base model');
}

interface Props {
  api: AvatarBridge;
  selection: AvatarImageModelSelection;
  disabled: boolean;
  onChange(choices: AvatarLoraChoice[]): void;
  /** Re-read the model list (after a base model downloads). */
  onRefresh(): Promise<void>;
}

/**
 * LoRAs under the image model: each one applies only to a model of the family it was trained for.
 * One with no such model on the server gets Civitai suggestions sized to that server's GPU.
 */
export function LoraPicker({ api, selection, disabled, onChange, onRefresh }: Props) {
  const loras = selection.loras ?? [];
  const chosen = selection.selectedLoras ?? [];
  const families = selection.modelFamilies ?? {};
  const modelFamily = selection.selectedModelId ? families[selection.selectedModelId] : undefined;
  const availableFamilies = new Set(
    selection.models.filter((model) => model.available).map((model) => families[model.id]),
  );
  const [suggestionsFor, setSuggestionsFor] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<BaseModelSuggestions | null>(null);
  const [suggestError, setSuggestError] = useState<string | null>(null);
  const [downloading, setDownloading] = useState<{ id: string; name: string; state: string; error?: string } | null>(null);

  useEffect(() => {
    if (!downloading || !['queued', 'downloading', 'verifying'].includes(downloading.state) || !api.listModelDownloads) return;
    const timer = setInterval(() => {
      void api.listModelDownloads?.().then(async (all) => {
        const entry = all.find((item) => item.id === downloading.id);
        if (!entry || entry.state === downloading.state) return;
        setDownloading({ ...downloading, state: entry.state, ...(entry.error ? { error: entry.error } : {}) });
        if (entry.state === 'done') await onRefresh();
      });
    }, 2000);
    return () => clearInterval(timer);
  }, [api, downloading, onRefresh]);

  if (!loras.length) return null;

  const toggle = (lora: AvatarLoraSummary, on: boolean) =>
    onChange(on ? [...chosen.filter((c) => c.name !== lora.name), { name: lora.name, strength: 0.8 }] : chosen.filter((c) => c.name !== lora.name));
  const setStrength = (name: string, strength: number) =>
    onChange(chosen.map((c) => (c.name === name ? { ...c, strength } : c)));

  const suggest = async (lora: AvatarLoraSummary) => {
    if (!api.suggestBaseModels) return;
    setSuggestionsFor(lora.name);
    setSuggestions(null);
    setSuggestError(null);
    try {
      setSuggestions(await api.suggestBaseModels({ ...(lora.baseModel ? { baseModel: lora.baseModel } : {}), ...(lora.family ? { family: lora.family } : {}) }));
    } catch (err) {
      setSuggestError(err instanceof Error ? err.message : 'Civitai had no suggestions.');
    }
  };

  const download = async (serverId: string, ref: string, name: string) => {
    if (!api.downloadBaseModel) return;
    try {
      const started = await api.downloadBaseModel(serverId, ref);
      setDownloading({ id: started.id, name, state: started.state });
    } catch (err) {
      setDownloading({ id: '', name, state: 'failed', error: err instanceof Error ? err.message : 'The download could not start.' });
    }
  };

  return (
    <fieldset className="avatarStudio__field avatarStudio__loras">
      <legend>LoRAs</legend>
      {loras.map((lora) => {
        const choice = chosen.find((c) => c.name === lora.name);
        const usable = Boolean(lora.family && lora.family === modelFamily);
        const hasModel = Boolean(lora.family && availableFamilies.has(lora.family));
        return (
          <div key={lora.name} className="avatarStudio__lora">
            <label>
              <input
                type="checkbox"
                checked={Boolean(choice) && usable}
                disabled={disabled || !usable}
                onChange={(event) => toggle(lora, event.target.checked)}
              />{' '}
              {lora.title ?? lora.name} <small>({baseLabel(lora)})</small>
            </label>
            {choice && usable ? (
              <label className="avatarStudio__loraStrength">
                Strength{' '}
                <input
                  type="number"
                  min={0}
                  max={2}
                  step={0.1}
                  value={choice.strength}
                  disabled={disabled}
                  aria-label={`Strength for ${lora.title ?? lora.name}`}
                  onChange={(event) => setStrength(lora.name, Number(event.target.value))}
                />
              </label>
            ) : null}
            {lora.triggerWords?.length ? <small>Adds to the prompt: {lora.triggerWords.join(', ')}</small> : null}
            {!lora.family ? (
              <small className="avatarStudio__warnText">{"Its base model isn't known, so it can't be used."}</small>
            ) : !usable && hasModel ? (
              <small>Pick a {baseLabel(lora)} image model above to use it.</small>
            ) : !usable ? (
              <small>
                No {baseLabel(lora)} model on this server yet.{' '}
                <button type="button" disabled={disabled} onClick={() => void suggest(lora)}>
                  Suggest a model
                </button>
              </small>
            ) : null}
            {suggestionsFor === lora.name ? (
              <div className="avatarStudio__suggestions" aria-label={`Models for ${lora.title ?? lora.name}`}>
                {suggestError ? <small className="avatarStudio__warnText">{suggestError}</small> : null}
                {!suggestions && !suggestError ? <small>Asking Civitai…</small> : null}
                {suggestions ? (
                  <>
                    <small>
                      Popular {suggestions.baseModel} models on Civitai
                      {suggestions.vramBytes ? `, for ${suggestions.serverName}'s ${gb(suggestions.vramBytes)} GPU` : ''}:
                    </small>
                    {suggestions.suggestions.length ? null : <small>None found.</small>}
                    {suggestions.suggestions.map((item) => (
                      <div key={item.ref} className="avatarStudio__suggestion">
                        <span>
                          {item.name} <small>{gb(item.sizeKB * 1024)}</small>{' '}
                          {item.fits === false ? <small className="avatarStudio__warnText">too big for the GPU</small> : null}
                        </span>
                        <button
                          type="button"
                          disabled={disabled || Boolean(downloading && ['queued', 'downloading', 'verifying'].includes(downloading.state))}
                          onClick={() => void download(suggestions.serverId, item.ref, item.name)}
                        >
                          Download
                        </button>
                      </div>
                    ))}
                  </>
                ) : null}
              </div>
            ) : null}
          </div>
        );
      })}
      {downloading ? (
        <small className={downloading.state === 'failed' ? 'avatarStudio__warnText' : undefined} role="status">
          {downloading.state === 'done'
            ? `${downloading.name} downloaded.`
            : downloading.state === 'failed' || downloading.state === 'cancelled'
              ? `${downloading.name}: ${downloading.error ?? downloading.state}`
              : `Downloading ${downloading.name}… (progress is also on the server's page in Models and servers)`}
        </small>
      ) : null}
    </fieldset>
  );
}
