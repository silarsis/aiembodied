import { describe, it } from 'vitest';

export const hasOpenAIKey = Boolean(process.env.OPENAI_API_KEY?.trim());
export const hasRealtimeKey = Boolean(
  process.env.REALTIME_API_KEY?.trim() || process.env.realtime_api_key?.trim(),
);
export const hasPorcupineKey = Boolean(
  process.env.PORCUPINE_ACCESS_KEY?.trim() || process.env.porcupine_access_key?.trim(),
);

export const describeIf: (cond: boolean) => typeof describe = (cond) =>
  (cond ? describe : (describe.skip as typeof describe));

export const itIf: (cond: boolean) => typeof it = (cond) => (cond ? it : (it.skip as typeof it));

// Usage example:
// itIf(hasRealtimeKey)('connects to realtime with live key', async () => { /* ... */ });

