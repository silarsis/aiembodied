import { parentPort, workerData } from 'node:worker_threads';
import { Porcupine, type PorcupineOptions } from '@picovoice/porcupine-node';
import { PvRecorder } from '@picovoice/pvrecorder-node';
import type {
  SerializedError,
  WakeWordDetectionEvent,
  WakeWordWorkerCommand,
  WakeWordWorkerConfig,
  WakeWordWorkerMessage,
} from './types.js';

if (!parentPort) {
  throw new Error('porcupine-worker must be run as a worker thread');
}

// After the null check above, we know parentPort is defined
const port = parentPort;

const config = workerData as WakeWordWorkerConfig;

let recorder: PvRecorder | null = null;
let porcupine: Porcupine | null = null;
let isRunning = false;

async function start(): Promise<void> {
  porcupine = createPorcupine(config);
  recorder = new PvRecorder(porcupine.frameLength, config.deviceIndex ?? -1, 50);
  recorder.start();
  isRunning = true;

  port.postMessage({
    type: 'ready',
    info: {
      frameLength: porcupine.frameLength,
      sampleRate: porcupine.sampleRate,
      keywordLabel: config.keywordLabel,
    },
  } satisfies WakeWordWorkerMessage);

  while (isRunning) {
    try {
      const frame = await recorder.read();
      const keywordIndex = porcupine.process(frame);
      if (keywordIndex >= 0) {
        const event: WakeWordDetectionEvent = {
          keywordLabel: config.keywordLabel,
          confidence: 1,
          timestamp: Date.now(),
          keywordIndex,
        };
        port.postMessage({ type: 'wake', event } satisfies WakeWordWorkerMessage);
      }
    } catch (error) {
      const isFatalAudioError =
        error instanceof Error && error.message.includes('PvRecorder failed to read audio data frame');
      port.postMessage({
        type: 'error',
        error: serializeError(error),
        fatal: isFatalAudioError,
      } satisfies WakeWordWorkerMessage);
      if (isFatalAudioError) {
        isRunning = false;
        await shutdown();
        break;
      }
    }
  }
}

port.on('message', (message: WakeWordWorkerCommand) => {
  if (message.type === 'shutdown') {
    shutdown().finally(() => {
      process.exit(0);
    });
  }
});

void start().catch((error) => {
  port.postMessage({ type: 'error', error: serializeError(error) } satisfies WakeWordWorkerMessage);
  shutdown().catch(() => {
    // ignore errors during shutdown
  });
});

async function shutdown(): Promise<void> {
  isRunning = false;
  if (recorder) {
    try {
      recorder.stop();
    } catch {
      // ignore recorder stop errors
    }
    try {
      recorder.release();
    } catch {
      // ignore release errors
    }
  }

  if (porcupine) {
    try {
      porcupine.release();
    } catch {
      // ignore release errors
    }
  }
}

function createPorcupine(options: WakeWordWorkerConfig): Porcupine {
  const keywords = [options.keywordPath];
  const sensitivities = [options.sensitivity];
  const porcupineOptions: PorcupineOptions = {};
  if (options.modelPath) {
    porcupineOptions.modelPath = options.modelPath;
  }
  return new Porcupine(options.accessKey, keywords, sensitivities, porcupineOptions);
}

function serializeError(error: unknown): SerializedError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }

  return { message: typeof error === 'string' ? error : 'Unknown error' };
}
