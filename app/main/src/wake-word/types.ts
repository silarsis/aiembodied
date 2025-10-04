export interface WakeWordDetectionEvent {
  keywordLabel: string;
  confidence: number;
  timestamp: number;
  keywordIndex?: number;
}

export interface WakeWordReadyEvent {
  frameLength: number;
  sampleRate: number;
  keywordLabel: string;
}

export interface WakeWordWorkerConfig {
  accessKey: string;
  keywordPath: string;
  keywordLabel: string;
  sensitivity: number;
  modelPath?: string;
  deviceIndex?: number;
}

export type WakeWordWorkerMessage =
  | { type: 'wake'; event: WakeWordDetectionEvent }
  | { type: 'error'; error: SerializedError }
  | { type: 'ready'; info: WakeWordReadyEvent };

export interface SerializedError {
  message: string;
  name?: string;
  stack?: string;
}

export type WakeWordWorkerCommand = { type: 'shutdown' };
