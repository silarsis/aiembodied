import type { OpenWakeWordModelPaths } from './open-wake-word.js';

export interface WakeWordDetectionEvent {
  keywordLabel: string;
  confidence: number;
  timestamp: number;
  sessionId?: string;
}

export interface WakeWordReadyEvent {
  frameLength: number;
  sampleRate: number;
  keywordLabel: string;
}

export interface WakeWordWorkerConfig {
  modelPaths: OpenWakeWordModelPaths;
  keywordLabel: string;
  /** Score (0..1) a frame must reach to be reported as a wake event. */
  threshold: number;
  deviceIndex?: number;
}

export type WakeWordWorkerMessage =
  | { type: 'wake'; event: WakeWordDetectionEvent }
  | { type: 'error'; error: SerializedError; fatal?: boolean }
  | { type: 'ready'; info: WakeWordReadyEvent };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export type WakeWordWorkerCommand = { type: 'shutdown' };
