import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_PROVIDER_SETTINGS, type ProviderSettings } from '../../../main/src/config/provider-settings.js';
import type { WakeWordOption, WakeWordTrainingStatus } from '../../../main/src/wake-word/types.js';
import type { WakeWordBridge } from '../../src/preload-api.js';
import { ProviderSettingsPanel } from '../../src/settings/provider-settings-panel.js';
import { describeWakeWordOption } from '../../src/settings/wake-word-training.js';

const OPTIONS: WakeWordOption[] = [
  { model: 'hey_echo', label: 'Hey Echo', source: 'builtin' },
  { model: 'hey_jarvis', label: 'Hey Jarvis', source: 'builtin' },
  {
    model: 'C:\\wake-words\\hey_computer.onnx',
    label: 'Hey Computer',
    source: 'trained',
    phrase: 'hey computer',
    metrics: { recall: 0.6, falsePositivesPerHour: 0.42 },
  },
];

function running(progress: number): WakeWordTrainingStatus {
  return {
    available: true,
    job: {
      slug: 'hey_computer',
      phrase: 'hey computer',
      state: 'running',
      stage: 'generate',
      stageLabel: 'Generating spoken clips',
      progress,
      startedAt: '2026-10-30T01:00:00Z',
      updatedAt: '2026-10-30T02:00:00Z',
      logFile: 'C:\\wake-words\\jobs\\hey_computer\\train.log',
    },
  };
}

function createBridge(initial: WakeWordTrainingStatus) {
  let statusListener: ((status: WakeWordTrainingStatus) => void) | null = null;
  const bridge = {
    onWake: vi.fn(() => () => undefined),
    list: vi.fn(async () => OPTIONS),
    getTrainingStatus: vi.fn(async () => initial),
    train: vi.fn(async () => running(0)),
    cancelTraining: vi.fn(async () => ({ ...initial, job: initial.job ? { ...initial.job, state: 'cancelled' as const } : null })),
    onTrainingStatus: vi.fn((listener: (status: WakeWordTrainingStatus) => void) => {
      statusListener = listener;
      return () => {
        statusListener = null;
      };
    }),
  } satisfies WakeWordBridge;
  return { bridge, push: (status: WakeWordTrainingStatus) => statusListener?.(status) };
}

function defaults(): ProviderSettings {
  return structuredClone(DEFAULT_PROVIDER_SETTINGS);
}

describe('wake word settings', () => {
  it('describes options with their test figures', () => {
    expect(describeWakeWordOption(OPTIONS[2]!)).toBe('Hey Computer · 60% recall · 0.4 false wakes/h');
    expect(describeWakeWordOption({ model: 'x', label: 'X', source: 'trained', quick: true })).toBe('X · test run');
  });

  it('picks a trained wake word and a threshold, saving only those', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { bridge } = createBridge({ available: true, job: null });
    render(
      <ProviderSettingsPanel settings={defaults()} hasApiKey={false} voiceStatus={null} motionStatus={null} onSave={onSave} wakeWordBridge={bridge} />,
    );

    const select = (await screen.findByLabelText('Listen for')) as HTMLSelectElement;
    await waitFor(() => expect(select.options).toHaveLength(3));
    expect(select.value).toBe('hey_echo');
    fireEvent.change(select, { target: { value: 'C:\\wake-words\\hey_computer.onnx' } });
    fireEvent.change(screen.getByLabelText('Detection threshold'), { target: { value: '0.65' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith({ wakeWord: { model: 'C:\\wake-words\\hey_computer.onnx', threshold: 0.65 } }),
    );
  });

  it('starts training, shows progress, and offers cancel', async () => {
    const { bridge, push } = createBridge({ available: true, job: null });
    render(
      <ProviderSettingsPanel settings={defaults()} hasApiKey={false} voiceStatus={null} motionStatus={null} onSave={vi.fn()} wakeWordBridge={bridge} />,
    );

    const phrase = await screen.findByLabelText('Phrase');
    fireEvent.change(phrase, { target: { value: 'hey computer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Train' }));
    await waitFor(() => expect(bridge.train).toHaveBeenCalledWith('hey computer'));

    act(() => push(running(0.42)));
    expect(await screen.findByText(/Training "hey computer": 42%/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Train' })).toBeDisabled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancel training' }));
    await waitFor(() => expect(bridge.cancelTraining).toHaveBeenCalled());
  });

  it('refreshes the list when a run finishes and offers to resume an interrupted one', async () => {
    const status = running(0.8);
    const { bridge, push } = createBridge({ ...status, job: { ...status.job!, state: 'interrupted', stageLabel: 'Training the model' } });
    render(
      <ProviderSettingsPanel settings={defaults()} hasApiKey={false} voiceStatus={null} motionStatus={null} onSave={vi.fn()} wakeWordBridge={bridge} />,
    );

    expect(await screen.findByText(/stopped while training the model/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(bridge.train).toHaveBeenCalledWith('hey computer'));

    const callsBefore = bridge.list.mock.calls.length;
    act(() => push({ ...status, job: { ...status.job!, state: 'done', progress: 1 } }));
    await waitFor(() => expect(bridge.list.mock.calls.length).toBeGreaterThan(callsBefore));
    expect(screen.getByText(/is trained\. Pick it above/)).toBeInTheDocument();
  });

  it('explains when training is unavailable', async () => {
    const { bridge } = createBridge({ available: false, reason: 'Training a wake word needs Windows with WSL.', job: null });
    render(
      <ProviderSettingsPanel settings={defaults()} hasApiKey={false} voiceStatus={null} motionStatus={null} onSave={vi.fn()} wakeWordBridge={bridge} />,
    );
    expect(await screen.findByText('Training a wake word needs Windows with WSL.')).toBeInTheDocument();
    expect(screen.queryByLabelText('Phrase')).not.toBeInTheDocument();
  });
});
