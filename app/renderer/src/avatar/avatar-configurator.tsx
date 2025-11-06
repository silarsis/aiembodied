import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type {
  AvatarBridge,
  AvatarDisplayMode,
  AvatarFaceDetail,
  AvatarFaceSummary,
  AvatarGenerationCandidateSummary,
  AvatarGenerationResult,
  AvatarModelSummary,
} from './types.js';
import { getPreloadApi } from '../preload-api.js';

type TabId = 'faces' | 'models';

type ModelUploadStatus = 'idle' | 'reading' | 'uploading' | 'success';
type BehaviorStatus = 'idle' | 'pending' | 'success' | 'error';

interface AvatarConfiguratorProps {
  avatarApi?: AvatarBridge;
  onActiveFaceChange?: (detail: AvatarFaceDetail | null) => void;
  onActiveModelChange?: (detail: AvatarModelSummary | null) => void;
  displayModePreference?: AvatarDisplayMode;
  onDisplayModePreferenceChange?: (mode: AvatarDisplayMode) => void;
}

function deriveName(file: File | null): string {
  if (!file) {
    return '';
  }

  const name = file.name.replace(/\.[^/.]+$/, '').trim();
  return name || 'New avatar face';
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

function truncateSha(value: string | null | undefined): string {
  if (!value) {
    return '—';
  }

  if (value.length <= 12) {
    return value;
  }

  return `${value.slice(0, 12)}…`;
}

export function AvatarConfigurator({
  avatarApi,
  onActiveFaceChange,
  onActiveModelChange,
  displayModePreference = 'sprites',
  onDisplayModePreferenceChange,
}: AvatarConfiguratorProps) {
  const [faces, setFaces] = useState<AvatarFaceSummary[]>([]);
  const [models, setModels] = useState<AvatarModelSummary[]>([]);
  const [activeFaceId, setActiveFaceId] = useState<string | null>(null);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [facesLoading, setFacesLoading] = useState(true);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [faceUploading, setFaceUploading] = useState(false);
  const [faceBusyId, setFaceBusyId] = useState<string | null>(null);
  const [modelBusyId, setModelBusyId] = useState<string | null>(null);
  const [faceError, setFaceError] = useState<string | null>(null);
  const [modelError, setModelError] = useState<string | null>(null);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [nameInput, setNameInput] = useState('');
  const [generation, setGeneration] = useState<AvatarGenerationResult | null>(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState<string | null>(null);
  const [modelFile, setModelFile] = useState<File | null>(null);
  const [modelNameInput, setModelNameInput] = useState('');
  const [modelUploadStatus, setModelUploadStatus] = useState<ModelUploadStatus>('idle');
  const [modelUploadError, setModelUploadError] = useState<string | null>(null);
  const [lastUploadedModel, setLastUploadedModel] = useState<AvatarModelSummary | null>(null);
  const [behaviorStatus, setBehaviorStatus] = useState<BehaviorStatus>('idle');
  const [behaviorMessage, setBehaviorMessage] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabId>('faces');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const modelFileInputRef = useRef<HTMLInputElement | null>(null);
  const availabilityLogRef = useRef<'available' | 'missing' | null>(null);
  const isFaceBridgeAvailable = Boolean(avatarApi);
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

  const formattedFaces = useMemo(() => {
    return faces.map((face) => ({
      ...face,
      createdLabel: formatTimestamp(face.createdAt),
    }));
  }, [faces]);

  const formattedModels = useMemo(() => {
    return models.map((model) => ({
      ...model,
      createdLabel: formatTimestamp(model.createdAt),
    }));
  }, [models]);

  const refreshFaces = useCallback(async () => {
    if (!avatarApi) {
      setFaces([]);
      setActiveFaceId(null);
      onActiveFaceChange?.(null);
      setFacesLoading(false);
      setFaceError('Avatar configuration bridge is unavailable.');
      return;
    }

    setFacesLoading(true);
    setFaceError(null);

    try {
      const [list, active] = await Promise.all([avatarApi.listFaces(), avatarApi.getActiveFace()]);
      setFaces(list);
      setActiveFaceId(active?.id ?? null);
      onActiveFaceChange?.(active ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load avatar faces.';
      setFaceError(message);
    } finally {
      setFacesLoading(false);
      setFaceBusyId(null);
      setFaceUploading(false);
    }
  }, [avatarApi, onActiveFaceChange]);

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
    let cancelled = false;
    (async () => {
      await refreshFaces();
      await refreshModels();
      if (cancelled) {
        return;
      }

      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      if (modelFileInputRef.current) {
        modelFileInputRef.current.value = '';
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refreshFaces, refreshModels]);

  const handleFileChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    const nextFile = event.target.files?.[0] ?? null;
    setFile(nextFile);
    if (nextFile) {
      setNameInput((previous) => (previous.trim().length > 0 ? previous : deriveName(nextFile)));
    }
  }, []);

  const handleNameChange = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setNameInput(event.target.value);
  }, []);

  const handleUpload = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!avatarApi) {
        setFaceError('Avatar configuration bridge is unavailable.');
        return;
      }

      if (!file) {
        setFaceError('Select an image to upload.');
        return;
      }

      if (!avatarApi.generateFace || !avatarApi.applyGeneratedFace) {
        setFaceError('Avatar generation is not available.');
        return;
      }

      setFaceUploading(true);
      setFaceError(null);

      void (async () => {
        try {
          const dataUrl = await fileToDataUrl(file);
          const name = nameInput.trim() || deriveName(file);
          const result = await avatarApi.generateFace({ name, imageDataUrl: dataUrl });
          setGeneration(result);
          setSelectedCandidateId(result.candidates[0]?.id ?? null);
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to upload avatar face.';
          setFaceError(message);
        } finally {
          setFaceUploading(false);
        }
      })();
    },
    [avatarApi, file, nameInput],
  );

  const handleSelectFace = useCallback(
    async (faceId: string) => {
      if (!avatarApi) {
        setFaceError('Avatar configuration bridge is unavailable.');
        return;
      }

      setFaceBusyId(faceId);
      setFaceError(null);
      try {
        const detail = await avatarApi.setActiveFace(faceId);
        setActiveFaceId(detail?.id ?? null);
        onActiveFaceChange?.(detail ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to activate avatar face.';
        setFaceError(message);
      } finally {
        setFaceBusyId(null);
      }
    },
    [avatarApi, onActiveFaceChange],
  );

  const handleDeleteFace = useCallback(
    async (faceId: string) => {
      if (!avatarApi) {
        setFaceError('Avatar configuration bridge is unavailable.');
        return;
      }

      setFaceBusyId(faceId);
      setFaceError(null);
      try {
        await avatarApi.deleteFace(faceId);
        if (activeFaceId === faceId) {
          onActiveFaceChange?.(null);
        }
        await refreshFaces();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete avatar face.';
        setFaceError(message);
      } finally {
        setFaceBusyId(null);
      }
    },
    [avatarApi, activeFaceId, onActiveFaceChange, refreshFaces],
  );

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
          setModelUploadStatus('success');
          setLastUploadedModel(result.model);
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

  const handleDisplayModeChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const value = event.target.value === 'vrm' ? 'vrm' : 'sprites';
      onDisplayModePreferenceChange?.(value);
    },
    [onDisplayModePreferenceChange],
  );

  const handleApplyGeneratedFace = useCallback(async () => {
    if (!avatarApi?.applyGeneratedFace) {
      setFaceError('Avatar generation is not available.');
      return;
    }

    if (!generation || !selectedCandidateId) {
      setFaceError('Select a generated avatar style before applying.');
      return;
    }

    setFaceUploading(true);
    setFaceError(null);
    try {
      const name = nameInput.trim() || (file ? deriveName(file) : 'New avatar face');
      await avatarApi.applyGeneratedFace(generation.generationId, selectedCandidateId, name);
      setGeneration(null);
      setSelectedCandidateId(null);
      setNameInput('');
      setFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
      await refreshFaces();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to apply generated avatar face.';
      setFaceError(message);
    } finally {
      setFaceUploading(false);
    }
  }, [avatarApi, file, generation, nameInput, refreshFaces, selectedCandidateId]);

  const handleCancelGeneration = useCallback(() => {
    setGeneration(null);
    setSelectedCandidateId(null);
  }, []);

  const handleTestWave = useCallback(async () => {
    const bridge = getPreloadApi();
    const emitDetection = bridge?.camera?.emitDetection;
    const triggerBehaviorCue = avatarApi?.triggerBehaviorCue;

    if (!emitDetection && !triggerBehaviorCue) {
      setBehaviorStatus('error');
      setBehaviorMessage('Behavior testing bridge is unavailable.');
      return;
    }

    setBehaviorStatus('pending');
    setBehaviorMessage(null);
    try {
      if (emitDetection) {
        await emitDetection({ cue: 'greet_face', provider: 'configurator-test', confidence: 1 });
      } else if (triggerBehaviorCue) {
        await triggerBehaviorCue('greet_face');
      }
      setBehaviorStatus('success');
      setBehaviorMessage('Wave gesture triggered.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to trigger wave gesture.';
      setBehaviorStatus('error');
      setBehaviorMessage(message);
    }
  }, [avatarApi]);

  const tabButtons: Array<{ id: TabId; label: string }> = useMemo(
    () => [
      { id: 'faces', label: 'Sprite faces' },
      { id: 'models', label: 'VRM models' },
    ],
    [],
  );

  const displayMode = displayModePreference ?? 'sprites';
  const modelUploadDisabled = !isModelBridgeAvailable || modelUploadStatus === 'reading' || modelUploadStatus === 'uploading';
  const behaviorPending = behaviorStatus === 'pending';
  const behaviorBridgeAvailable = Boolean(getPreloadApi()?.camera?.emitDetection || avatarApi?.triggerBehaviorCue);

  return (
    <section className="kiosk__faces" aria-labelledby="kiosk-faces-title">
      <div className="faces__header">
        <div>
          <h2 id="kiosk-faces-title">Avatar configuration</h2>
          <p className="kiosk__helper">
            Upload sprite faces or VRM models, then choose how the kiosk renders your assistant. Changes apply immediately after
            activation.
          </p>
        </div>
        {generalError ? (
          <p className="kiosk__error" role="alert">
            {generalError}
          </p>
        ) : null}
      </div>

      <div className="faces__modeSelector" role="group" aria-labelledby="display-mode-heading">
        <div className="faces__modeSelectorControls">
          <h3 id="display-mode-heading">Display mode</h3>
          <div className="faces__modeSelectorOptions" role="radiogroup" aria-label="Avatar display mode">
            <label className="faces__modeOption">
              <input
                type="radio"
                name="avatar-display-mode"
                value="sprites"
                checked={displayMode === 'sprites'}
                onChange={handleDisplayModeChange}
                disabled={!isFaceBridgeAvailable}
              />
              <span>2D sprites</span>
            </label>
            <label className="faces__modeOption">
              <input
                type="radio"
                name="avatar-display-mode"
                value="vrm"
                checked={displayMode === 'vrm'}
                onChange={handleDisplayModeChange}
                disabled={!isModelBridgeAvailable || formattedModels.length === 0}
              />
              <span>3D VRM</span>
            </label>
          </div>
        </div>
        <div className="faces__behaviorTester">
          <button
            type="button"
            onClick={handleTestWave}
            disabled={behaviorPending || !behaviorBridgeAvailable}
            aria-busy={behaviorPending}
          >
            {behaviorPending ? 'Triggering wave…' : 'Test wave gesture'}
          </button>
          {behaviorMessage ? (
            <p
              className={behaviorStatus === 'error' ? 'kiosk__error' : 'kiosk__info'}
              role={behaviorStatus === 'error' ? 'alert' : 'status'}
            >
              {behaviorMessage}
            </p>
          ) : null}
        </div>
      </div>

      <div className="faces__tabs">
        <div className="faces__tablist" role="tablist" aria-label="Avatar asset types">
          {tabButtons.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`avatar-tab-${tab.id}`}
              aria-controls={`avatar-panel-${tab.id}`}
              aria-selected={activeTab === tab.id}
              data-active={activeTab === tab.id ? 'true' : 'false'}
              className="faces__tabButton"
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <section
          role="tabpanel"
          id="avatar-panel-faces"
          aria-labelledby="avatar-tab-faces"
          data-state={activeTab === 'faces' ? 'active' : 'inactive'}
          className="faces__panel"
        >
          <form className="faces__form" onSubmit={handleUpload} aria-label="Upload new avatar face">
            <label className="faces__field">
              <span>Face image</span>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                disabled={!isFaceBridgeAvailable || faceUploading}
                required
              />
            </label>
            <label className="faces__field">
              <span>Display name</span>
              <input
                type="text"
                value={nameInput}
                onChange={handleNameChange}
                placeholder="Cheerful assistant"
                disabled={!isFaceBridgeAvailable || faceUploading}
              />
            </label>
            <button
              className="faces__submit"
              type="submit"
              disabled={!isFaceBridgeAvailable || faceUploading || !file}
            >
              {faceUploading ? 'Generating…' : 'Generate avatar'}
            </button>
          </form>

          {generation ? (
            <section className="faces__selection" aria-label="Choose generated avatar">
              <h3>Choose your avatar style</h3>
              <div className="faces__options" role="radiogroup" aria-label="Avatar generation options">
                {generation.candidates.map((candidate: AvatarGenerationCandidateSummary) => (
                  <label key={candidate.id} className="faces__option">
                    <span className="visually-hidden">Select avatar candidate</span>
                    <input
                      type="radio"
                      name="avatar-option"
                      value={candidate.id}
                      checked={selectedCandidateId === candidate.id}
                      onChange={() => setSelectedCandidateId(candidate.id)}
                      disabled={faceUploading}
                    />
                    <div className="faces__optionCard">
                      <div className="faces__optionPreview" aria-hidden="true">
                        {candidate.previewDataUrl ? (
                          <img src={candidate.previewDataUrl} alt="" />
                        ) : (
                          <div className="faceCard__placeholder">No preview</div>
                        )}
                      </div>
                      <div className="faces__optionInfo">
                        <strong>{candidate.strategy === 'responses' ? 'Responses (AI)' : 'Images (Edit)'}</strong>
                        <span>
                          {candidate.componentsCount} components · {candidate.qualityScore}%
                        </span>
                      </div>
                    </div>
                  </label>
                ))}
              </div>
              <div className="faces__selectionActions">
                <button type="button" onClick={handleCancelGeneration} disabled={faceUploading}>
                  Cancel
                </button>
                <button type="button" onClick={handleApplyGeneratedFace} disabled={faceUploading || !selectedCandidateId}>
                  Apply
                </button>
              </div>
            </section>
          ) : null}

          {faceError ? (
            <p role="alert" className="kiosk__error">
              {faceError}
            </p>
          ) : null}
          {faceUploading ? <p className="kiosk__info">Processing avatar assets…</p> : null}
          {facesLoading ? <p className="kiosk__info">Loading stored faces…</p> : null}

          <div className="faces__grid" role="list">
            {formattedFaces.map((face) => {
              const isActive = face.id === activeFaceId;
              const busy = faceBusyId === face.id || faceUploading;
              return (
                <article key={face.id} className="faceCard" data-active={isActive ? 'true' : 'false'} role="listitem">
                  <div className="faceCard__preview" aria-hidden="true">
                    {face.previewDataUrl ? <img src={face.previewDataUrl} alt="" loading="lazy" /> : <div className="faceCard__placeholder">No preview</div>}
                  </div>
                  <div className="faceCard__info">
                    <h3>{face.name}</h3>
                    <p className="faceCard__meta">Added {face.createdLabel}</p>
                  </div>
                  <div className="faceCard__actions">
                    <button type="button" onClick={() => handleSelectFace(face.id)} disabled={busy || !isFaceBridgeAvailable}>
                      {isActive ? 'Active' : 'Use face'}
                    </button>
                    <button type="button" onClick={() => handleDeleteFace(face.id)} disabled={busy || !isFaceBridgeAvailable}>
                      Delete
                    </button>
                  </div>
                </article>
              );
            })}
          </div>

          {!facesLoading && formattedFaces.length === 0 ? (
            <p className="kiosk__info">No avatar faces stored yet. Upload an image to get started.</p>
          ) : null}
        </section>

        <section
          role="tabpanel"
          id="avatar-panel-models"
          aria-labelledby="avatar-tab-models"
          data-state={activeTab === 'models' ? 'active' : 'inactive'}
          className="faces__panel"
        >
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
              <h3>Upload complete</h3>
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

          {modelError ? (
            <p role="alert" className="kiosk__error">
              {modelError}
            </p>
          ) : null}
          {modelsLoading ? <p className="kiosk__info">Loading stored VRM models…</p> : null}

          <div className="faces__grid" role="list">
            {formattedModels.map((model) => {
              const isActive = model.id === activeModelId;
              const busy = modelBusyId === model.id || modelUploadStatus === 'uploading';
              return (
                <article key={model.id} className="faceCard" data-active={isActive ? 'true' : 'false'} role="listitem">
                  <div className="faceCard__preview" aria-hidden="true">
                    {model.thumbnailDataUrl ? (
                      <img src={model.thumbnailDataUrl} alt="" loading="lazy" />
                    ) : (
                      <div className="faceCard__placeholder">No thumbnail</div>
                    )}
                  </div>
                  <div className="faceCard__info">
                    <h3>{model.name}</h3>
                    <dl className="faceCard__metaList">
                      <div>
                        <dt>Version</dt>
                        <dd>{model.version || '—'}</dd>
                      </div>
                      <div>
                        <dt>Uploaded</dt>
                        <dd>{model.createdLabel}</dd>
                      </div>
                      <div>
                        <dt>Checksum</dt>
                        <dd>{truncateSha(model.fileSha)}</dd>
                      </div>
                    </dl>
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
        </section>
      </div>
    </section>
  );
}
