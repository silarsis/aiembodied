import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  WakeWordTrainer,
  toWslPath,
  validateWakePhrase,
  wakeWordSlug,
  type CommandResult,
} from '../src/wake-word/wake-word-trainer.js';
import { listWakeWords } from '../src/wake-word/wake-word-library.js';

const NOW = Date.parse('2026-10-30T03:00:00Z');

function setup() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'wake-trainer-'));
  const scripts = path.join(root, 'scripts');
  mkdirSync(scripts);
  writeFileSync(path.join(scripts, 'train_wake_word.py'), '');
  const trained = path.join(root, 'wake-words');
  const run = vi.fn(async (): Promise<CommandResult> => ({ code: 0, stdout: 'Python 3.12.3', stderr: '' }));
  const launch = vi.fn();
  return { root, scripts, trained, run, launch };
}

function writeStatus(trained: string, slug: string, status: Record<string, unknown>) {
  const dir = path.join(trained, 'jobs', slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'status.json'), JSON.stringify(status));
}

let trainer: WakeWordTrainer | null = null;
afterEach(() => {
  trainer?.dispose();
  trainer = null;
});

describe('wake word phrases and paths', () => {
  it('slugs and validates phrases', () => {
    expect(wakeWordSlug('Hey, Echo!')).toBe('hey_echo');
    expect(validateWakePhrase('  hey   echo ')).toBe('hey echo');
    expect(() => validateWakePhrase('   ')).toThrow(/Enter the phrase/);
    expect(() => validateWakePhrase('hey "echo"; rm -rf /')).toThrow(/Use only letters/);
    expect(() => validateWakePhrase('x'.repeat(41))).toThrow(/under 40/);
  });

  it('turns Windows paths into WSL ones', () => {
    expect(toWslPath('C:\\Users\\kevin\\AppData\\Roaming\\x')).toBe('/mnt/c/Users/kevin/AppData/Roaming/x');
    expect(toWslPath('D:/data')).toBe('/mnt/d/data');
    expect(toWslPath('\\\\server\\share')).toBeNull();
  });
});

describe('WakeWordTrainer', () => {
  it('is unavailable off Windows, or without WSL', async () => {
    const { scripts, trained, run } = setup();
    trainer = new WakeWordTrainer({ trainedDirectory: trained, scriptsDirectory: scripts, platform: 'linux', run });
    expect((await trainer.getStatus()).available).toBe(false);

    run.mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'no distro' });
    const noWsl = new WakeWordTrainer({ trainedDirectory: trained, scriptsDirectory: scripts, platform: 'win32', run });
    const status = await noWsl.getStatus();
    expect(status).toMatchObject({ available: false, job: null });
    expect(status.reason).toMatch(/wsl --install -d Ubuntu-24\.04/);
  });

  it('launches the script detached in WSL and reports the run straight away', async () => {
    const { trained, run, launch } = setup();
    // Windows-style paths, as the app passes them on bija.
    const scripts = 'C:\\repo\\services\\wakeword-trainer';
    trainer = new WakeWordTrainer({
      trainedDirectory: trained,
      scriptsDirectory: scripts,
      platform: 'win32',
      run,
      launch,
      now: () => NOW,
    });
    // The scripts check reads the real disk; point it at a folder that has the script.
    (trainer as unknown as { availability: Promise<unknown> }).availability = Promise.resolve({ available: true });

    const status = await trainer.start('Hey Computer');
    expect(status.job).toMatchObject({ slug: 'hey_computer', phrase: 'Hey Computer', state: 'running', progress: 0 });
    expect(launch).toHaveBeenCalledTimes(1);
    const [command, args] = launch.mock.calls[0] as [string, string[]];
    expect(command).toBe('wsl.exe');
    expect(args.slice(0, 5)).toEqual(['-d', 'Ubuntu-24.04', '--', 'bash', '-lc']);
    expect(args[5]).toContain("setsid --wait python3 '/mnt/c/repo/services/wakeword-trainer/train_wake_word.py'");
    expect(args[5]).toContain("--phrase 'Hey Computer'");

    await expect(trainer.start('hey echo')).rejects.toThrow(/still training/);
  });

  it('reads progress, marks a stalled run interrupted, and finds the finished model', async () => {
    const { scripts, trained, run } = setup();
    trainer = new WakeWordTrainer({ trainedDirectory: trained, scriptsDirectory: scripts, platform: 'win32', run, now: () => NOW });

    writeStatus(trained, 'hey_echo', {
      phrase: 'hey echo',
      state: 'running',
      stage: 'generate',
      stageLabel: 'Generating spoken clips',
      progress: 0.31,
      message: '64,000 clips',
      startedAt: '2026-10-30T01:00:00Z',
      updatedAt: '2026-10-30T02:59:55Z',
    });
    expect((await trainer.getStatus()).job).toMatchObject({ state: 'running', progress: 0.31, stage: 'generate' });

    writeStatus(trained, 'hey_echo', {
      phrase: 'hey echo',
      state: 'running',
      stage: 'train',
      stageLabel: 'Training the model',
      progress: 0.8,
      updatedAt: '2026-10-30T02:30:00Z',
    });
    expect((await trainer.getStatus()).job?.state).toBe('interrupted');

    writeStatus(trained, 'hey_echo', {
      phrase: 'hey echo',
      state: 'done',
      stage: 'export',
      stageLabel: 'Saving the model',
      progress: 1,
      updatedAt: '2026-10-30T02:59:00Z',
      result: { metrics: { recall: 0.52, falsePositivesPerHour: 0.8 } },
    });
    expect((await trainer.getStatus()).job).toMatchObject({
      state: 'done',
      model: path.join(trained, 'hey_echo.onnx'),
      metrics: { recall: 0.52, falsePositivesPerHour: 0.8 },
    });
  });

  it('cancels by signalling the script’s process group', async () => {
    const { scripts, trained, run } = setup();
    const onStatus = vi.fn();
    trainer = new WakeWordTrainer({ trainedDirectory: trained, scriptsDirectory: scripts, platform: 'win32', run, now: () => NOW, onStatus });
    writeStatus(trained, 'computer', {
      phrase: 'computer',
      state: 'running',
      stage: 'augment',
      stageLabel: 'Adding background noise and reverb',
      progress: 0.6,
      pid: 4242,
      updatedAt: '2026-10-30T02:59:50Z',
    });

    const status = await trainer.cancel();
    expect(run).toHaveBeenCalledWith('wsl.exe', ['-d', 'Ubuntu-24.04', '--', 'kill', '-TERM', '--', '-4242']);
    expect(status.job?.state).toBe('cancelled');
    expect(JSON.parse(readFileSync(path.join(trained, 'jobs', 'computer', 'status.json'), 'utf8')).state).toBe('cancelled');
    expect(onStatus).toHaveBeenCalledWith(expect.objectContaining({ job: expect.objectContaining({ state: 'cancelled' }) }));
  });
});

describe('listWakeWords', () => {
  it('lists the bundled models, then trained ones with their phrase and metrics', async () => {
    const { trained } = setup();
    mkdirSync(trained, { recursive: true });
    writeFileSync(path.join(trained, 'hey_computer.onnx'), '');
    writeFileSync(
      path.join(trained, 'hey_computer.json'),
      JSON.stringify({ phrase: 'hey computer', trainedAt: '2026-10-30T02:00:00Z', metrics: { recall: 0.6 } }),
    );
    writeFileSync(path.join(trained, 'by_hand.onnx'), '');

    const options = await listWakeWords(trained);
    expect(options.slice(0, 2).map((option) => option.model)).toEqual(['hey_echo', 'hey_jarvis']);
    expect(options[0]).toEqual({ model: 'hey_echo', label: 'Hey Echo', source: 'builtin' });
    const trainedOptions = options.filter((option) => option.source === 'trained');
    expect(trainedOptions).toEqual([
      { model: path.join(trained, 'by_hand.onnx'), label: 'By Hand', source: 'trained' },
      {
        model: path.join(trained, 'hey_computer.onnx'),
        label: 'Hey Computer',
        source: 'trained',
        phrase: 'hey computer',
        trainedAt: '2026-10-30T02:00:00Z',
        metrics: { recall: 0.6 },
      },
    ]);
  });
});
