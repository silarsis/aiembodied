import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';
import { createPortal } from 'react-dom';
import type {
  AvatarBridge,
  AvatarCharacterModelSummary,
  AvatarGenerationStatus,
  AvatarPoseSummary,
} from './types.js';
import { ExpandedImage } from './avatar-image-preview.js';
import { AvatarModelViewer } from './avatar-model-preview.js';
import { readAvatarReference, type AvatarReferenceImage } from './reference-image-upload.js';
import { useImageModels } from './use-image-models.js';
import { LoraPicker } from './lora-picker.js';
import { useCharacterModels } from './use-character-models.js';

type Panel = 'describe' | 'image' | 'model';
type StageView = 'image' | 'model' | 'compare';
type Mode = 'new-character' | 'restyle';

const RUNNING: ReadonlySet<AvatarGenerationStatus['status']> = new Set([
  'queued',
  'concept',
  'meshing',
  'rigging',
  'texturing',
  'packaging',
]);
const BUILDING: ReadonlySet<AvatarGenerationStatus['status']> = new Set([
  'meshing',
  'rigging',
  'texturing',
  'packaging',
]);

const BUILD_STEPS: Record<Mode, { label: string; stages: AvatarGenerationStatus['status'][] }[]> = {
  'new-character': [
    { label: 'Checking the face', stages: ['queued'] },
    { label: 'Generating 3D geometry', stages: ['meshing'] },
    { label: 'Rigging and fitting the face', stages: ['rigging'] },
  ],
  restyle: [
    { label: 'Checking the image', stages: ['queued'] },
    { label: 'Repainting textures', stages: ['texturing'] },
    { label: 'Packaging the VRM', stages: ['packaging'] },
  ],
};

/** A take's image exists once its concept phase finished; afterwards it can be built or rebuilt. */
const hasImage = (job: AvatarGenerationStatus) => Boolean(job.previewDataUrl);
const isBuilding = (job: AvatarGenerationStatus) =>
  BUILDING.has(job.status) || (job.status === 'queued' && hasImage(job));
const modeOf = (job: AvatarGenerationStatus): Mode => job.mode ?? 'new-character';

function formatDuration(seconds?: number | null): string | null {
  if (seconds == null) return null;
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes} min ${seconds % 60} s` : `${seconds} s`;
}

function errorText(err: unknown, fallback: string): string {
  return err instanceof Error ? err.message : fallback;
}

function ModelSelect({
  id,
  label,
  models,
  selectedId,
  disabled,
  onSelect,
}: {
  id: string;
  label: string;
  models: AvatarCharacterModelSummary[];
  selectedId: string | null;
  disabled: boolean;
  onSelect(id: string): void;
}) {
  const selected = models.find((model) => model.id === selectedId);
  const unavailable = models.find((model) => !model.available && model.unavailableReason);
  return (
    <div className="avatarStudio__field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={selectedId ?? ''}
        disabled={disabled}
        onChange={(event) => onSelect(event.target.value)}
      >
        {!selectedId ? <option value="">No usable option found</option> : null}
        {models.map((model) => (
          <option key={model.id} value={model.id} disabled={!model.available}>
            {model.name}
            {model.available ? '' : ' (unavailable)'}
          </option>
        ))}
      </select>
      {selected?.description ? <small>{selected.description}</small> : null}
      {!selected && unavailable ? (
        <small className="avatarStudio__warnText">{unavailable.unavailableReason}</small>
      ) : null}
    </div>
  );
}

export function AvatarStudio({
  avatarApi,
  onClose,
  onAccepted,
  pollIntervalMs = 2000,
}: {
  avatarApi: AvatarBridge;
  onClose(): void;
  onAccepted?: (vrmId: string) => void | Promise<void>;
  pollIntervalMs?: number;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [jobs, setJobs] = useState<AvatarGenerationStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selectedRef = useRef<string | null>(null);
  const jobsRef = useRef<AvatarGenerationStatus[]>([]);
  useEffect(() => {
    selectedRef.current = selectedId;
  }, [selectedId]);
  const [panel, setPanel] = useState<Panel>('describe');
  const [view, setView] = useState<StageView>('image');
  const [mode, setMode] = useState<Mode>('new-character');
  const [source, setSource] = useState<'text' | 'upload'>('text');
  const [prompt, setPrompt] = useState('');
  const [reference, setReference] = useState<AvatarReferenceImage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [enlarged, setEnlarged] = useState<string | null>(null);
  const [poses, setPoses] = useState<AvatarPoseSummary[]>([]);
  const [models, setModels] = useState<
    Record<string, { key: string; data?: ArrayBuffer; error?: string }>
  >({});
  const [modelAttempt, setModelAttempt] = useState(0);
  const imageModels = useImageModels(avatarApi, true);
  const characterModels = useCharacterModels(avatarApi, true);
  const usingUpload = mode === 'new-character' && source === 'upload';

  const takes = jobs;
  const selected = takes.find((job) => job.jobId === selectedId) ?? null;
  const numberOf = (job: AvatarGenerationStatus) => job.takeNumber ?? takes.indexOf(job) + 1;
  const selectedNumber = selected ? numberOf(selected) : 0;
  const anyRunning = takes.some((job) => RUNNING.has(job.status));

  useEffect(() => {
    const element = dialog.current;
    element?.showModal?.();
    return () => element?.close?.();
  }, []);

  const refresh = useCallback(async () => {
    if (!avatarApi.listAvatarGenerationJobs) return [];
    const next = await avatarApi.listAvatarGenerationJobs();
    // When the take being viewed finishes building, show it beside its image.
    const id = selectedRef.current;
    const before = jobsRef.current.find((job) => job.jobId === id);
    const after = next.find((job) => job.jobId === id);
    if (before && after && before.status !== 'completed' && after.status === 'completed') {
      setPanel('model');
      setView('compare');
    }
    jobsRef.current = next;
    setJobs(next);
    return next;
  }, [avatarApi]);

  useEffect(() => {
    void Promise.resolve()
      .then(refresh)
      .then((next) => {
        const latest = next.at(-1);
        if (!latest) return;
        setSelectedId(latest.jobId);
        setPanel(latest.status === 'completed' || isBuilding(latest) ? 'model' : 'image');
        setView(latest.status === 'completed' ? 'compare' : 'image');
        if (latest.prompt && latest.source !== 'upload') setPrompt(latest.prompt);
      })
      .catch((err: unknown) => setError(errorText(err, 'Could not load your avatar takes.')));
    void avatarApi
      .listPoses?.()
      .then((list) =>
        setPoses([...list].sort((a, b) => Number(Boolean(b.builtIn)) - Number(Boolean(a.builtIn)))),
      )
      .catch(() => setPoses([]));
  }, [avatarApi, refresh]);

  useEffect(() => {
    if (!anyRunning) return undefined;
    const timer = setInterval(() => {
      void refresh().catch((err: unknown) =>
        setError(errorText(err, 'Lost track of the avatar generation.')),
      );
    }, pollIntervalMs);
    return () => clearInterval(timer);
  }, [anyRunning, pollIntervalMs, refresh]);

  // Load each finished candidate once per build, so switching takes is instant.
  const selectedModelKey = selected
    ? `${selected.jobId}:${selected.buildSeconds ?? ''}:${modelAttempt}`
    : null;
  useEffect(() => {
    if (!selected || selected.status !== 'completed' || !selectedModelKey) return;
    if (models[selected.jobId]?.key === selectedModelKey) return;
    let cancelled = false;
    const jobId = selected.jobId;
    avatarApi
      .loadGeneratedAvatarPreview(jobId)
      .then((data) => {
        if (!cancelled)
          setModels((current) => ({ ...current, [jobId]: { key: selectedModelKey, data } }));
      })
      .catch((err: unknown) => {
        if (!cancelled)
          setModels((current) => ({
            ...current,
            [jobId]: {
              key: selectedModelKey,
              error: errorText(err, 'Could not load the finished avatar.'),
            },
          }));
      });
    return () => {
      cancelled = true;
    };
  }, [avatarApi, selected, selectedModelKey, models]);

  const run = async (label: string, action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (err) {
      setError(errorText(err, label));
      await refresh().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  const selectTake = (job: AvatarGenerationStatus) => {
    setSelectedId(job.jobId);
    setError(null);
    if (job.prompt && job.source !== 'upload') setPrompt(job.prompt);
    if (job.mode) setMode(job.mode);
    if (job.status === 'completed') {
      setPanel('model');
      setView('compare');
    } else {
      setPanel(isBuilding(job) ? 'model' : 'image');
      setView('image');
    }
  };

  const generate = () =>
    run('Could not start image generation.', async () => {
      const job = await avatarApi.generateAvatar({
        prompt: prompt.trim(),
        mode,
        ...(usingUpload && reference ? { referenceImage: reference } : {}),
        ...(!usingUpload && imageModels.selectedModelId
          ? { imageModelId: imageModels.selectedModelId }
          : {}),
      });
      setSelectedId(job.jobId);
      setPanel('image');
      setView('image');
      setReference(null);
      await refresh();
    });

  const build = (job: AvatarGenerationStatus, acceptWarnings: boolean) =>
    run('Could not start building the avatar.', async () => {
      const confirmation = {
        ...(acceptWarnings ? { acceptWarnings: true } : {}),
        ...(modeOf(job) === 'new-character' && characterModels.selectedGeometryId
          ? { geometryModelId: characterModels.selectedGeometryId }
          : {}),
        ...(modeOf(job) === 'new-character' && characterModels.selectedRigId
          ? { rigModelId: characterModels.selectedRigId }
          : {}),
      };
      if (Object.keys(confirmation).length)
        await avatarApi.confirmAvatarConcept(job.jobId, confirmation);
      else await avatarApi.confirmAvatarConcept(job.jobId);
      const next = await refresh();
      const updated = next.find((item) => item.jobId === job.jobId);
      if (updated && (isBuilding(updated) || updated.status === 'completed')) setPanel('model');
    });

  const removeBackground = (job: AvatarGenerationStatus) =>
    run('Could not remove the background.', async () => {
      await avatarApi.removeAvatarBackground?.(job.jobId);
      await refresh();
    });

  const restoreBackground = (job: AvatarGenerationStatus) =>
    run('Could not restore the original image.', async () => {
      await avatarApi.restoreAvatarBackground?.(job.jobId);
      await refresh();
    });

  const cancel = (job: AvatarGenerationStatus) =>
    run('Could not cancel.', async () => {
      if (!avatarApi.cancelAvatarGeneration)
        throw new Error('Restart the app to enable cancelling.');
      await avatarApi.cancelAvatarGeneration(job.jobId);
      await refresh();
    });

  const discard = (job: AvatarGenerationStatus) =>
    run('Could not discard this take.', async () => {
      await avatarApi.rejectGeneratedAvatar(job.jobId);
      const next = await refresh();
      const latest = next.at(-1);
      setSelectedId(latest?.jobId ?? null);
      setPanel(latest ? 'image' : 'describe');
      setView('image');
    });

  const keep = (job: AvatarGenerationStatus, number: number) =>
    run('Could not save the avatar.', async () => {
      const { vrmId } = await avatarApi.acceptGeneratedAvatar(job.jobId);
      await onAccepted?.(vrmId);
      const next = await refresh();
      setSelectedId(next.at(-1)?.jobId ?? null);
      setPanel(next.length ? 'image' : 'describe');
      setView('image');
      setNotice(`Take ${number} is now your active avatar.`);
    });

  const handleUpload = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    setReference(null);
    setError(null);
    if (!file) return;
    try {
      setReference(await readAvatarReference(file));
    } catch (err) {
      setError(errorText(err, 'Could not read the image.'));
    }
  };

  const canGenerate =
    !busy &&
    !anyRunning &&
    (usingUpload
      ? Boolean(reference)
      : Boolean(prompt.trim()) &&
        !(imageModels.supported && (imageModels.loading || !imageModels.selectedModelId)));

  const buildSteps = selected ? BUILD_STEPS[modeOf(selected)] : [];
  const currentStep = selected
    ? selected.status === 'completed'
      ? buildSteps.length
      : buildSteps.findIndex((step) => step.stages.includes(selected.status))
    : -1;
  const percent = Math.round((selected?.progress ?? 0) * 100);
  const canShowModel = selected?.status === 'completed';
  const stageView: StageView = !selected ? 'image' : canShowModel ? view : 'image';
  const model = selected ? models[selected.jobId] : undefined;
  const modelReady = model?.key === selectedModelKey ? model : undefined;

  const progress =
    selected && RUNNING.has(selected.status) ? (
      <div className="avatarStudio__progress" role="status">
        <p>{selected.message ?? 'Working…'}</p>
        <progress max={100} value={percent} aria-label="Avatar generation progress">
          {percent}%
        </progress>
      </div>
    ) : null;

  const buildList =
    selected && (isBuilding(selected) || selected.status === 'completed') ? (
      <ol className="avatarStudio__steps" aria-label="Build steps">
        {buildSteps.map((step, index) => (
          <li
            key={step.label}
            className={
              index < currentStep ? 'is-done' : index === currentStep ? 'is-current' : undefined
            }
          >
            {step.label}
          </li>
        ))}
      </ol>
    ) : null;

  const warnings = selected?.warnings?.length ? (
    <section
      className="avatarCompatibilityWarning"
      role="alert"
      aria-label="Avatar compatibility warnings"
    >
      <strong>
        {selected.warningsAccepted
          ? 'Warnings accepted for this take.'
          : 'This image is outside the tested animation template.'}
      </strong>
      <ul>
        {selected.warnings.map((warning) => (
          <li key={warning.code}>{warning.message}</li>
        ))}
      </ul>
      {selected.warningsAccepted ? null : (
        <p>
          Regenerate, upload another image, or build anyway. Joint placement and animation may be
          distorted, and the build can still fail.
        </p>
      )}
    </section>
  ) : null;

  const imageElement = selected?.previewDataUrl ? (
    <button
      type="button"
      className="avatarStudio__image"
      aria-label={`Enlarge take ${selectedNumber} image`}
      aria-haspopup="dialog"
      onClick={() => setEnlarged(selected.previewDataUrl ?? null)}
    >
      <img src={selected.previewDataUrl} alt={`Take ${selectedNumber} concept`} />
    </button>
  ) : null;

  const viewer = modelReady?.data ? (
    <AvatarModelViewer
      key={selectedModelKey}
      modelData={modelReady.data}
      poses={poses}
      loadPose={avatarApi.loadPose ? (id) => avatarApi.loadPose(id) : undefined}
      label={`Take ${selectedNumber} 3D avatar`}
    />
  ) : modelReady?.error ? (
    <div className="avatarStudio__empty">
      <p role="alert" className="kiosk__error">
        {modelReady.error}
      </p>
      <button type="button" onClick={() => setModelAttempt((attempt) => attempt + 1)}>
        Retry loading
      </button>
    </div>
  ) : (
    <div className="avatarStudio__empty" role="status">
      Loading the finished avatar…
    </div>
  );

  let stage;
  if (!selected) {
    stage = (
      <div className="avatarStudio__empty">
        {takes.length
          ? 'Pick a take from the history below.'
          : 'Describe your character on the right, then generate an image.'}
      </div>
    );
  } else if (!imageElement) {
    stage = (
      <div className="avatarStudio__empty">
        {progress ??
          (selected.status === 'failed'
            ? `Image generation failed: ${selected.errorMessage ?? 'unknown error'}`
            : 'This take has no image.')}
      </div>
    );
  } else if (stageView === 'image') {
    stage = isBuilding(selected) ? (
      <div className="avatarStudio__split">
        {imageElement}
        <div className="avatarStudio__empty">
          <div className="avatarStudio__buildCard">
            {progress}
            {buildList}
          </div>
        </div>
      </div>
    ) : (
      imageElement
    );
  } else if (stageView === 'model') {
    stage = viewer;
  } else {
    stage = (
      <div className="avatarStudio__split">
        {imageElement}
        {viewer}
      </div>
    );
  }

  const describeForm = (
    <>
      <h3>Description</h3>
      <div className="avatarStudio__seg" role="group" aria-label="Creation method">
        {(
          [
            ['new-character', 'New 3D character'],
            ['restyle', 'Recolour the base avatar'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            aria-pressed={mode === value}
            onClick={() => {
              setMode(value);
              if (value === 'restyle') setSource('text');
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {mode === 'new-character' ? (
        <div className="avatarStudio__seg" role="group" aria-label="Start from">
          {(
            [
              ['text', 'Description'],
              ['upload', 'Upload an image'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={source === value}
              onClick={() => setSource(value)}
            >
              {label}
            </button>
          ))}
        </div>
      ) : null}
      {usingUpload ? (
        <div className="avatarStudio__field">
          <label htmlFor="avatar-studio-upload">Character reference image</label>
          <input
            id="avatar-studio-upload"
            type="file"
            accept="image/png,image/jpeg,image/webp"
            onChange={(event) => void handleUpload(event)}
          />
          <small>
            One front-facing, full-body character on a plain white background, arms and legs apart,
            eyes open and lips closed. PNG, JPEG or WebP up to 4096 × 4096 and 25 MB.
          </small>
        </div>
      ) : imageModels.supported ? (
        <div className="avatarStudio__field">
          <label htmlFor="avatar-studio-image-model">Image model</label>
          <select
            id="avatar-studio-image-model"
            value={imageModels.selectedModelId ?? ''}
            disabled={busy || imageModels.loading}
            onChange={(event) => void imageModels.select(event.target.value)}
          >
            {!imageModels.selectedModelId ? (
              <option value="">
                {imageModels.loading ? 'Finding installed models…' : 'No available image models'}
              </option>
            ) : null}
            {imageModels.models.map((item) => (
              <option key={item.id} value={item.id} disabled={!item.available}>
                {item.name}
                {item.available ? '' : ' (unavailable)'}
              </option>
            ))}
          </select>
          {imageModels.error ? (
            <small className="avatarStudio__warnText">{imageModels.error}</small>
          ) : null}
        </div>
      ) : null}
      {!usingUpload && imageModels.supported ? (
        <LoraPicker
          api={avatarApi}
          selection={imageModels}
          disabled={busy || imageModels.loading}
          onChange={(choices) => void imageModels.setLoras(choices)}
          onRefresh={imageModels.refresh}
        />
      ) : null}
      <div className="avatarStudio__field">
        <label htmlFor="avatar-studio-prompt">
          {usingUpload ? 'Avatar name (optional)' : 'Avatar description'}
        </label>
        <textarea
          id="avatar-studio-prompt"
          rows={5}
          maxLength={1000}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={
            usingUpload
              ? 'Name this avatar'
              : 'Swept-back auburn hair, rounded face, sage green explorer jumpsuit, tan boots'
          }
        />
        {!usingUpload && mode === 'new-character' ? (
          <small>
            One adult humanoid with short or swept-back hair and clearly separated limbs. Loose
            garments and long hair aren’t supported yet.
          </small>
        ) : null}
      </div>
      <button
        type="button"
        className="avatarStudio__primary"
        disabled={!canGenerate}
        onClick={() => void generate()}
      >
        {usingUpload ? 'Use this image' : takes.length ? 'Generate a new take' : 'Generate image'}
      </button>
      {anyRunning ? <small>Wait for the current job to finish or cancel it first.</small> : null}
    </>
  );

  const characterSelectors =
    selected && modeOf(selected) === 'new-character' && characterModels.supported ? (
      <fieldset className="avatarStudio__models" disabled={busy || isBuilding(selected)}>
        <legend>Turn into 3D with</legend>
        <ModelSelect
          id="avatar-studio-geometry-model"
          label="3D model"
          models={characterModels.geometry}
          selectedId={characterModels.selectedGeometryId}
          disabled={characterModels.loading}
          onSelect={(id) => void characterModels.select('geometry', id)}
        />
        <ModelSelect
          id="avatar-studio-rig-model"
          label="Rig and animation"
          models={characterModels.rig}
          selectedId={characterModels.selectedRigId}
          disabled={characterModels.loading}
          onSelect={(id) => void characterModels.select('rig', id)}
        />
        <button
          type="button"
          className="avatarStudio__link"
          onClick={() => void characterModels.refresh()}
        >
          Refresh models
        </button>
        {characterModels.error ? (
          <small className="avatarStudio__warnText">{characterModels.error}</small>
        ) : null}
      </fieldset>
    ) : null;

  const buildBlocked =
    selected &&
    modeOf(selected) === 'new-character' &&
    characterModels.supported &&
    !characterModels.loading &&
    (!characterModels.selectedGeometryId || !characterModels.selectedRigId);

  const buildButton = (job: AvatarGenerationStatus) => {
    if (!hasImage(job)) return null;
    if (isBuilding(job))
      return (
        <button type="button" onClick={() => void cancel(job)} disabled={busy}>
          Cancel build
        </button>
      );
    if (RUNNING.has(job.status)) return null;
    const unaccepted = Boolean(job.warnings?.length) && !job.warningsAccepted;
    const rebuild = job.status !== 'awaiting_confirmation';
    return (
      <button
        type="button"
        className={unaccepted ? 'avatarStudio__warnButton' : 'avatarStudio__primary'}
        disabled={busy || anyRunning || Boolean(buildBlocked)}
        onClick={() => void build(job, Boolean(job.warnings?.length))}
      >
        {unaccepted
          ? 'Accept warnings and build anyway'
          : rebuild
            ? 'Rebuild 3D avatar from this image'
            : modeOf(job) === 'new-character'
              ? 'Use this image and build 3D'
              : 'Use this image and recolour'}
      </button>
    );
  };

  let inspector;
  const activePanel: Panel = !selected && panel !== 'describe' ? 'describe' : panel;
  if (activePanel === 'describe' || !selected) {
    inspector = describeForm;
  } else if (activePanel === 'image') {
    inspector = (
      <>
        <h3>Image · take {selectedNumber}</h3>
        <p className="avatarStudio__prompt">{selected.prompt}</p>
        <small>
          {selected.source === 'upload'
            ? 'Uploaded image'
            : (selected.imageModelName ?? 'Default image model')}
        </small>
        {selected.status === 'failed' && !hasImage(selected) ? (
          <p className="kiosk__error">Image generation failed: {selected.errorMessage}</p>
        ) : null}
        {warnings}
        {selected.source !== 'upload' ? (
          <div className="avatarStudio__row">
            <button type="button" disabled={!canGenerate} onClick={() => void generate()}>
              Regenerate
            </button>
            <button type="button" onClick={() => setPanel('describe')}>
              Edit description
            </button>
          </div>
        ) : null}
        {modeOf(selected) === 'new-character' &&
        hasImage(selected) &&
        !RUNNING.has(selected.status) &&
        avatarApi.removeAvatarBackground ? (
          <div className="avatarStudio__field">
            {selected.backgroundRemoved ? (
              <button type="button" disabled={busy} onClick={() => void restoreBackground(selected)}>
                Restore original image
              </button>
            ) : (
              <button
                type="button"
                disabled={busy || anyRunning}
                onClick={() => void removeBackground(selected)}
              >
                Remove background
              </button>
            )}
            <small>
              {selected.backgroundRemoved
                ? 'The character was cut out onto plain white.'
                : 'Cuts the character out onto plain white. Try it if the build says the background isn’t light and plain.'}
            </small>
          </div>
        ) : null}
        {characterSelectors}
        {buildButton(selected)}
        <button
          type="button"
          className="avatarStudio__link"
          onClick={() => void discard(selected)}
          disabled={busy}
        >
          Discard take {selectedNumber}
        </button>
      </>
    );
  } else {
    inspector = (
      <>
        <h3>3D avatar · take {selectedNumber}</h3>
        {selected.status === 'completed' ? (
          <>
            <p className="avatarStudio__meta">
              {[selected.geometryModelName, selected.rigModelName].filter(Boolean).join(' · ')}
              {formatDuration(selected.buildSeconds)
                ? ` · built in ${formatDuration(selected.buildSeconds)}`
                : ''}
            </p>
            <p>Spin it, try the poses and expressions, then keep it or try something else.</p>
            <button
              type="button"
              className="avatarStudio__primary"
              disabled={busy || !modelReady?.data}
              onClick={() => void keep(selected, selectedNumber)}
            >
              Keep this avatar
            </button>
            <button type="button" onClick={() => setPanel('image')}>
              Rebuild with other models
            </button>
          </>
        ) : isBuilding(selected) ? (
          <>
            {progress}
            {buildList}
            <small>
              Building usually takes several minutes. You can close the studio meanwhile.
            </small>
            {buildButton(selected)}
          </>
        ) : selected.status === 'failed' ? (
          <>
            <p className="kiosk__error">Build failed: {selected.errorMessage ?? 'unknown error'}</p>
            <button type="button" onClick={() => setPanel('image')}>
              Change models and rebuild
            </button>
          </>
        ) : (
          <>
            <p>Take {selectedNumber} hasn’t been built yet.</p>
            <button type="button" onClick={() => setPanel('image')}>
              Choose models and build
            </button>
          </>
        )}
        <button
          type="button"
          className="avatarStudio__link"
          onClick={() => void discard(selected)}
          disabled={busy}
        >
          Discard take {selectedNumber}
        </button>
      </>
    );
  }

  const dot = (state: 'done' | 'running' | 'warn' | 'idle') => (
    <span className={`avatarStudio__dot is-${state}`} aria-hidden="true" />
  );
  const imageState = !selected
    ? 'idle'
    : selected.status === 'concept' || (selected.status === 'queued' && !hasImage(selected))
      ? 'running'
      : selected.warnings?.length && !selected.warningsAccepted
        ? 'warn'
        : hasImage(selected)
          ? 'done'
          : 'idle';
  const modelState = !selected
    ? 'idle'
    : selected.status === 'completed'
      ? 'done'
      : isBuilding(selected)
        ? 'running'
        : selected.status === 'failed' && hasImage(selected)
          ? 'warn'
          : 'idle';

  const historyEntries = useMemo(
    () =>
      takes.map((job, index) => {
        const image =
          job.status === 'concept' || (job.status === 'queued' && !hasImage(job))
            ? 'running'
            : hasImage(job)
              ? job.warnings?.length && !job.warningsAccepted
                ? 'warn'
                : 'done'
              : 'idle';
        const built = job.status === 'completed' ? 'done' : isBuilding(job) ? 'running' : 'idle';
        return { job, number: job.takeNumber ?? index + 1, image, built };
      }),
    [takes],
  );

  return createPortal(
    <dialog
      ref={dialog}
      className="avatarStudio"
      aria-label="Avatar studio"
      onClose={(event) => {
        // The enlarged-image popup is a child in React's tree; only this dialog closes the studio.
        if (event.target === dialog.current) onClose();
      }}
      onCancel={(event) => {
        if (event.target !== dialog.current) return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        // Escape closes the studio without also closing the controls drawer.
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <header className="avatarStudio__header">
        <h2>Avatar studio</h2>
        <span>Description → image → 3D avatar. Nothing changes until you keep a take.</span>
        <button type="button" onClick={onClose} aria-label="Close avatar studio">
          ✕ Close
        </button>
      </header>
      {error ? (
        <p role="alert" className="kiosk__error avatarStudio__banner">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="avatarStudio__banner avatarStudio__notice">
          {notice}
        </p>
      ) : null}
      <div className="avatarStudio__body">
        <nav className="avatarStudio__rail" aria-label="Pipeline">
          <button
            type="button"
            aria-current={activePanel === 'describe'}
            onClick={() => setPanel('describe')}
          >
            {dot(prompt.trim() || reference ? 'done' : 'idle')}
            <span>
              <b>Description</b>
              <small>
                {prompt.trim() ? prompt.trim().slice(0, 48) : 'Text or an uploaded image'}
              </small>
            </span>
          </button>
          <button
            type="button"
            aria-current={activePanel === 'image'}
            disabled={!selected}
            onClick={() => setPanel('image')}
          >
            {dot(imageState)}
            <span>
              <b>Image</b>
              <small>{selected ? `Take ${selectedNumber} of ${takes.length}` : 'None yet'}</small>
            </span>
          </button>
          <button
            type="button"
            aria-current={activePanel === 'model'}
            disabled={!selected}
            onClick={() => {
              setPanel('model');
              if (selected?.status === 'completed' && view === 'image') setView('compare');
            }}
          >
            {dot(modelState)}
            <span>
              <b>3D avatar</b>
              <small>
                {selected?.status === 'completed'
                  ? 'Ready to review'
                  : selected && isBuilding(selected)
                    ? 'Building…'
                    : 'Not built'}
              </small>
            </span>
          </button>
          {buildList}
        </nav>
        <section className="avatarStudio__center" aria-label="Preview">
          <div className="avatarStudio__toolbar">
            <div className="avatarStudio__seg" role="group" aria-label="Show">
              {(
                [
                  ['image', 'Image'],
                  ['model', '3D avatar'],
                  ['compare', 'Side by side'],
                ] as const
              ).map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={stageView === value}
                  disabled={value !== 'image' && !canShowModel}
                  onClick={() => setView(value)}
                >
                  {label}
                </button>
              ))}
            </div>
            {selected ? <small>Take {selectedNumber}</small> : null}
          </div>
          <div className="avatarStudio__stage">{stage}</div>
        </section>
        <aside className="avatarStudio__inspector" aria-label="Inspector">
          {inspector}
        </aside>
        <div className="avatarStudio__history" aria-label="Takes">
          <span>History</span>
          <div className="avatarStudio__takes">
            {historyEntries.map(({ job, number, image, built }) => (
              <button
                key={job.jobId}
                type="button"
                className="avatarStudio__take"
                aria-pressed={job.jobId === selectedId}
                aria-label={`Take ${number}`}
                onClick={() => selectTake(job)}
              >
                {job.previewDataUrl ? (
                  <img src={job.previewDataUrl} alt="" />
                ) : (
                  <span className="avatarStudio__takeBlank" />
                )}
                <span>
                  <b>#{number}</b>
                  <span className="avatarStudio__takeDots">
                    {dot(image as 'done')}
                    {dot(built as 'done')}
                  </span>
                </span>
              </button>
            ))}
            {!takes.length ? <small>Your takes will appear here.</small> : null}
          </div>
        </div>
      </div>
      {enlarged ? (
        <ExpandedImage
          src={enlarged}
          alt={`Take ${selectedNumber} concept`}
          onDismiss={() => setEnlarged(null)}
        />
      ) : null}
    </dialog>,
    document.body,
  );
}

/** The sidebar entry point: a short summary and a button that opens the studio pop-up. */
export function AvatarStudioLauncher({
  avatarApi,
  onAccepted,
  pollIntervalMs,
}: {
  avatarApi?: AvatarBridge;
  onAccepted?: (vrmId: string) => void | Promise<void>;
  pollIntervalMs?: number;
}) {
  const [open, setOpen] = useState(false);
  if (!avatarApi?.generateAvatar || !avatarApi.listAvatarGenerationJobs) return null;
  return (
    <div className="faces__section" aria-labelledby="avatar-studio-heading">
      <h3 className="faces__heading" id="avatar-studio-heading">
        Create an avatar
      </h3>
      <p className="kiosk__info">
        Describe a character or upload an image, review it, then turn it into a rigged 3D avatar.
        Keep as many takes as you like and go back to any stage.
      </p>
      <button type="button" className="faces__submit" onClick={() => setOpen(true)}>
        Open avatar studio
      </button>
      {open ? (
        <AvatarStudio
          avatarApi={avatarApi}
          onClose={() => setOpen(false)}
          onAccepted={onAccepted}
          pollIntervalMs={pollIntervalMs}
        />
      ) : null}
    </div>
  );
}
