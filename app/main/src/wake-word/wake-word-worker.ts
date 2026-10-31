import { parentPort, workerData } from 'node:worker_threads';
import { PvRecorder } from '@picovoice/pvrecorder-node';
import { OWW_FRAME_LENGTH, OWW_SAMPLE_RATE, OpenWakeWordDetector } from './open-wake-word.js';
import { PeakTracker } from './peak-tracker.js';
import type {
  SerializedError,
  WakeWordDetectionEvent,
  WakeWordWorkerCommand,
  WakeWordWorkerConfig,
  WakeWordWorkerMessage,
} from './types.js';

if (!parentPort) {
  throw new Error('wake-word-worker must be run as a worker thread');
}

// After the null check above, we know parentPort is defined
const port = parentPort;

const config = workerData as WakeWordWorkerConfig;

let recorder: PvRecorder | null = null;
let detector: OpenWakeWordDetector | null = null;
let isRunning = false;
let stopping = false;
let processing: Promise<number> | null = null;
const peaks = new PeakTracker();

async function start(): Promise<void> {
  detector = await OpenWakeWordDetector.create(config.modelPaths);
  if (stopping) { await detector.release(); return; }
  // PvRecorder (open source, no access key) always captures 16 kHz mono int16, which is what
  // openWakeWord expects.
  recorder = new PvRecorder(OWW_FRAME_LENGTH, config.deviceIndex ?? -1, 50);
  recorder.start();
  isRunning = true;

  port.postMessage({
    type: 'ready',
    info: {
      frameLength: OWW_FRAME_LENGTH,
      sampleRate: OWW_SAMPLE_RATE,
      keywordLabel: config.keywordLabel,
    },
  } satisfies WakeWordWorkerMessage);

  while (isRunning) {
    try {
      const frame = await recorder.read();
      if (stopping) break;
      processing = detector.process(frame);
      const score = await processing;
      processing = null;
      if (stopping) break;
      if (score >= config.threshold) {
        const event: WakeWordDetectionEvent = {
          keywordLabel: config.keywordLabel,
          confidence: score,
          timestamp: Date.now(),
        };
        port.postMessage({ type: 'wake', event } satisfies WakeWordWorkerMessage);
      }
      const peak = peaks.push(score, Date.now());
      if (peak) {
        port.postMessage({
          type: 'peak',
          event: { keywordLabel: config.keywordLabel, confidence: peak.score, timestamp: peak.timestamp },
        } satisfies WakeWordWorkerMessage);
      }
    } catch (error) {
      if (stopping) break;
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
  if (stopping) return;
  port.postMessage({ type: 'error', error: serializeError(error) } satisfies WakeWordWorkerMessage);
  shutdown().catch(() => {
    // ignore errors during shutdown
  });
});

async function shutdown(): Promise<void> {
  stopping = true;
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

  // Let any native inference finish before releasing its sessions; its result is discarded.
  await processing?.catch(() => undefined);
  if (detector) {
    try {
      await detector.release();
    } catch {
      // ignore release errors
    }
  }
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
