import { readSharedWakeWord } from './shared-model.js';
import { ConfigManager } from '../config/config-manager.js';
import { WakeWordListeningController } from './listening-controller.js';
import { WakeWordTrainer } from './wake-word-trainer.js';
import { listWakeWords } from './wake-word-library.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface WakeWordIpcOptions {
  handle: HandleIpc;
  manager: ConfigManager;
  trainedWakeWordDirectory: () => string;
  wakeWordListening: WakeWordListeningController;
  wakeWordTrainer: () => WakeWordTrainer | null;
}

export function registerWakeWordIpc(options: WakeWordIpcOptions): void {
  const {
    handle,
    manager,
    trainedWakeWordDirectory,
    wakeWordListening,
    wakeWordTrainer: trainer,
  } = options;

  handle('wake-word:list', () => listWakeWords(trainedWakeWordDirectory()));
  // A satellite PC runs its own wake word worker; it asks for the wake word picked here (and a trained model's file).
  handle('wake-word:model', () =>
    readSharedWakeWord(manager.getRendererConfig().wakeWord, trainedWakeWordDirectory()),
  );
  handle('wake-word:set-listening', (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') throw new Error('Listening must be enabled or disabled.');
    return wakeWordListening.setEnabled(enabled);
  });
  handle('wake-word:get-training-status', () => {
    const wakeWordTrainer = trainer();
    return wakeWordTrainer
      ? wakeWordTrainer.getStatus()
      : { available: false, reason: 'Training is not set up.', job: null };
  });
  handle('wake-word:train', (_event, payload: { phrase?: unknown; quick?: unknown }) => {
    const wakeWordTrainer = trainer();
    if (!wakeWordTrainer) {
      throw new Error('Wake word training is not set up.');
    }
    return wakeWordTrainer.start(typeof payload?.phrase === 'string' ? payload.phrase : '', {
      quick: payload?.quick === true,
    });
  });
  handle('wake-word:cancel-training', () => {
    const wakeWordTrainer = trainer();
    return wakeWordTrainer
      ? wakeWordTrainer.cancel()
      : { available: false, reason: 'Training is not set up.', job: null };
  });
}
