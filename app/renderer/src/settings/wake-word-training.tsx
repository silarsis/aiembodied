import { useCallback, useEffect, useState } from 'react';
import type {
  WakeWordOption,
  WakeWordTrainingJob,
  WakeWordTrainingStatus,
} from '../../../main/src/wake-word/types.js';
import type { WakeWordBridge } from '../preload-api.js';

export interface WakeWordLibrary {
  /** Null until the list has loaded (or when there is no bridge to ask). */
  options: WakeWordOption[] | null;
  training: WakeWordTrainingStatus | null;
  train(phrase: string): Promise<void>;
  cancel(): Promise<void>;
}

/** The wake words to choose from, and the training run, kept up to date from the main process. */
export function useWakeWordLibrary(bridge: WakeWordBridge | undefined): WakeWordLibrary {
  const [options, setOptions] = useState<WakeWordOption[] | null>(null);
  const [training, setTraining] = useState<WakeWordTrainingStatus | null>(null);

  const refresh = useCallback(async () => {
    if (bridge?.list) {
      setOptions(await bridge.list());
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) {
      return;
    }
    let active = true;
    void bridge
      .list?.()
      .then((list) => active && setOptions(list))
      .catch(() => undefined);
    void bridge
      .getTrainingStatus?.()
      .then((status) => active && setTraining(status))
      .catch(() => undefined);
    const unsubscribe = bridge.onTrainingStatus?.((status) => {
      setTraining(status);
      if (status.job?.state === 'done') {
        // A finished run adds its model to the list.
        void refresh().catch(() => undefined);
      }
    });
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [bridge, refresh]);

  const train = useCallback(
    async (phrase: string) => {
      if (!bridge?.train) {
        throw new Error('Wake word training is not available.');
      }
      setTraining(await bridge.train(phrase));
    },
    [bridge],
  );

  const cancel = useCallback(async () => {
    if (bridge?.cancelTraining) {
      setTraining(await bridge.cancelTraining());
    }
  }, [bridge]);

  return { options, training, train, cancel };
}

/** "Hey Echo · 52% recall · 0.8 false wakes/h" for the wake word dropdown. */
export function describeWakeWordOption(option: WakeWordOption): string {
  const details: string[] = [];
  if (option.quick) {
    details.push('test run');
  }
  if (typeof option.metrics?.recall === 'number') {
    details.push(`${Math.round(option.metrics.recall * 100)}% recall`);
  }
  if (typeof option.metrics?.falsePositivesPerHour === 'number') {
    details.push(`${option.metrics.falsePositivesPerHour.toFixed(1)} false wakes/h`);
  }
  return [option.label, ...details].join(' · ');
}

function describeJob(job: WakeWordTrainingJob): string {
  switch (job.state) {
    case 'running':
      return `${job.stageLabel || 'Training'}${job.message ? ` (${job.message})` : ''}`;
    case 'done':
      return `"${job.phrase}" is trained. Pick it above and save to start using it.`;
    case 'cancelled':
      return `Training "${job.phrase}" was cancelled.`;
    case 'interrupted':
      return `Training "${job.phrase}" stopped while ${job.stageLabel.toLowerCase() || 'running'} (the PC may have slept). Resume picks up where it left off.`;
    default:
      return `Training "${job.phrase}" failed: ${job.error ?? 'unknown error'}`;
  }
}

export function WakeWordTraining({
  training,
  onTrain,
  onCancel,
  disabled,
}: {
  training: WakeWordTrainingStatus | null;
  onTrain(phrase: string): Promise<void>;
  onCancel(): Promise<void>;
  disabled: boolean;
}) {
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!training) {
    return null;
  }
  const job = training.job;
  const running = job?.state === 'running';
  const resumable = job && (job.state === 'interrupted' || job.state === 'failed' || job.state === 'cancelled');

  const act = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wakeWordTraining">
      <h4>Train a new wake word</h4>
      {!training.available ? (
        <p className="kiosk__helper">{training.reason ?? 'Training is not available on this machine.'}</p>
      ) : (
        <>
          <p className="kiosk__helper">
            Trains an openWakeWord model in WSL from synthetic speech, the way &ldquo;Hey Echo&rdquo; was made. It takes three to four
            hours on the CPU (the first run also downloads about 20 GB) and carries on if you close the app. Two or three
            syllables work best.
          </p>
          <div className="control">
            <label htmlFor="settings-wake-train-phrase">Phrase</label>
            <input
              id="settings-wake-train-phrase"
              type="text"
              value={phrase}
              placeholder="hey echo"
              maxLength={40}
              onChange={(event) => setPhrase(event.target.value)}
              disabled={disabled || busy || running}
            />
          </div>
          <div className="secretCard__actions">
            <button
              type="button"
              onClick={() => void act(() => onTrain(phrase))}
              disabled={disabled || busy || running || !phrase.trim()}
            >
              Train
            </button>
          </div>
        </>
      )}
      {job ? (
        <div className="wakeWordTraining__job" aria-live="polite">
          {running ? (
            <progress
              max={1}
              value={job.progress}
              aria-label={`Training "${job.phrase}"`}
              className="wakeWordTraining__progress"
            />
          ) : null}
          <p className={job.state === 'failed' || job.state === 'interrupted' ? 'kiosk__error' : 'kiosk__helper'}>
            {running ? `Training "${job.phrase}": ${Math.round(job.progress * 100)}%. ` : ''}
            {describeJob(job)}
          </p>
          {job.state === 'failed' || job.state === 'interrupted' ? (
            <p className="kiosk__helper">Log: {job.logFile}</p>
          ) : null}
          <div className="secretCard__actions">
            {running ? (
              <button type="button" onClick={() => void act(onCancel)} disabled={disabled || busy}>
                Cancel training
              </button>
            ) : null}
            {resumable && training.available ? (
              <button type="button" onClick={() => void act(() => onTrain(job.phrase))} disabled={disabled || busy}>
                {job.state === 'cancelled' ? 'Train again' : 'Resume'}
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="kiosk__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
