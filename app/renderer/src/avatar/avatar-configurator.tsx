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
  AvatarAnimationSummary,
  AvatarBridge,
  AvatarModelSummary,
  AvatarPoseSummary,
} from './types.js';
import { generateVrmThumbnail } from './thumbnail-generator.js';

type ModelUploadStatus = 'idle' | 'reading' | 'uploading' | 'success';
type VrmaGenerationStatus = 'idle' | 'pending' | 'success' | 'error';
type PoseGenerationStatus = 'idle' | 'pending' | 'success' | 'error';

interface AvatarConfiguratorProps {
  avatarApi?: AvatarBridge;
  onActiveModelChange?: (detail: AvatarModelSummary | null) => void;
  onAnimationChange?: () => void;
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
  onActiveModelChange,
  onAnimationChange,
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
  const [vrmaPrompt, setVrmaPrompt] = useState('');
  const [vrmaStatus, setVrmaStatus] = useState<VrmaGenerationStatus>('idle');
  const [vrmaMessage, setVrmaMessage] = useState<string | null>(null);
  const [vrmaResultName, setVrmaResultName] = useState<string | null>(null);
  const [animations, setAnimations] = useState<AvatarAnimationSummary[]>([]);
  const [animationsLoading, setAnimationsLoading] = useState(false);
  const [animationError, setAnimationError] = useState<string | null>(null);
  const [animationBusyId, setAnimationBusyId] = useState<string | null>(null);
  const [renamingAnimationId, setRenamingAnimationId] = useState<string | null>(null);
  const [renamingAnimationName, setRenamingAnimationName] = useState('');
  const [posePrompt, setPosePrompt] = useState('');
  const [poseStatus, setPoseStatus] = useState<PoseGenerationStatus>('idle');
  const [poseMessage, setPoseMessage] = useState<string | null>(null);
  const [poses, setPoses] = useState<AvatarPoseSummary[]>([]);
  const [posesLoading, setPostsLoading] = useState(false);
  const [poseError, setPoseError] = useState<string | null>(null);
  const [poseBusyId, setPositBusyId] = useState<string | null>(null);
  const modelFileInputRef = useRef<HTMLInputElement | null>(null);
  const availabilityLogRef = useRef<'available' | 'missing' | null>(null);
  const isModelBridgeAvailable = Boolean(avatarApi?.listModels && avatarApi?.uploadModel);
  const isAnimationBridgeAvailable = Boolean(avatarApi?.generateAnimation);
  const isPoseBridgeAvailable = Boolean(avatarApi?.generatePose && avatarApi?.listPoses);

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

  const refreshAnimations = useCallback(async () => {
    if (!avatarApi?.listAnimations) {
      setAnimations([]);
      setAnimationsLoading(false);
      setAnimationError('VRMA configuration bridge is unavailable.');
      return;
    }

    setAnimationsLoading(true);
    setAnimationError(null);

    try {
      const list = await avatarApi.listAnimations();
      setAnimations(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load VRMA animations.';
      setAnimationError(message);
    } finally {
      setAnimationsLoading(false);
    }
  }, [avatarApi]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refreshModels();
      await refreshAnimations();
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
  }, [refreshModels, refreshAnimations]);

  const handleDeleteAnimation = useCallback(
    async (animationId: string) => {
      if (!avatarApi?.deleteAnimation) {
        setAnimationError('VRMA configuration bridge is unavailable.');
        return;
      }

      setAnimationBusyId(animationId);
      setAnimationError(null);
      try {
        await avatarApi.deleteAnimation(animationId);
        await refreshAnimations();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete VRMA animation.';
        setAnimationError(message);
      } finally {
        setAnimationBusyId(null);
      }
    },
    [avatarApi, refreshAnimations],
  );

  const handleStartRenameAnimation = useCallback((animationId: string, currentName: string) => {
    setRenamingAnimationId(animationId);
    setRenamingAnimationName(currentName);
  }, []);

  const handleCancelRenameAnimation = useCallback(() => {
    setRenamingAnimationId(null);
    setRenamingAnimationName('');
  }, []);

  const handleRenameAnimation = useCallback(
    async (animationId: string) => {
      if (!avatarApi?.renameAnimation) {
        setAnimationError('VRMA configuration bridge is unavailable.');
        return;
      }

      const newName = renamingAnimationName.trim();
      if (!newName) {
        setAnimationError('Animation name cannot be empty.');
        return;
      }

      setAnimationBusyId(animationId);
      setAnimationError(null);
      try {
        const updated = await avatarApi.renameAnimation(animationId, newName);
        setAnimations((prev) =>
          prev.map((a) => (a.id === animationId ? updated : a)),
        );
        setRenamingAnimationId(null);
        setRenamingAnimationName('');
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to rename VRMA animation.';
        setAnimationError(message);
      } finally {
        setAnimationBusyId(null);
      }
    },
    [avatarApi, renamingAnimationName],
  );

  const handleVrmaPromptChange = useCallback((event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    setVrmaPrompt(event.target.value);
    if (vrmaStatus === 'error') {
      setVrmaStatus('idle');
      setVrmaMessage(null);
    }
  }, [vrmaStatus]);

  const handleGenerateAnimation = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!avatarApi?.generateAnimation) {
        setVrmaStatus('error');
        setVrmaMessage('VRMA generation is unavailable.');
        return;
      }

      const prompt = vrmaPrompt.trim();
      if (!prompt) {
        setVrmaStatus('error');
        setVrmaMessage('Enter a prompt describing the animation.');
        return;
      }

      setVrmaStatus('pending');
      setVrmaMessage(null);
      setVrmaResultName(null);

      void (async () => {
        try {
          const result = await avatarApi.generateAnimation({ prompt });
          setVrmaStatus('success');
          setVrmaResultName(result.animation.name);
          setVrmaPrompt('');
          await refreshAnimations();
          onAnimationChange?.();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to generate VRMA animation.';
          setVrmaStatus('error');
          setVrmaMessage(message);
        }
      })();
    },
    [avatarApi, vrmaPrompt, onAnimationChange, refreshAnimations],
  );

  const refreshPoses = useCallback(async () => {
    if (!avatarApi?.listPoses) {
      setPoses([]);
      setPostsLoading(false);
      setPoseError('Pose service is unavailable.');
      return;
    }

    setPostsLoading(true);
    setPoseError(null);

    try {
      const list = await avatarApi.listPoses();
      setPoses(list);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load poses.';
      setPoseError(message);
    } finally {
      setPostsLoading(false);
    }
  }, [avatarApi]);

  useEffect(() => {
    void refreshPoses();
  }, [refreshPoses]);

  const handlePosePromptChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    setPosePrompt(event.target.value);
    if (poseStatus === 'error') {
      setPoseStatus('idle');
      setPoseMessage(null);
    }
  }, [poseStatus]);

  const handleGeneratePose = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!avatarApi?.generatePose) {
        setPoseStatus('error');
        setPoseMessage('Pose generation is unavailable.');
        return;
      }

      const prompt = posePrompt.trim();
      if (!prompt) {
        setPoseStatus('error');
        setPoseMessage('Enter a prompt describing the pose.');
        return;
      }

      setPoseStatus('pending');
      setPoseMessage(null);

      void (async () => {
        try {
          await avatarApi.generatePose({ prompt });
          setPoseStatus('success');
          setPosePrompt('');
          await refreshPoses();
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to generate pose.';
          setPoseStatus('error');
          setPoseMessage(message);
        }
      })();
    },
    [avatarApi, posePrompt, refreshPoses],
  );

  const handleDeletePose = useCallback(
    (poseId: string) => {
      if (!avatarApi?.deletePose) {
        setPoseError('Pose service is unavailable.');
        return;
      }

      setPositBusyId(poseId);
      setPoseError(null);

      void (async () => {
        try {
          await avatarApi.deletePose(poseId);
          setPoses((prev) => prev.filter((p) => p.id !== poseId));
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Failed to delete pose.';
          setPoseError(message);
        } finally {
          setPositBusyId(null);
        }
      })();
    },
    [avatarApi],
  );

  const modelUploadDisabled = !isModelBridgeAvailable || modelUploadStatus === 'reading' || modelUploadStatus === 'uploading';
  const vrmaPending = vrmaStatus === 'pending';
  const posePending = poseStatus === 'pending';

  return (
    <section className="kiosk__faces" aria-labelledby="kiosk-faces-title">
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
      </div>

      {/* Animations Section */}
      <div className="faces__section">
        <h3 className="faces__heading">Animations</h3>

        {animationError ? (
          <p role="alert" className="kiosk__error">
            {animationError}
          </p>
        ) : null}
        {animationsLoading ? <p className="kiosk__info">Loading stored animations…</p> : null}

        <div className="faces__grid faces__grid--compact" role="list">
          {animations.map((animation) => {
            const busy = animationBusyId === animation.id;
            const isRenaming = renamingAnimationId === animation.id;

            return (
              <article key={animation.id} className="faceCard faceCard--compact" role="listitem">
                <div className="faceCard__info">
                  {isRenaming ? (
                    <div className="faceCard__renameForm">
                      <input
                        type="text"
                        value={renamingAnimationName}
                        onChange={(e) => setRenamingAnimationName(e.target.value)}
                        placeholder="Animation name"
                        disabled={busy}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            handleRenameAnimation(animation.id);
                          } else if (e.key === 'Escape') {
                            handleCancelRenameAnimation();
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <h4>{animation.name}</h4>
                  )}
                  <dl className="faceCard__metaList faceCard__metaList--compact">
                    <div>
                      <dt>Duration</dt>
                      <dd>{animation.duration !== null ? `${(animation.duration).toFixed(1)}s` : '—'}</dd>
                    </div>
                  </dl>
                </div>
                <div className="faceCard__actions">
                  {isRenaming ? (
                    <>
                      <button
                        type="button"
                        onClick={() => handleRenameAnimation(animation.id)}
                        disabled={busy || !renamingAnimationName.trim()}
                      >
                        Save
                      </button>
                      <button type="button" onClick={handleCancelRenameAnimation} disabled={busy}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => handleStartRenameAnimation(animation.id, animation.name)}
                        disabled={busy}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        onClick={() => handleDeleteAnimation(animation.id)}
                        disabled={busy}
                      >
                        Delete
                      </button>
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>

        {!animationsLoading && animations.length === 0 ? (
          <p className="kiosk__info">No VRMA animations stored yet. Generate or upload an animation to get started.</p>
        ) : null}

        <form className="faces__form" onSubmit={handleGenerateAnimation} aria-label="Generate VRMA animation">
          <label className="faces__field">
            <span>Animation prompt</span>
            <textarea
              value={vrmaPrompt}
              onChange={handleVrmaPromptChange}
              placeholder="Wave hello, then return to idle stance."
              disabled={!isAnimationBridgeAvailable || vrmaPending}
              rows={2}
            />
          </label>
          <button type="submit" disabled={!isAnimationBridgeAvailable || vrmaPending || vrmaPrompt.trim().length === 0} className="faces__submit">
            {vrmaPending ? 'Generating…' : 'Generate Animation'}
          </button>
        </form>

        {vrmaMessage ? (
          <p className={vrmaStatus === 'error' ? 'kiosk__error' : 'kiosk__info'} role={vrmaStatus === 'error' ? 'alert' : 'status'}>
            {vrmaMessage}
          </p>
        ) : null}
        {vrmaStatus === 'success' && vrmaResultName ? (
          <p className="kiosk__info" role="status">
            Generated animation saved as {vrmaResultName}.
          </p>
        ) : null}
      </div>

      {/* Poses Section */}
      <div className="faces__section">
        <h3 className="faces__heading">Poses</h3>

        {poseError ? (
          <p role="alert" className="kiosk__error">
            {poseError}
          </p>
        ) : null}
        {posesLoading ? <p className="kiosk__info">Loading stored poses…</p> : null}

        <div className="faces__grid faces__grid--compact" role="list">
          {poses.map((pose) => {
            const busy = poseBusyId === pose.id;
            return (
              <article key={pose.id} className="faceCard faceCard--compact" role="listitem">
                <div className="faceCard__info">
                  <h4>{pose.name}</h4>
                </div>
                <div className="faceCard__actions">
                  <button
                    type="button"
                    onClick={() => handleDeletePose(pose.id)}
                    disabled={busy || !isPoseBridgeAvailable}
                  >
                    Delete
                  </button>
                </div>
              </article>
            );
          })}
        </div>

        {!posesLoading && poses.length === 0 ? (
          <p className="kiosk__info">No VRM poses stored yet. Generate a pose to get started.</p>
        ) : null}

        <form className="faces__form" onSubmit={handleGeneratePose} aria-label="Generate VRM pose">
          <label className="faces__field">
            <span>Pose prompt</span>
            <textarea
              value={posePrompt}
              onChange={handlePosePromptChange}
              placeholder="Confident power stance with arms crossed."
              disabled={!isPoseBridgeAvailable || posePending}
              rows={2}
            />
          </label>
          <button type="submit" disabled={!isPoseBridgeAvailable || posePending || posePrompt.trim().length === 0} className="faces__submit">
            {posePending ? 'Generating…' : 'Generate Pose'}
          </button>
        </form>

        {poseMessage ? (
          <p className={poseStatus === 'error' ? 'kiosk__error' : 'kiosk__info'} role={poseStatus === 'error' ? 'alert' : 'status'}>
            {poseMessage}
          </p>
        ) : null}
      </div>
    </section>
  );
}
