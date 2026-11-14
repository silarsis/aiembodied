import { describe, expect, it, vi } from 'vitest';
import { WakeWordListeningController } from '../src/wake-word/listening-controller.js';
import type { WakeWordConfig } from '../src/config/config-manager.js';

const CONFIG: WakeWordConfig = { model: 'hey_echo', keywordLabel: 'Hey Echo', threshold: 0.5, cooldownMs: 1500 };

function setup() {
  const disposed: number[] = [];
  const start = vi.fn((_config: WakeWordConfig) => {
    const index = start.mock.calls.length - 1;
    return { dispose: async () => void disposed.push(index) };
  });
  return { controller: new WakeWordListeningController(start), start, disposed };
}

describe('WakeWordListeningController gate', () => {
  it('is open by default, so nothing changes until something closes it', async () => {
    const { controller, start } = setup();
    await controller.configure(CONFIG);
    await controller.setEnabled(true);
    expect(controller.enabled).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('closing the gate releases the microphone and gates events at once; opening it resumes', async () => {
    const { controller, start, disposed } = setup();
    await controller.configure(CONFIG);
    await controller.setEnabled(true);
    const closing = controller.setGate(false);
    expect(controller.enabled).toBe(false);
    await closing;
    expect(disposed).toEqual([0]);
    await controller.setGate(true);
    expect(controller.enabled).toBe(true);
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('a closed gate does not start listening when the page asks for it, and the page\'s intent is kept', async () => {
    const { controller, start } = setup();
    await controller.configure(CONFIG);
    await controller.setGate(false);
    await controller.setEnabled(true);
    expect(start).not.toHaveBeenCalled();
    await controller.setGate(true);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('opening the gate does not listen when the page turned listening off', async () => {
    const { controller, start } = setup();
    await controller.configure(CONFIG);
    await controller.setEnabled(false);
    await controller.setGate(false);
    await controller.setGate(true);
    expect(start).not.toHaveBeenCalled();
  });
});
