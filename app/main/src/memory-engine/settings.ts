/** Where the memory engine is, from the environment (the models dialog takes this over later). */
export interface MemoryEngineSettings {
  enabled: boolean;
  url: string;
  apiToken?: string;
  /** Give each new conversation a brief: the time, saved facts, how the last talk ended. */
  brief?: boolean;
  /** Add strongly matching memories to a user message before the model sees it. */
  autoRecall?: boolean;
}

export const DEFAULT_MEMORY_SERVICE_URL = 'http://127.0.0.1:8194';

function isOff(value: string | undefined): boolean {
  return ['0', 'false', 'no', 'off'].includes((value ?? '').trim().toLowerCase());
}

export function memoryEngineSettings(env: NodeJS.ProcessEnv = process.env): MemoryEngineSettings {
  return {
    enabled: !isOff(env.MEMORY_ENABLED),
    brief: !isOff(env.MEMORY_BRIEF),
    autoRecall: !isOff(env.MEMORY_AUTO_RECALL),
    url: env.MEMORY_SERVICE_URL?.trim() || DEFAULT_MEMORY_SERVICE_URL,
    apiToken: env.MEMORY_API_TOKEN?.trim() || undefined,
  };
}
