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

export function FurnitureBrowser({ controller }: { controller: FurnitureController }) {
  const { items, categories, refresh } = controller;

  if (controller.loading) {
    return <p role="status">Loading furniture library…</p>;
  }

  return (
    <div className="furnitureBrowser">
      <div className="furnitureBrowser__header">
        <h2>Furniture</h2>
        <button type="button" onClick={refresh} disabled={controller.loading}>
          Refresh
        </button>
      </div>

      <div className="furnitureBrowser__categories" role="tablist">
        {(Object.entries(categories).sort(([a], [b]) => a.localeCompare(b)) as [string, number][]).map(
          ([category, count]) => (
            <button
              key={category}
              type="button"
              className="furnitureBrowser__category"
              role="tab"
              aria-selected="false"
            >
              {category} ({count})
            </button>
          ),
        )}
      </div>

      <div className="furnitureBrowser__grid" aria-label="Furniture library">
        {items.map((item) => (
          <div key={item.id} className="furnitureBrowser__card">
            <button
              type="button"
              className="furnitureBrowser__image"
              aria-label={`Select ${item.name}`}
            >
              <img src={item.thumbnailDataUrl} alt={item.name} />
            </button>
            <div className="furnitureBrowser__info">
              <h3>{item.name}</h3>
              <p>{item.category}</p>
              {item.description && <p>{item.description}</p>}
            </div>
          </div>
        ))}
      </div>

      {items.length === 0 && !controller.loading && (
        <p className="furnitureBrowser__empty">No furniture in the library yet.</p>
      )}
    </div>
  );
}

export function FurnitureGenerator({ controller }: { controller: FurnitureController }) {
  const [prompt, setPrompt] = useState('');
  const [generating, setGenerating] = useState(false);

  const handleGenerate = async () => {
    if (!controller.bridge || !prompt) return;
    setGenerating(true);
    try {
      const item = await controller.bridge.generate(prompt);
      await controller.refresh();
      return item;
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="furnitureGenerator">
      <h2>Generate Furniture</h2>
      <p className="furnitureGenerator__hint">
        Describe the furniture you want (e.g., “a leather armchair, dark brown, modern style”)
      </p>
      <textarea
        className="furnitureGenerator__prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Describe the furniture..."
        disabled={generating}
      />
      <button
        type="button"
        className="furnitureGenerator__button"
        onClick={handleGenerate}
        disabled={generating || !prompt}
      >
        {generating ? 'Generating…' : 'Generate'}
      </button>
    </div>
  );
}

export function FurnitureControls({ bridge }: { bridge: FurnitureBridge | undefined }) {
  const controller = useFurniture(bridge);

  return (
    <div className="furnitureControls">
      <div className="furnitureControls__tabs" role="group" aria-label="Furniture options">
        <button
          type="button"
          className="furnitureControls__tab"
          aria-pressed={true}
        >
          Library
        </button>
        <button
          type="button"
          className="furnitureControls__tab"
          aria-pressed={false}
        >
          Generate
        </button>
      </div>

      <FurnitureBrowser controller={controller} />
      <FurnitureGenerator controller={controller} />
    </div>
  );
}
