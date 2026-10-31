export interface BackgroundSummary {
  id: string;
  name: string;
  builtIn: boolean;
  thumbnailDataUrl: string;
  /** Shared composition anchor: object-position and projected avatar feet use this same fraction. */
  groundY: number;
}

export interface BackgroundBridge {
  list(): Promise<BackgroundSummary[]>;
  getActive(): Promise<string | null>;
  setActive(id: string | null): Promise<void>;
  load(id: string): Promise<string>;
  generate(prompt: string): Promise<BackgroundSummary>;
  delete(id: string): Promise<void>;
}
