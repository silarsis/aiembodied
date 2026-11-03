import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
  type ReactNode,
} from 'react';
import type {
  AvatarBridge,
  AvatarModelSummary,
} from './types.js';
import { generateVrmThumbnail } from './thumbnail-generator.js';
import { AvatarStudio, AvatarStudioLauncher } from './avatar-studio.js';

type ModelUploadStatus = 'idle' | 'reading' | 'uploading' | 'success';

interface AvatarConfiguratorProps {
  compact?: boolean;
  children?: ReactNode;
  avatarApi?: AvatarBridge;
  onActiveModelChange?: (detail: AvatarModelSummary | null) => void;
  /**
   * When set, the avatar studio is opened from outside (the app's Avatar button) instead
   * of by the launcher section at the bottom of the library.
   */
  studio?: { open: boolean; onClose(): void };
}

function deriveName(file: File | null): string {
  if (!file) {
    return '';
  }

  const name = file.name.replace(/\.[^/.]+$/, '').trim();
  return name || 'New model';
}

async function fileToDataUrl(file: File): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener('error', () => {
      reject(new Error('Failed to read file contents.'));
    });
    reader.addEventListener('load', () => {
      const result = typeof reader.result === 'string' ? reader.result : null;
      if (!result) {
        reject(new Error('File reader returned an unexpected result.'));
        return;
      }

      resolve(result);
    });
    reader.readAsDataURL(file);
  });
}

async function fileToBase64(file: File): Promise<string> {
  const dataUrl = await fileToDataUrl(file);
  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) {
    throw new Error('Unexpected data URL format while preparing VRM upload.');
  }

  return dataUrl.slice(commaIndex + 1);
}

function formatTimestamp(value: number): string {
  try {
    return new Date(value).toLocaleString();
  } catch {
    return new Date(value).toString();
  }
}



export function AvatarConfigurator({
  avatarApi,
  onActiveModelChange,
  compact = false,
  children,
  studio,
}: AvatarConfiguratorProps) {
  const [models, setModels] = useState<AvatarModelSummary[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelBusyId, setModelBusyId] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [modelNameInput, setModelNameInput] = useState('');
  const [modelUploadStatus, setModelUploadStatus] = useState<ModelUploadStatus>('idle');
  const [modelUploadError, setModelUploadError] = useState<string | null>(null);
  const [lastUploadedModel, setLastUploadedModel] = useState<AvatarModelSummary | null>(null);
  const modelFileInputRef = useRef<HTMLInputElement | null>(null);
  const availabilityLogRef = useRef<'available' | 'missing' | null>(null);
  const isModelBridgeAvailable = Boolean(avatarApi?.listModels && avatarApi?.uploadModel);

  useEffect(() => {
    const nextState: 'available' | 'missing' = avatarApi ? 'available' : 'missing';
    if (availabilityLogRef.current === nextState) {
      return;
    }

    availabilityLogRef.current = nextState;
    if (nextState === 'available') {
      console.info('[avatar configurator] Avatar bridge connected.');
      setGeneralError(null);
    } else {
      console.warn('[avatar configurator] Avatar bridge unavailable. Falling back to static UI.');
      setGeneralError('Avatar configuration bridge is unavailable.');
    }
  }, [avatarApi]);

  const formattedModels = useMemo(() => {
    return models.map((model) => ({
      ...model,
      createdLabel: formatTimestamp(model.createdAt),
    }));
  }, [models]);

  const generateMissingThumbnails = useCallback(async () => {
    if (!avatarApi?.loadModelBinary || !avatarApi.updateModelThumbnail) {
      return;
    }

    const modelsNeedingThumbnails = models.filter((m) => !m.thumbnailDataUrl);
    if (modelsNeedingThumbnails.length === 0) {
      return;
    }

    for (const model of modelsNeedingThumbnails) {
      try {
        setModelBusyId(model.id);
        const modelData = await avatarApi.loadModelBinary(model.id);
        const thumbnailResult = await generateVrmThumbnail(modelData);
        const updated = await avatarApi.updateModelThumbnail(model.id, thumbnailResult.dataUrl);
        if (updated) {
          setModels((prev) =>
            prev.map((m) => (m.id === model.id ? updated : m)),
          );
        }
      } catch (err) {
        console.warn(`[avatar-configurator] Failed to generate thumbnail for model ${model.id}:`, err);
      } finally {
        setModelBusyId(null);
      }
    }
  }, [models, avatarApi]);

  const refreshModels = useCallback(async () => {
    if (!avatarApi?.listModels || !avatarApi.getActiveModel) {
      setModels([]);
      setActiveModelId(null);
      onActiveModelChange?.(null);
      setModelsLoading(false);
      setModelError('VRM configuration bridge is unavailable.');
      return;
    }

    setModelsLoading(true);
    setModelError(null);

    try {
      const [list, active] = await Promise.all([avatarApi.listModels(), avatarApi.getActiveModel()]);
      setModels(list);
      setActiveModelId(active?.id ?? null);
      onActiveModelChange?.(active ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load VRM models.';
      setModelError(message);
    } finally {
      setModelsLoading(false);
      setModelBusyId(null);
    }
  }, [avatarApi, onActiveModelChange]);

  useEffect(() => {
    generateMissingThumbnails();
  }, [generateMissingThumbnails]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshModels();
      if (cancelled) {
        return;
      }

      if (modelFileInputRef.current) {
        modelFileInputRef.current.value = '';
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshModels]);

  const handleModelFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setModelFile(nextFile);
    setModelUploadError(null);
    setModelUploadStatus('idle');
    setLastUploadedModel(null);
    if (nextFile) {
      setModelNameInput((previous) => (previous.trim().length > 0 ? previous : deriveName(nextFile)));
    }
  }, []);

  const handleModelNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setModelNameInput(event.target.value);
  }, []);

  const handleModelUpload = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!avatarApi?.uploadModel) {
        setModelUploadError('VRM configuration bridge is unavailable.');
        return;
      }

      if (!modelFile) {
        setModelUploadError('Select a .vrm file to upload.');
        return;
      }

      const fileName = modelFile.name.trim();
      if (!fileName.toLowerCase().endsWith('.vrm')) {
        setModelUploadError('VRM upload rejected: file must use the .vrm extension.');
        return;
      }

      setModelUploadError(null);
      setModelUploadStatus('reading');
      setLastUploadedModel(null);

      void (async () => {
        try {
          const base64 = await fileToBase64(modelFile);
          setModelUploadStatus('uploading');
          const name = modelNameInput.trim() || deriveName(modelFile);
          const result = await avatarApi.uploadModel({
            fileName,
            data: base64,
            name,
          });

          let uploadedModel = result.model;

          if (!uploadedModel.thumbnailDataUrl && avatarApi.updateModelThumbnail) {
            try {
              const modelData = await avatarApi.loadModelBinary(uploadedModel.id);
              const thumbnailResult = await generateVrmThumbnail(modelData);
              const updated = await avatarApi.updateModelThumbnail(uploadedModel.id, thumbnailResult.dataUrl);
              if (updated) {
                uploadedModel = updated;

                if (!uploadedModel.description && avatarApi.generateModelDescription) {
                  try {
                    const description = await avatarApi.generateModelDescription(thumbnailResult.dataUrl);
                    if (description && avatarApi.updateModelDescription) {
                      const withDescription = await avatarApi.updateModelDescription(uploadedModel.id, description);
                      if (withDescription) {
                        uploadedModel = withDescription;
                      }
                    }
                  } catch (descErr) {
                    console.warn('[avatar-configurator] Failed to generate model description:', descErr);
                  }
                }
              }
            } catch (thumbErr) {
              console.warn('[avatar-configurator] Failed to generate fallback thumbnail:', thumbErr);
            }
          }

          setModelUploadStatus('success');
          setLastUploadedModel(uploadedModel);
          setModelNameInput('');
          setModelFile(null);
          if (modelFileInputRef.current) {
            modelFileInputRef.current.value = '';
          }
          await refreshModels();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to upload VRM model.';
          setModelUploadError(message);
          setModelUploadStatus('idle');
        }
      })();
    },
    [avatarApi, modelFile, modelNameInput, refreshModels],
  );

  const handleModelSelect = useCallback(
    async (modelId: string) => {
      if (!avatarApi?.setActiveModel) {
        setModelError('VRM configuration bridge is unavailable.');
        return;
      }

      setModelBusyId(modelId);
      setModelError(null);
      try {
        const detail = await avatarApi.setActiveModel(modelId);
        setActiveModelId(detail?.id ?? null);
        onActiveModelChange?.(detail ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to activate VRM model.';
        setModelError(message);
      } finally {
        setModelBusyId(null);
      }
    },
    [avatarApi, onActiveModelChange],
  );

  const handleModelDelete = useCallback(
    async (modelId: string) => {
      if (!avatarApi?.deleteModel) {
        setModelError('VRM configuration bridge is unavailable.');
        return;
      }

      setModelBusyId(modelId);
      setModelError(null);
      try {
        await avatarApi.deleteModel(modelId);
        if (activeModelId === modelId) {
          onActiveModelChange?.(null);
        }
        await refreshModels();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete VRM model.';
        setModelError(message);
      } finally {
        setModelBusyId(null);
      }
    },
    [avatarApi, activeModelId, onActiveModelChange, refreshModels],
  );

  const modelUploadDisabled = !isModelBridgeAvailable || modelUploadStatus === 'reading' || modelUploadStatus === 'uploading';

  return (
    <section className="kiosk__faces" aria-label="Avatar library">
      {generalError ? (
        <p className="kiosk__error" role="alert">
          {generalError}
        </p>
      ) : null}

      {/* VRM Models Section */}
      <div className="faces__section">
        <h3 className="faces__heading">VRM Avatars</h3>

        {modelError ? (
          <p role="alert" className="kiosk__error">
            {modelError}
          </p>
        ) : null}
        {modelsLoading ? <p className="kiosk__info">Loading stored VRM models…</p> : null}

        <div className="faces__grid faces__grid--compact" role="list">
          {formattedModels.map((model) => {
            const isActive = model.id === activeModelId;
            const busy = modelBusyId === model.id || modelUploadStatus === 'uploading';
            return (
              <article key={model.id} className="faceCard faceCard--compact" data-active={isActive ? 'true' : 'false'} role="listitem">
                <div className="faceCard__preview" aria-hidden="true">
                  {model.thumbnailDataUrl ? (
                    <img src={model.thumbnailDataUrl} alt="" loading="lazy" />
                  ) : (
                    <div className="faceCard__placeholder">No thumbnail</div>
                  )}
                </div>
                <div className="faceCard__info">
                  <h4>{model.name}</h4>
                </div>
                <div className="faceCard__actions">
                  <button type="button" onClick={() => handleModelSelect(model.id)} disabled={busy || !isModelBridgeAvailable}>
                    {isActive ? 'Active' : 'Use model'}
                  </button>
                  <button type="button" onClick={() => handleModelDelete(model.id)} disabled={busy || !isModelBridgeAvailable}>
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        {!modelsLoading && formattedModels.length === 0 ? (
          <p className="kiosk__info">No VRM models uploaded yet. Add a .vrm file to enable the 3D renderer.</p>
        ) : null}

        <details className="avatarUpload" open={compact ? undefined : true}>
          <summary>+ Upload .vrm</summary>
          <form className="faces__form" onSubmit={handleModelUpload} aria-label="Upload new VRM model">
            <label className="faces__field">
              <span>VRM file</span>
              <input
                ref={modelFileInputRef}
                type="file"
                accept=".vrm"
                onChange={handleModelFileChange}
                disabled={!isModelBridgeAvailable || modelUploadDisabled}
                required
              />
            </label>
            <label className="faces__field">
              <span>Display name</span>
              <input
                type="text"
                value={modelNameInput}
                onChange={handleModelNameChange}
                placeholder="3D assistant"
                disabled={!isModelBridgeAvailable || modelUploadDisabled}
              />
            </label>
            <button type="submit" disabled={modelUploadDisabled || !modelFile} className="faces__submit">
              {modelUploadStatus === 'reading' ? 'Processing…' : modelUploadStatus === 'uploading' ? 'Uploading…' : 'Upload VRM'}
            </button>
          </form>

          {modelUploadError ? (
            <p className="kiosk__error" role="alert">
              {modelUploadError}
            </p>
          ) : null}
          {modelUploadStatus === 'uploading' ? <p className="kiosk__info">Uploading VRM model…</p> : null}
          {modelUploadStatus === 'reading' ? <p className="kiosk__info">Preparing VRM payload…</p> : null}

          {lastUploadedModel ? (
            <div className="faces__uploadResult" role="status">
              <h4>Upload complete</h4>
              <p>
                {lastUploadedModel.name} · v{lastUploadedModel.version}
              </p>
              {lastUploadedModel.thumbnailDataUrl ? (
                <img
                  src={lastUploadedModel.thumbnailDataUrl}
                  alt={`${lastUploadedModel.name} thumbnail`}
                  className="faces__uploadThumbnail"
                />
              ) : (
                <div className="faceCard__placeholder">No thumbnail</div>
              )}
            </div>
          ) : null}
        </details>
      </div>

      {children}
      {studio ? (
        studio.open && avatarApi ? (
          <AvatarStudio avatarApi={avatarApi} onClose={studio.onClose} onAccepted={refreshModels} />
        ) : null
      ) : (
        <AvatarStudioLauncher avatarApi={avatarApi} onAccepted={refreshModels} />
      )}
    </section>
  );
}
