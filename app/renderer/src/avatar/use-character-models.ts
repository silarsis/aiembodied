import { useCallback, useEffect, useState } from 'react';
import type { AvatarBridge, AvatarCharacterModelSelection } from './types.js';

/** The 3D geometry and rig choices for turning an approved image into an avatar. */
export function useCharacterModels(api: AvatarBridge | undefined, visible: boolean) {
  const [selection, setSelection] = useState<AvatarCharacterModelSelection>({
    geometry: [],
    rig: [],
    selectedGeometryId: null,
    selectedRigId: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = Boolean(api?.listAvatarCharacterModels && api.setAvatarCharacterModel);
  const refresh = useCallback(async () => {
    if (!api?.listAvatarCharacterModels) return;
    setLoading(true);
    setError(null);
    try {
      setSelection(await api.listAvatarCharacterModels());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not find the 3D models.');
    } finally {
      setLoading(false);
    }
  }, [api]);
  useEffect(() => {
    let cancelled = false;
    if (visible && supported)
      void Promise.resolve().then(() => {
        if (!cancelled) return refresh();
      });
    return () => {
      cancelled = true;
    };
  }, [visible, supported, refresh]);
  const select = async (stage: 'geometry' | 'rig', id: string) => {
    if (!api?.setAvatarCharacterModel) return;
    setLoading(true);
    setError(null);
    try {
      await api.setAvatarCharacterModel(stage, id);
      setSelection((current) =>
        stage === 'geometry'
          ? { ...current, selectedGeometryId: id }
          : { ...current, selectedRigId: id },
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not select that model.');
    } finally {
      setLoading(false);
    }
  };
  return { ...selection, loading, error, supported, refresh, select };
}
