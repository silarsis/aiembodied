export function calculateRms(samples: Float32Array): number {
  if (samples.length === 0) {
    return 0;
  }

  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const value = samples[index];
    sum += value * value;
  }

  return Math.sqrt(sum / samples.length);
}

export function normalizeAudioLevel(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) {
    return 0;
  }

  const clamped = Math.min(1, Math.max(0, rms));
  return Math.sqrt(clamped);
}
