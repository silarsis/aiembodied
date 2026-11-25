import { useCallback, useEffect, useState } from 'react';
import type { FurnitureBridge, FurnitureItem } from '../preload-api.js';

export interface FurnitureController {
  available: boolean;
  loading: boolean;
  /** Newest first. */
  items: FurnitureItem[];
  error: string | null;
  generate: (prompt: string) => Promise<FurnitureItem | null>;
  edit: (id: string, prompt: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  /** The scaled GLB of a piece, for the 3D view. */
  model: (id: string) => Promise<ArrayBuffer>;
}

const newestFirst = (items: FurnitureItem[]): FurnitureItem[] => [...items].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

/** The furniture library and its running jobs: the main process pushes each step, so progress needs no polling. */
export function useFurniture(bridge: FurnitureBridge | undefined): FurnitureController {
  const [items, setItems] = useState<FurnitureItem[]>([]);
  const [loading, setLoading] = useState(!!bridge);
  const [error, setError] = useState<string | null>(null);

  const put = useCallback((item: FurnitureItem) => {
    setItems((current) => newestFirst([...current.filter((entry) => entry.id !== item.id), item]));
  }, []);

  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    bridge
      .list()
      .then((list) => {
        // An update that arrived while listing is newer than the list.
        if (!cancelled) setItems((current) => newestFirst([...list.filter((item) => !current.some((entry) => entry.id === item.id)), ...current]));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : 'Could not load the furniture.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    const stop = bridge.onChanged(put);
    return () => {
      cancelled = true;
      stop();
    };
  }, [bridge, put]);

  const attempt = useCallback(async <T,>(work: () => Promise<T>): Promise<T | null> => {
    setError(null);
    try {
      return await work();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'That did not work.');
      return null;
    }
  }, []);

  return {
    available: !!bridge,
    loading,
    items,
    error,
    generate: async (prompt) => {
      const item = bridge ? await attempt(() => bridge.generate(prompt)) : null;
      if (item) put(item);
      return item;
    },
    edit: async (id, prompt) => {
      const item = bridge ? await attempt(() => bridge.edit(id, prompt)) : null;
      if (item) put(item);
    },
    remove: async (id) => {
      if (bridge && (await attempt(() => bridge.delete(id))) !== null) setItems((current) => current.filter((item) => item.id !== id));
    },
    model: (id) => (bridge ? bridge.model(id) : Promise.reject(new Error('Furniture is available in the desktop app.'))),
  };
}
