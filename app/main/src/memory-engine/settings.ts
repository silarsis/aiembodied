/** Where the memory engine is, from the environment (the models dialog takes this over later). */
export interface MemoryEngineSettings {
  enabled: boolean;
  url: string;
  apiToken?: string;
}

export const DEFAULT_MEMORY_SERVICE_URL = 'http://127.0.0.1:8194';

export function memoryEngineSettings(env: NodeJS.ProcessEnv = process.env): MemoryEngineSettings {
  const flag = (env.MEMORY_ENABLED ?? '').trim().toLowerCase();
  return {
    enabled: !['0', 'false', 'no', 'off'].includes(flag),
    url: env.MEMORY_SERVICE_URL?.trim() || DEFAULT_MEMORY_SERVICE_URL,
    apiToken: env.MEMORY_API_TOKEN?.trim() || undefined,
  };
}
