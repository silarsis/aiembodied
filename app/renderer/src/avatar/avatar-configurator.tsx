import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type FormEvent,
} from 'react';
import type { AvatarBridge, AvatarFaceDetail, AvatarFaceSummary } from './types.js';

interface AvatarConfiguratorProps {
  avatarApi?: AvatarBridge;
  onActiveFaceChange?: (detail: AvatarFaceDetail | null) => void;
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

export function AvatarConfigurator({ avatarApi, onActiveFaceChange }: AvatarConfiguratorProps) {
  const [faces, setFaces] = useState<AvatarFaceSummary[]>([]);
  const [activeFaceId, setActiveFaceId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [busyFaceId, setBusyFaceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [nameInput, setNameInput] = useState('');
  const isBridgeAvailable = Boolean(avatarApi);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const availabilityLogRef = useRef<'available' | 'missing' | null>(null);

  useEffect(() => {
    const nextState: 'available' | 'missing' = avatarApi ? 'available' : 'missing';
    if (availabilityLogRef.current === nextState) {
      return;
    }

    availabilityLogRef.current = nextState;
    if (nextState === 'available') {
      console.info('[avatar configurator] Avatar bridge connected.');
    } else {
      console.warn('[avatar configurator] Avatar bridge unavailable. Falling back to static UI.');
    }
  }, [avatarApi]);

  const formattedFaces = useMemo(() => {
    return faces.map((face) => ({
      ...face,
      createdLabel: new Date(face.createdAt).toLocaleString(),
    }));
  }, [faces]);

  const refresh = useCallback(async () => {
    if (!avatarApi) {
      setFaces([]);
      setActiveFaceId(null);
      onActiveFaceChange?.(null);
      setLoading(false);
      setError('Avatar configuration bridge is unavailable.');
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const [list, active] = await Promise.all([avatarApi.listFaces(), avatarApi.getActiveFace()]);
      setFaces(list);
      setActiveFaceId(active?.id ?? null);
      onActiveFaceChange?.(active ?? null);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load avatar faces.';
      setError(message);
    } finally {
      setLoading(false);
      setBusyFaceId(null);
    }
  }, [avatarApi, onActiveFaceChange]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      await refresh();
      if (!cancelled && fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [refresh]);

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
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();

      if (!avatarApi) {
        setError('Avatar configuration bridge is unavailable.');
        return;
      }

      if (!file) {
        setError('Select an image to upload.');
        return;
      }

      setUploading(true);
      setError(null);

      try {
        const dataUrl = await fileToDataUrl(file);
        const name = nameInput.trim() || deriveName(file);
        await avatarApi.uploadFace({ name, imageDataUrl: dataUrl });
        setNameInput('');
        setFile(null);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to upload avatar face.';
        setError(message);
      } finally {
        setUploading(false);
      }
    },
    [avatarApi, file, nameInput, refresh],
  );

  const handleSelect = useCallback(
    async (faceId: string) => {
      if (!avatarApi) {
        setError('Avatar configuration bridge is unavailable.');
        return;
      }

      setBusyFaceId(faceId);
      setError(null);
      try {
        const detail = await avatarApi.setActiveFace(faceId);
        setActiveFaceId(detail?.id ?? null);
        onActiveFaceChange?.(detail ?? null);
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to activate avatar face.';
        setError(message);
      } finally {
        setBusyFaceId(null);
      }
    },
    [avatarApi, onActiveFaceChange],
  );

  const handleDelete = useCallback(
    async (faceId: string) => {
      if (!avatarApi) {
        setError('Avatar configuration bridge is unavailable.');
        return;
      }

      setBusyFaceId(faceId);
      setError(null);
      try {
        await avatarApi.deleteFace(faceId);
        if (activeFaceId === faceId) {
          onActiveFaceChange?.(null);
        }
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to delete avatar face.';
        setError(message);
      } finally {
        setBusyFaceId(null);
      }
    },
    [avatarApi, activeFaceId, onActiveFaceChange, refresh],
  );

  return (
    <section className="kiosk__faces" aria-labelledby="kiosk-faces-title">
      <div className="faces__header">
        <div>
          <h2 id="kiosk-faces-title">Avatar faces</h2>
          <p className="kiosk__helper">
            Upload a single face image to generate layered components for the animated avatar. Select any stored face to update
            the kiosk instantly.
          </p>
        </div>
        {!isBridgeAvailable ? (
          <p className="kiosk__error" role="alert">
            Avatar configuration bridge is unavailable.
          </p>
        ) : null}
      </div>

      <form className="faces__form" onSubmit={handleUpload} aria-label="Upload new avatar face">
        <label className="faces__field">
          <span>Face image</span>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            onChange={handleFileChange}
            disabled={!isBridgeAvailable || uploading}
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
            disabled={!isBridgeAvailable || uploading}
          />
        </label>
        <button
          className="faces__submit"
          type="submit"
          disabled={!isBridgeAvailable || uploading || !file}
        >
          {uploading ? 'Generating…' : 'Generate avatar'}
        </button>
      </form>

      {error ? (
        <p role="alert" className="kiosk__error">
          {error}
        </p>
      ) : null}
      {uploading ? <p className="kiosk__info">Processing avatar assets…</p> : null}
      {loading ? <p className="kiosk__info">Loading stored faces…</p> : null}

      <div className="faces__grid" role="list">
        {formattedFaces.map((face) => {
          const isActive = face.id === activeFaceId;
          const busy = busyFaceId === face.id || uploading;
          return (
            <article key={face.id} className="faceCard" data-active={isActive ? 'true' : 'false'} role="listitem">
              <div className="faceCard__preview" aria-hidden="true">
                {face.previewDataUrl ? (
                  <img src={face.previewDataUrl} alt="" loading="lazy" />
                ) : (
                  <div className="faceCard__placeholder">No preview</div>
                )}
              </div>
              <div className="faceCard__info">
                <h3>{face.name}</h3>
                <p className="faceCard__meta">Added {face.createdLabel}</p>
              </div>
              <div className="faceCard__actions">
                <button type="button" onClick={() => handleSelect(face.id)} disabled={busy || !isBridgeAvailable}>
                  {isActive ? 'Active' : 'Use face'}
                </button>
                <button type="button" onClick={() => handleDelete(face.id)} disabled={busy || !isBridgeAvailable}>
                  Delete
                </button>
              </div>
            </article>
          );
        })}
      </div>

      {!loading && formattedFaces.length === 0 ? (
        <p className="kiosk__info">No avatar faces stored yet. Upload an image to get started.</p>
      ) : null}
    </section>
  );
}
