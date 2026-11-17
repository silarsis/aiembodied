import { useState, useEffect } from 'react';
import type { FurnitureBridge, FurnitureSummary } from '../preload-api.js';

export interface FurnitureController {
  bridge: FurnitureBridge | undefined;
  available: boolean;
  loading: boolean;
  items: FurnitureSummary[];
  categories: Record<string, number>;
  refresh: () => Promise<void>;
}

export function useFurniture(bridge: FurnitureBridge | undefined): FurnitureController {
  const [items, setItems] = useState<FurnitureSummary[]>([]);
  const [categories, setCategories] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  const available = !!bridge;

  const load = async () => {
    if (!bridge) return;
    setLoading(true);
    try {
      const [itemsData, categoriesData] = await Promise.all([
        bridge.list(),
        bridge.listCategories(),
      ]);
      setItems(itemsData);
      setCategories(categoriesData);
    } finally {
      setLoading(false);
    }
  };

  const refresh = async () => await load();

  // Load on mount
  useEffect(() => {
    if (available) {
      load();
    }
  }, [available, bridge]);

  return {
    bridge,
    available,
    loading,
    items,
    categories,
    refresh,
  };
}
