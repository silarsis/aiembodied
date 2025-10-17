import OpenAI from 'openai';

const clientCache = new Map<string, OpenAI>();

export function getOpenAIClient(apiKey: string): OpenAI {
  const normalizedKey = apiKey?.trim();
  if (!normalizedKey) {
    throw new Error('An OpenAI API key is required to create a client instance.');
  }

  const cached = clientCache.get(normalizedKey);
  if (cached) {
    return cached;
  }

  const client = new OpenAI({ apiKey: normalizedKey });
  clientCache.set(normalizedKey, client);
  return client;
}

export function clearOpenAIClientCache(): void {
  clientCache.clear();
}
