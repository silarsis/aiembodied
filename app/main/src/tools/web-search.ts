/**
 * The built-in web_search tool, registered in the ToolRegistry so the local conversation offers
 * it to the model alongside any MCP tools. The search itself is done by a provider chosen with
 * WEB_SEARCH_PROVIDER; with none configured the tool is not registered.
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

/**
 * The provider WEB_SEARCH_PROVIDER names, or null when it is unset. No provider is wired yet:
 * an unknown name is reported so a typo does not look like search silently working.
 */
export function createWebSearchProvider(
  name: string | undefined,
  logger?: Pick<Console, 'warn'>,
): WebSearchProvider | null {
  const provider = name?.trim().toLowerCase();
  if (!provider) {
    return null;
  }
  logger?.warn('Unknown WEB_SEARCH_PROVIDER; web search is disabled.', { provider });
  return null;
}

function readQuery(params: unknown): string {
  const query = (params as { query?: unknown } | null)?.query;
  return typeof query === 'string' ? query.trim() : '';
}
