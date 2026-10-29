/**
 * The built-in web_search tool, registered in the ToolRegistry so the local conversation offers
 * it to the model alongside any MCP tools. The search itself is done by a provider chosen with
 * WEB_SEARCH_PROVIDER (searxng, brave, or both in fallback order); with none configured the
 * tool is not registered.
 */
import type { RegisteredTool } from './tool-registry.js';

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface WebSearchProvider {
  readonly name: string;
  search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
}

export const WEB_SEARCH_TOOL_ID = 'builtin:web_search';
const DEFAULT_RESULT_LIMIT = 5;
const MAX_SNIPPET_CHARS = 300;
const SEARCH_TIMEOUT_MS = 8000;

export function createWebSearchTool(
  provider: WebSearchProvider,
  options: { limit?: number; timeoutMs?: number } = {},
): RegisteredTool {
  const limit = options.limit ?? DEFAULT_RESULT_LIMIT;
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  return {
    id: WEB_SEARCH_TOOL_ID,
    serverId: 'builtin',
    toolName: 'web_search',
    description:
      'Search the web for current information: news, facts you are unsure of, prices, opening hours, ' +
      'weather, sports results, or anything after your training. Returns the top results with a snippet each.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'What to search for, as you would type it into a search engine.' },
      },
      required: ['query'],
    },
    enabled: true,
    confirmationLevel: 'none',
    spokenNotice: 'Let me look that up.',
    describeCall: (params) => readQuery(params),
    execute: async (params) => {
      const query = readQuery(params);
      if (!query) {
        throw new Error('web_search needs a non-empty "query".');
      }
      const results = await provider.search(query, { limit, signal: AbortSignal.timeout(timeoutMs) });
      return {
        query,
        results: results.slice(0, limit).map((result) => ({
          title: result.title.trim(),
          url: result.url,
          snippet: result.snippet.replace(/\s+/g, ' ').trim().slice(0, MAX_SNIPPET_CHARS),
        })),
      };
    },
  };
}

export interface WebSearchSettings {
  /** SEARXNG_URL: a SearXNG instance with JSON output enabled. */
  searxngUrl?: string;
  /** BRAVE_SEARCH_API_KEY: a Brave Search API subscription token. */
  braveApiKey?: string;
  fetchFn?: typeof fetch;
}

export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
const BRAVE_SEARCH_URL = 'https://api.search.brave.com/res/v1/web/search';
/** With a fallback behind it, one provider gets this long before the next is tried. */
const FALLBACK_ATTEMPT_MS = 4000;
const HTML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'", '#x27': "'", nbsp: ' ' };

/** WEB_SEARCH_PROVIDER when it is not set. "off" (or "none") disables web search. */
export const DEFAULT_WEB_SEARCH_PROVIDER = 'searxng';

/**
 * The provider WEB_SEARCH_PROVIDER names, or null when it is unset or "off". A comma-separated list
 * (e.g. "searxng,brave") tries each in order, moving on when one fails or finds nothing.
 * Unknown names and a brave entry with no API key are reported and left out, so a typo does
 * not look like search silently working.
 */
export function createWebSearchProvider(
  name: string | undefined,
  settings: WebSearchSettings = {},
  logger?: Pick<Console, 'warn'>,
): WebSearchProvider | null {
  const names = (name ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (names.length === 1 && (names[0] === 'off' || names[0] === 'none')) {
    return null;
  }
  const providers: WebSearchProvider[] = [];
  for (const provider of names) {
    if (provider === 'searxng') {
      providers.push(new SearxngSearchProvider(settings.searxngUrl || DEFAULT_SEARXNG_URL, settings.fetchFn));
    } else if (provider === 'brave') {
      if (settings.braveApiKey) {
        providers.push(new BraveSearchProvider(settings.braveApiKey, settings.fetchFn));
      } else {
        logger?.warn('WEB_SEARCH_PROVIDER includes brave but BRAVE_SEARCH_API_KEY is not set; skipping it.');
      }
    } else {
      logger?.warn('Unknown WEB_SEARCH_PROVIDER; skipping it.', { provider });
    }
  }
  if (providers.length === 0) {
    if (names.length > 0) {
      logger?.warn('No usable WEB_SEARCH_PROVIDER; web search is disabled.', { provider: name });
    }
    return null;
  }
  return providers.length === 1 ? providers[0] : new FallbackSearchProvider(providers);
}

/** SearXNG's JSON API. The instance must list json under search.formats, or it answers 403. */
export class SearxngSearchProvider implements WebSearchProvider {
  readonly name = 'searxng';
  private readonly baseUrl: string;

  constructor(baseUrl: string, private readonly fetchFn: typeof fetch = fetch) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const url = new URL(`${this.baseUrl}/search`);
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    let response: Response;
    try {
      response = await this.fetchFn(url, { headers: { Accept: 'application/json' }, signal: options.signal });
    } catch (error) {
      // The model reads this as the tool's error, so say plainly that search itself is unavailable.
      if (options.signal?.aborted) {
        throw new Error(`Web search is unavailable: SearXNG at ${this.baseUrl} did not answer in time.`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Web search is unavailable: could not reach SearXNG at ${this.baseUrl} (${reason}).`);
    }
    if (response.status === 403) {
      throw new Error('Web search is unavailable: SearXNG refused JSON output (403); add json to search.formats in its settings.yml.');
    }
    if (!response.ok) {
      throw new Error(`Web search is unavailable: SearXNG answered HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { results?: Array<{ title?: unknown; url?: unknown; content?: unknown }> };
    return toResults(body.results, 'content', options.limit);
  }
}

/** The Brave Search API web endpoint. */
export class BraveSearchProvider implements WebSearchProvider {
  readonly name = 'brave';

  constructor(private readonly apiKey: string, private readonly fetchFn: typeof fetch = fetch) {}

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    const url = new URL(BRAVE_SEARCH_URL);
    url.searchParams.set('q', query);
    url.searchParams.set('count', String(Math.min(Math.max(options.limit, 1), 20)));
    const response = await this.fetchFn(url, {
      headers: { Accept: 'application/json', 'X-Subscription-Token': this.apiKey },
      signal: options.signal,
    });
    if (response.status === 401 || response.status === 403) {
      throw new Error(`Brave Search rejected the API key (HTTP ${response.status}): check BRAVE_SEARCH_API_KEY.`);
    }
    if (response.status === 429) {
      throw new Error('Brave Search rate limit or monthly quota reached (HTTP 429).');
    }
    if (!response.ok) {
      throw new Error(`Brave Search failed with HTTP ${response.status}.`);
    }
    const body = (await response.json()) as { web?: { results?: Array<{ title?: unknown; url?: unknown; description?: unknown }> } };
    return toResults(body.web?.results, 'description', options.limit);
  }
}

/** Tries each provider in turn until one returns results; reports the last error if none do. */
export class FallbackSearchProvider implements WebSearchProvider {
  readonly name: string;

  constructor(
    private readonly providers: WebSearchProvider[],
    private readonly attemptMs = FALLBACK_ATTEMPT_MS,
  ) {
    this.name = providers.map((provider) => provider.name).join(',');
  }

  async search(query: string, options: { limit: number; signal?: AbortSignal }): Promise<WebSearchResult[]> {
    let lastError: unknown;
    for (const [index, provider] of this.providers.entries()) {
      options.signal?.throwIfAborted();
      // Every provider but the last gets a slice of the time, so a hung one leaves room for the next.
      const isLast = index === this.providers.length - 1;
      const signals = [options.signal, isLast ? undefined : AbortSignal.timeout(this.attemptMs)].filter(
        (signal): signal is AbortSignal => Boolean(signal),
      );
      try {
        const results = await provider.search(query, {
          limit: options.limit,
          signal: signals.length > 0 ? AbortSignal.any(signals) : undefined,
        });
        if (results.length > 0) {
          return results;
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      throw lastError;
    }
    return [];
  }
}

function toResults(
  items: Array<Record<string, unknown>> | undefined,
  snippetKey: string,
  limit: number,
): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  for (const item of items ?? []) {
    if (typeof item.url !== 'string' || !item.url) {
      continue;
    }
    results.push({
      title: stripHtml(typeof item.title === 'string' ? item.title : item.url),
      url: item.url,
      snippet: stripHtml(typeof item[snippetKey] === 'string' ? (item[snippetKey] as string) : ''),
    });
    if (results.length >= limit) {
      break;
    }
  }
  return results;
}

/** Brave marks matches with <strong> and both escape entities; the model only needs the words. */
function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&(amp|lt|gt|quot|#39|#x27|nbsp);/g, (_, entity: string) => HTML_ENTITIES[entity] ?? '');
}

function readQuery(params: unknown): string {
  const query = (params as { query?: unknown } | null)?.query;
  return typeof query === 'string' ? query.trim() : '';
}
