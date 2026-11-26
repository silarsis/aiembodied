// Types only: shared/ holds what the main process and the renderer both need.


export interface WakeWordDetectionEvent {
  keywordLabel: string;
  confidence: number;
  timestamp: number;
  sessionId?: string;
}


/** Validation figures train.py reports for a model trained in the app. */
export interface WakeWordTrainingMetrics {
  accuracy?: number;
  recall?: number;
  falsePositivesPerHour?: number;
}


/** A wake word the Settings page can pick. */
export interface WakeWordOption {
  /** What goes in the wake word setting: a bundled model name, or the path to a trained .onnx. */
  model: string;
  label: string;
  source: 'builtin' | 'trained';
  phrase?: string;
  trainedAt?: string;
  /** Trained with the small test settings, so not good enough to use for real. */
  quick?: boolean;
  metrics?: WakeWordTrainingMetrics;
}


export type WakeWordTrainingState = 'running' | 'done' | 'failed' | 'cancelled' | 'interrupted';


/** One training run, as train_wake_word.py reports it in status.json. */
export interface WakeWordTrainingJob {
  slug: string;
  phrase: string;
  state: WakeWordTrainingState;
  stage: string;
  stageLabel: string;
  /** 0..1 over the whole run. */
  progress: number;
  message?: string;
  error?: string;
  startedAt: string;
  updatedAt: string;
  /** The script's log, for when something goes wrong. */
  logFile: string;
  /** The trained model's path (in Windows terms), once it is done. */
  model?: string;
  metrics?: WakeWordTrainingMetrics;
}


export interface WakeWordTrainingStatus {
  /** Whether training can run here: it needs WSL and the training scripts. */
  available: boolean;
  reason?: string;
  job: WakeWordTrainingJob | null;
}
