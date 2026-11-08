/** The Coding page's bridge from the renderer, shared by preload and renderer. Types only. */
import type { CodingConfig } from './types.js';
import type { CodingStatus, CodingView } from './coding-service.js';

export type { CodingConfig, CodingStatus, CodingView };

export interface CodingBridge {
  get(): Promise<CodingView>;
  /** Save new coding settings (workspaces, runner, coder model file) and apply them. */
  set(coding: CodingConfig): Promise<CodingView>;
  status(): Promise<CodingStatus>;
  /** Opens a file dialog for a .gguf file; null if cancelled. */
  pickGguf(): Promise<string | null>;
  /** Opens a folder dialog; null if cancelled. */
  pickFolder(): Promise<string | null>;
  /** The checks command the runner detected for a saved workspace. */
  suggestChecks(workspaceId: string): Promise<string | null>;
}
