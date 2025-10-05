import { describe, expect, it } from 'vitest';
import { VadController } from '../../src/audio/vad-controller.js';

describe('VadController', () => {
  it('activates when level exceeds threshold and holds for release window', () => {
    const vad = new VadController({ activationThreshold: 0.2, releaseMs: 200 });

    const first = vad.update(0.3, 0);
    expect(first).toEqual({ isActive: true, changed: true });

    const hold = vad.update(0.05, 150);
    expect(hold).toEqual({ isActive: true, changed: false });

    const release = vad.update(0.05, 300);
    expect(release).toEqual({ isActive: false, changed: true });
  });

  it('remains inactive for low levels', () => {
    const vad = new VadController({ activationThreshold: 0.4, releaseMs: 100 });
    const result = vad.update(0.1, 0);
    expect(result).toEqual({ isActive: false, changed: false });
  });
});
