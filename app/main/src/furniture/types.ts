/**
 * Furniture library types.
 * Furniture is 3D room objects that can be browsed and added to rooms.
 * The library includes Poly Haven models and user-generated pieces.
 */
import type { RoomObject } from '../rooms/types.js';

/** A furniture item in the library. */
export interface FurnitureItem {
  /** Unique ID (slug), e.g. "polyhaven-ArmChair_01" or "generated-3fa91c2e". */
  id: string;
  /** Human-readable name, e.g. "Armchair 01". */
  name: string;
  /** Category for filtering (matching Poly Haven tags). */
  category: FurnitureCategory;
  /** Short description for the UI. */
  description?: string;
  /** Dimensions in metres (width, height, depth). */
  dimensions: [number, number, number];
  /** Thumbnail image (data URL or path). */
  thumbnailDataUrl: string;
  /** Whether it's built-in (Poly Haven) or user-generated. */
  builtIn: boolean;
  /** Model reference for 3D rendering. */
  model?: {
    file: string;
    asset?: string;
    scale: number;
  };
  /** When it was created (user-generated only). */
  createdAt?: string;
}

/** Furniture categories for filtering. */
export type FurnitureCategory =
  | 'seating'
  | 'tables'
  | 'storage'
  | 'lighting'
  | 'decor'
  | 'appliances'
  | 'bedding'
  | 'rugs';

/** What the renderer asks for: furniture library data. */
export interface FurnitureSummary {
  id: string;
  name: string;
  category: FurnitureCategory;
  description?: string;
  thumbnailDataUrl: string;
  builtIn: boolean;
}

/** Request to generate new furniture from text. */
export interface FurnitureGenerationRequest {
  /** Text description, e.g. "a leather armchair, dark brown, modern style". */
  description: string;
  /** Optional category hint. */
  category?: FurnitureCategory;
  /** Custom dimensions (optional). */
  dimensions?: [number, number, number];
}

/** Result of a furniture generation job. */
export interface FurnitureGenerationResult {
  /** The generated furniture item. */
  item: FurnitureItem;
  /** Whether it was newly generated or reused from cache. */
  reused?: boolean;
}

/** Bridge interface for renderer → main communication. */
export interface FurnitureBridge {
  /** List all furniture in the library. */
  list(): Promise<FurnitureSummary[]>;
  /** Get a single furniture item by ID. */
  load(id: string): Promise<FurnitureItem>;
  /** Add furniture to a room (converts to RoomObject). */
  addToRoom(id: string, position: [number, number, number], rotationY: number): Promise<RoomObject>;
  /** Generate new furniture from text description. */
  generate(prompt: string): Promise<FurnitureItem>;
  /** Delete user-generated furniture. */
  delete(id: string): Promise<void>;
  /** List categories with their furniture counts. */
  listCategories(): Promise<Record<FurnitureCategory, number>>;
}
