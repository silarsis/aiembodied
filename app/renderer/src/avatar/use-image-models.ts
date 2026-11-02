import { useCallback, useEffect, useState } from 'react';
import type { AvatarBridge, AvatarImageModelSelection, AvatarLoraChoice } from './types.js';

export function useImageModels(api: AvatarBridge | undefined, visible: boolean) {
  const [selection, setSelection] = useState<AvatarImageModelSelection>({
    models: [],
    selectedModelId: null,
  });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const supported = Boolean(api?.listAvatarImageModels && api.setAvatarImageModel);
  const refresh = useCallback(async () => {
    if (!api?.listAvatarImageModels) return;
    setLoading(true);
    setError(null);
    try {
      setSelection(await api.listAvatarImageModels());
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not find image models.');
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
  const select = async (id: string) => {
    if (!api?.setAvatarImageModel) return;
    setLoading(true);
    setError(null);
    try {
      await api.setAvatarImageModel(id);
      setSelection((current) => ({ ...current, selectedModelId: id }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not select the image model.');
    } finally {
      setLoading(false);
    }
  };
  const setLoras = async (choices: AvatarLoraChoice[]) => {
    if (!api?.setAvatarImageLoras) return;
    setSelection((current) => ({ ...current, selectedLoras: choices }));
    try {
      await api.setAvatarImageLoras(choices);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the LoRA choice.');
    }
  };
  return { ...selection, loading, error, supported, refresh, select, setLoras };
}
