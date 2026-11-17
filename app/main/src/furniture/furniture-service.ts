/**
 * Furniture library service.
 * Manages a library of furniture items (Poly Haven + user-generated),
 * with generation capability via ComfyUI.
 */
import { rm } from 'node:fs/promises';
import path from 'node:path';
import type { MemoryStore } from '../memory/memory-store.js';
import type {
  FurnitureItem,
  FurnitureSummary,
  FurnitureBridge,
  FurnitureCategory,
} from './types.js';
import type { RoomObject } from '../rooms/types.js';

/** Furniture library data directory. */
export const FURNITURE_DIR = 'furniture';

/** Furniture categories with their Poly Haven category mappings. */
export const FURNITURE_CATEGORIES: Record<FurnitureCategory, string[]> = {
  seating: ['furniture', 'seating', 'chair', 'chairs', 'armchair', 'sofa', 'couch'],
  tables: ['furniture', 'table', 'tables', 'desk', 'coffee table'],
  storage: ['furniture', 'storage', 'shelf', 'cabinet', 'wardrobe', 'bookshelf'],
  lighting: ['lighting', 'lamp', 'lamps', 'light', 'chandelier'],
  decor: ['decor', 'decorative', 'vase', 'sculpture', 'art', 'painting'],
  appliances: ['appliance', 'appliances', 'kitchen', 'fridge', 'oven', 'microwave'],
  bedding: ['furniture', 'bed', 'beds', 'mattress', 'mattresses'],
  rugs: ['rug', 'rugs', 'carpet', 'mat'],
};

/** Default dimensions for furniture categories (width, height, depth in metres). */
export const DEFAULT_DIMENSIONS: Record<FurnitureCategory, [number, number, number]> = {
  seating: [0.8, 1.0, 0.8],
  tables: [1.2, 0.75, 0.7],
  storage: [0.6, 1.8, 0.4],
  lighting: [0.3, 1.5, 0.3],
  decor: [0.3, 0.5, 0.3],
  appliances: [0.6, 1.8, 0.6],
  bedding: [1.6, 0.5, 2.0],
  rugs: [2.0, 0.02, 1.0],
};

/** Furniture library service options. */
export interface FurnitureServiceOptions {
  /** Memory store for metadata. */
  store: import('../memory/memory-store.js').MemoryStore;
  /** Directory to store furniture data. */
  furnitureDirectory: string;
  /** Directory to store thumbnails. */
  thumbnailDirectory: string;
  /** ComfyUI integration for generation. */
  comfy?: {
    /** Whether ComfyUI is available. */
    isAvailable: () => Promise<boolean>;
    /** Run a ComfyUI graph. */
    run: (graph: unknown, options?: { signal?: AbortSignal }) => Promise<Buffer>;
  };
  /** Optional callback to ensure ComfyUI is ready before generation. */
  ensureComfyReady?: () => Promise<void>;
  /** Directory containing Poly Haven assets (if available). */
  polyHavenAssetsDirectory?: string;
}

/** Furniture library service. */
export class FurnitureService implements FurnitureBridge {
  private readonly store: MemoryStore;
  private readonly furnitureDirectory: string;
  private readonly thumbnailDirectory: string;
  private readonly comfy?: FurnitureServiceOptions['comfy'];
  private readonly ensureComfyReady?: () => Promise<void>;
  private readonly polyHavenAssetsDirectory?: string;

  constructor(options: FurnitureServiceOptions) {
    this.store = options.store;
    this.furnitureDirectory = options.furnitureDirectory;
    this.thumbnailDirectory = options.thumbnailDirectory;
    this.comfy = options.comfy;
    this.ensureComfyReady = options.ensureComfyReady;
    this.polyHavenAssetsDirectory = options.polyHavenAssetsDirectory;
  }

  /** Initialize the furniture library (create directories, load existing items). */
  async initialize(): Promise<void> {
    // TODO: Create directories if they don't exist
    // TODO: Load existing Poly Haven furniture from assets
    // TODO: Scan user-generated furniture from furnitureDirectory
  }

  /** List all furniture in the library. */
  async list(): Promise<FurnitureSummary[]> {
    const items = await this.loadAllItems();
    return items.map((item) => this.toSummary(item));
  }

  /** Load a single furniture item by ID. */
  async load(id: string): Promise<FurnitureItem> {
    const items = await this.loadAllItems();
    const item = items.find((i) => i.id === id);
    if (!item) {
      throw new Error(`Furniture not found: ${id}`);
    }
    return item;
  }

  /** Add furniture to a room (converts to RoomObject). */
  async addToRoom(id: string, position: [number, number, number], rotationY: number): Promise<RoomObject> {
    const item = await this.load(id);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      position,
      rotationY,
      size: [...item.dimensions] as [number, number, number],
      model: item.model ? { ...item.model } : undefined,
      collider: 'box',
      dynamic: false,
      tags: item.category === 'seating' ? { sit: { position: [0, 0, 0], facing: 0 } } : undefined,
    };
  }

  /** Generate new furniture from text description. */
  async generate(prompt: string): Promise<FurnitureItem> {
    if (!this.comfy || !this.comfy.isAvailable()) {
      throw new Error('Furniture generation requires ComfyUI');
    }

    const id = `generated-${Date.now()}`;
    const category = this.inferCategory(prompt);

    // TODO: Generate image from prompt using ComfyUI
    // TODO: Generate 3D model from image
    // TODO: Save furniture item metadata

    const item: FurnitureItem = {
      id,
      name: this.promptToName(prompt),
      category,
      description: prompt,
      dimensions: DEFAULT_DIMENSIONS[category],
      thumbnailDataUrl: this.getDefaultThumbnail(),
      builtIn: false,
      createdAt: new Date().toISOString(),
    };

    // Save item metadata
    await this.saveItem(item);

    return item;
  }

  /** Delete user-generated furniture. */
  async delete(id: string): Promise<void> {
    const items = await this.loadAllItems();
    const item = items.find((i) => i.id === id);
    if (!item) {
      throw new Error(`Furniture not found: ${id}`);
    }
    if (item.builtIn) {
      throw new Error('Cannot delete built-in furniture');
    }

    // Remove from library
    const filtered = items.filter((i) => i.id !== id);
    this.store.setValue(`furniture.items`, JSON.stringify(filtered));

    // Clean up files
    try {
      if (item.model?.asset) {
        const modelPath = path.join(this.furnitureDirectory, item.model.asset);
        await rm(modelPath, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  }

  /** List categories with their furniture counts. */
  async listCategories(): Promise<Record<FurnitureCategory, number>> {
    const items = await this.loadAllItems();
    const counts: Record<FurnitureCategory, number> = {
      seating: 0,
      tables: 0,
      storage: 0,
      lighting: 0,
      decor: 0,
      appliances: 0,
      bedding: 0,
      rugs: 0,
    };

    for (const item of items) {
      if (counts[item.category] !== undefined) {
        counts[item.category]++;
      }
    }

    return counts;
  }

  /** Convert internal item to summary for renderer. */
  private toSummary(item: FurnitureItem): FurnitureSummary {
    return {
      id: item.id,
      name: item.name,
      category: item.category,
      description: item.description,
      thumbnailDataUrl: item.thumbnailDataUrl,
      builtIn: item.builtIn,
    };
  }

  /** Load all furniture items from store (sync version for saveItem). */
  private loadAllItemsSync(): FurnitureItem[] {
    const raw = this.store.getValue('furniture.items');
    if (!raw) {
      return [];
    }
    try {
      return JSON.parse(raw) as FurnitureItem[];
    } catch {
      return [];
    }
  }

  /** Load all furniture items from store. */
  private async loadAllItems(): Promise<FurnitureItem[]> {
    return this.loadAllItemsSync();
  }

  /** Save a furniture item to store. */
  private saveItem(item: FurnitureItem): void {
    const items = this.loadAllItemsSync();
    items.push(item);
    this.store.setValue('furniture.items', JSON.stringify(items));
  }

  /** Infer furniture category from prompt text. */
  private inferCategory(prompt: string): FurnitureCategory {
    const lower = prompt.toLowerCase();
    for (const [category, keywords] of Object.entries(FURNITURE_CATEGORIES)) {
      for (const keyword of keywords) {
        if (lower.includes(keyword)) {
          return category as FurnitureCategory;
        }
      }
    }
    return 'decor'; // Default
  }

  /** Convert prompt to furniture name. */
  private promptToName(prompt: string): string {
    // Take first 3-5 words as name
    const words = prompt.split(/\s+/).slice(0, 5).join(' ');
    // Remove trailing punctuation
    return words.replace(/[.,;:!?]+$/, '');
  }

  /** Get default thumbnail for a category. */
  private getDefaultThumbnail(): string {
    // In a real implementation, this would be a placeholder image
    // For now, return a minimal data URL
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIwAAAABJRU5ErkJggg==';
  }
}
