import { useCallback, useEffect, useRef, useState } from 'react';
import type { BackgroundBridge, BackgroundSummary } from '../../../main/src/backgrounds/types.js';

export function useBackgrounds(api?: BackgroundBridge) {
  const [items, setItems] = useState<BackgroundSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [loadedImage, setLoadedImage] = useState<{ id: string; url: string } | null>(null);
  const [loading, setLoading] = useState(Boolean(api));
  const [generating, setGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selection = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!api) return;
    let cancelled = false;
    Promise.all([api.list(), api.getActive()])
      .then(([next, active]) => {
        if (!cancelled) {
          setItems(next);
          setActiveId(active);
          setLoading(false);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(message(cause));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  useEffect(() => {
    let cancelled = false;
    if (api && activeId) {
      api
        .load(activeId)
        .then((image) => {
          if (!cancelled) setLoadedImage({ id: activeId, url: image });
        })
        .catch((cause: unknown) => {
          if (!cancelled) setError(message(cause));
        });
    }
    return () => {
      cancelled = true;
    };
  }, [api, activeId]);

  const select = useCallback(
    async (id: string | null) => {
      if (!api) return;
      const ticket = ++selection.current;
      setError(null);
      try {
        await api.setActive(id);
        if (alive.current && ticket === selection.current) setActiveId(id);
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  const generate = useCallback(
    async (prompt: string) => {
      if (!api) return false;
      setGenerating(true);
      setError(null);
      try {
        const created = await api.generate(prompt);
        if (alive.current) setItems((previous) => [...previous, created]);
        return true;
      } catch (cause) {
        if (alive.current) setError(message(cause));
        return false;
      } finally {
        if (alive.current) setGenerating(false);
      }
    },
    [api],
  );

  const remove = useCallback(
    async (id: string) => {
      if (!api) return;
      setError(null);
      try {
        await api.delete(id);
        const [next, active] = await Promise.all([api.list(), api.getActive()]);
        if (alive.current) {
          setItems(next);
          setActiveId(active);
        }
      } catch (cause) {
        if (alive.current) setError(message(cause));
      }
    },
    [api],
  );

  return {
    items,
    activeId,
    active: items.find((item) => item.id === activeId) ?? null,
    imageUrl: loadedImage?.id === activeId ? loadedImage.url : null,
    loading,
    generating,
    error,
    select,
    generate,
    remove,
    available: Boolean(api),
  };
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : 'The background could not be updated.';
}

export type BackgroundController = ReturnType<typeof useBackgrounds>;
