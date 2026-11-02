/**
 * Which server runs each job ("use") the app has for a model: thinking, hearing, speaking,
 * moving, web search, avatar images and 3D, and the helper jobs (describing the avatar, making and
 * checking poses, animation clips).
 *
 * Servers are a list. The built-in ones are this PC's services (the URLs from provider settings
 * and the environment) plus OpenAI and Brave Search; the user can add more, such as a ComfyUI or
 * an OpenAI-compatible chat server on another machine, and pick them for any use their type can
 * do. A use can also name backup servers, tried in order when the first one fails, and image and
 * 3D jobs can be spread over whichever of their servers is least busy.
 *
 * Nothing here talks to a server: model-server-probe.ts does that. This module only resolves the
 * built-in defaults, what the user saved, and the env-derived provider settings into one routing.
 */
import type { ProviderSettings } from './provider-settings.js';

export type ServerType = 'chat' | 'transcribe' | 'speech' | 'motion' | 'comfy' | 'search' | 'openai' | 'brave';
export const SERVER_TYPES: readonly ServerType[] = ['chat', 'transcribe', 'speech', 'motion', 'comfy', 'search', 'openai', 'brave'];
/** Types a user can add more servers of. OpenAI and Brave are one account each. */
export const ADDABLE_SERVER_TYPES: readonly ServerType[] = ['chat', 'transcribe', 'speech', 'motion', 'comfy', 'search'];

export type UseId = 'llm' | 'stt' | 'tts' | 'motion' | 'search' | 'image' | 'mesh' | 'describe' | 'posegen' | 'posecheck' | 'clips';
export const USE_IDS: readonly UseId[] = ['llm', 'stt', 'tts', 'motion', 'search', 'image', 'mesh', 'describe', 'posegen', 'posecheck', 'clips'];

/** The server types that can do each use. */
export const USE_SERVER_TYPES: Record<UseId, readonly ServerType[]> = {
  llm: ['chat', 'openai'],
  stt: ['speech', 'transcribe', 'openai'],
  tts: ['speech', 'openai'],
  motion: ['motion', 'openai'],
  search: ['search', 'brave'],
  image: ['comfy'],
  mesh: ['comfy'],
  describe: ['chat', 'openai'],
  posegen: ['chat', 'openai'],
  posecheck: ['chat', 'openai'],
  clips: ['chat', 'openai'],
};
/** Uses that try backup servers when the first one fails. The others use only their first server. */
export const USES_WITH_BACKUPS: readonly UseId[] = ['llm', 'stt', 'tts', 'search', 'image', 'mesh'];
/** Uses that can send each job to whichever of their servers is least busy. */
export const USES_WITH_SPREAD: readonly UseId[] = ['image', 'mesh'];

export const BUILT_IN_SERVER_IDS = {
  llm: 'local-llm',
  speech: 'local-speech',
  motion: 'local-motion',
  comfy: 'local-comfy',
  searxng: 'local-searxng',
  openai: 'openai',
  brave: 'brave',
} as const;

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const BRAVE_BASE_URL = 'https://api.search.brave.com';

export interface ModelServer {
  id: string;
  name: string;
  type: ServerType;
  url: string;
  /** Built in: can be renamed or pointed elsewhere, never removed. */
  builtIn: boolean;
  /** On this PC and started by the app or pnpm dev:run when a use needs it. */
  managed: boolean;
}

export interface RouteTarget {
  server: string;
  /** Empty: the server's default (or, for a backup, the same model as the first server). */
  model?: string;
}

export interface ModelRoute extends RouteTarget {
  /** Tried in order when the servers before them fail. */
  backups?: RouteTarget[];
  /** Image and 3D only: send each job to whichever server is least busy. */
  spread?: boolean;
  /** OpenAI text-to-speech only: the Realtime voice and speaking style. */
  voice?: string;
  style?: string;
}

export interface ModelRouting {
  servers: ModelServer[];
  routes: Record<UseId, ModelRoute>;
}

/** What preferences.json keeps: only what the user changed. */
export interface StoredModels {
  /** Added servers, and renamed or moved built-in ones (by id). */
  servers?: Array<{ id: string; name?: string; type?: ServerType; url?: string }>;
  routes?: Partial<Record<UseId, ModelRoute>>;
}

export interface BuiltInServerSources {
  providers: ProviderSettings;
  comfyUiBaseUrl: string;
  searxngUrl?: string;
}

export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
/** The models the helpers used before they became settings. */
export const DEFAULT_HELPER_MODELS: Record<'describe' | 'posegen' | 'posecheck', string> = {
  describe: 'gpt-4.1-mini',
  posegen: 'gpt-4.1-mini',
  posecheck: 'gpt-4o',
};

export function builtInServers({ providers, comfyUiBaseUrl, searxngUrl }: BuiltInServerSources): ModelServer[] {
  const local = (id: string, name: string, type: ServerType, url: string): ModelServer => ({
    id,
    name,
    type,
    url: trimUrl(url),
    builtIn: true,
    managed: isLocalUrl(url),
  });
  return [
    local(BUILT_IN_SERVER_IDS.llm, 'Language model on this PC', 'chat', providers.llm.localBaseUrl),
    local(BUILT_IN_SERVER_IDS.speech, 'Speech service on this PC', 'speech', providers.speechServiceUrl),
    local(BUILT_IN_SERVER_IDS.motion, 'Motion service on this PC', 'motion', providers.motion.localServiceUrl),
    local(BUILT_IN_SERVER_IDS.comfy, 'ComfyUI on this PC', 'comfy', comfyUiBaseUrl),
    local(BUILT_IN_SERVER_IDS.searxng, 'SearXNG on this PC', 'search', searxngUrl || DEFAULT_SEARXNG_URL),
    { id: BUILT_IN_SERVER_IDS.openai, name: 'OpenAI', type: 'openai', url: OPENAI_BASE_URL, builtIn: true, managed: false },
    { id: BUILT_IN_SERVER_IDS.brave, name: 'Brave Search', type: 'brave', url: BRAVE_BASE_URL, builtIn: true, managed: false },
  ];
}

/**
 * The routes before the user changes anything: what provider settings and env vars already say,
 * so upgrading changes nothing. `webSearchProvider` is WEB_SEARCH_PROVIDER ("searxng,brave", "off").
 */
export function defaultRoutes(providers: ProviderSettings, webSearchProvider = 'searxng'): Record<UseId, ModelRoute> {
  const openai = BUILT_IN_SERVER_IDS.openai;
  const searchNames = webSearchProvider
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  const searchServers = searchNames
    .map((name): string | null => (name === 'searxng' ? BUILT_IN_SERVER_IDS.searxng : name === 'brave' ? BUILT_IN_SERVER_IDS.brave : null))
    .filter((id): id is string => Boolean(id));
  return {
    llm:
      providers.llm.provider === 'openai'
        ? { server: openai, model: providers.llm.openaiModel }
        : { server: BUILT_IN_SERVER_IDS.llm, model: providers.llm.localModel },
    stt:
      providers.stt.provider === 'openai'
        ? { server: openai, model: providers.stt.openaiModel }
        : { server: BUILT_IN_SERVER_IDS.speech },
    tts:
      providers.tts.provider === 'openai'
        ? {
            server: openai,
            model: providers.tts.openaiModel,
            voice: providers.tts.openaiVoice,
            ...(providers.tts.openaiInstructions ? { style: providers.tts.openaiInstructions } : {}),
          }
        : { server: BUILT_IN_SERVER_IDS.speech, ...(providers.tts.kokoroVoice ? { model: providers.tts.kokoroVoice } : {}) },
    motion:
      providers.motion.provider === 'openai'
        ? { server: openai, model: providers.motion.openaiModel }
        : { server: BUILT_IN_SERVER_IDS.motion, model: providers.motion.localBackend },
    search: searchServers.length
      ? { server: searchServers[0], backups: searchServers.slice(1).map((server) => ({ server })) }
      : { server: '' },
    image: { server: BUILT_IN_SERVER_IDS.comfy },
    mesh: { server: BUILT_IN_SERVER_IDS.comfy },
    describe: { server: openai, model: DEFAULT_HELPER_MODELS.describe },
    posegen: { server: openai, model: DEFAULT_HELPER_MODELS.posegen },
    posecheck: { server: openai, model: DEFAULT_HELPER_MODELS.posecheck },
    clips: { server: openai, model: providers.motion.openaiModel },
  };
}

/** Combine the built-in servers, the defaults and what the user saved, dropping anything invalid. */
export function resolveModelRouting(
  builtIns: ModelServer[],
  defaults: Record<UseId, ModelRoute>,
  stored: StoredModels = {},
): ModelRouting {
  const servers = builtIns.map((server) => {
    const override = stored.servers?.find((entry) => entry.id === server.id);
    if (!override) return { ...server };
    const url = override.url && server.type !== 'openai' && server.type !== 'brave' ? trimUrl(override.url) : server.url;
    return { ...server, name: override.name || server.name, url, managed: server.managed && isLocalUrl(url) };
  });
  for (const entry of stored.servers ?? []) {
    if (servers.some((server) => server.id === entry.id)) continue;
    if (!entry.type || !ADDABLE_SERVER_TYPES.includes(entry.type) || !entry.url) continue;
    servers.push({ id: entry.id, name: entry.name || entry.url, type: entry.type, url: trimUrl(entry.url), builtIn: false, managed: false });
  }

  const routes: Partial<Record<UseId, ModelRoute>> = {};
  for (const use of USE_IDS) {
    const saved = stored.routes?.[use];
    const fits = (id: string) => {
      const server = servers.find((entry) => entry.id === id);
      return Boolean(server && USE_SERVER_TYPES[use].includes(server.type));
    };
    const base = saved && (fits(saved.server) || (use === 'search' && saved.server === '')) ? saved : defaults[use];
    const primary = base.server;
    const seen = new Set([primary]);
    const backups = USES_WITH_BACKUPS.includes(use)
      ? (base.backups ?? []).filter((target) => {
          if (!fits(target.server) || seen.has(target.server)) return false;
          seen.add(target.server);
          return true;
        })
      : [];
    routes[use] = {
      server: primary,
      ...(base.model ? { model: base.model } : {}),
      ...(backups.length ? { backups: backups.map((target) => ({ server: target.server, ...(target.model ? { model: target.model } : {}) })) } : {}),
      ...(USES_WITH_SPREAD.includes(use) && base.spread ? { spread: true } : {}),
      ...(use === 'tts' && base.voice ? { voice: base.voice } : {}),
      ...(use === 'tts' && base.style ? { style: base.style } : {}),
    };
  }
  return { servers, routes: routes as Record<UseId, ModelRoute> };
}

/** The servers a use tries, in order, with the model to ask each for. Unknown servers are skipped. */
export function routeTargets(routing: ModelRouting, use: UseId): Array<{ server: ModelServer; model?: string }> {
  const route = routing.routes[use];
  const targets: Array<{ server: ModelServer; model?: string }> = [];
  const primary = routing.servers.find((server) => server.id === route.server);
  if (!primary) return targets;
  targets.push({ server: primary, model: route.model });
  for (const backup of route.backups ?? []) {
    const server = routing.servers.find((entry) => entry.id === backup.server);
    if (!server) continue;
    // A backup of the same kind can run the same model; another kind falls back to its own default.
    targets.push({ server, model: backup.model || (server.type === primary.type ? route.model : undefined) });
  }
  return targets;
}

/** Keep only well-formed saved servers and routes. */
export function sanitizeStoredModels(input: unknown): StoredModels {
  if (!isRecord(input)) return {};
  const result: StoredModels = {};
  if (Array.isArray(input.servers)) {
    const servers = input.servers
      .filter(isRecord)
      .map((entry) => ({
        id: text(entry.id),
        name: text(entry.name),
        type: SERVER_TYPES.includes(entry.type as ServerType) ? (entry.type as ServerType) : undefined,
        url: validUrl(entry.url),
      }))
      .filter((entry): entry is { id: string; name: string | undefined; type: ServerType | undefined; url: string | undefined } =>
        Boolean(entry.id),
      )
      .map((entry) => compact(entry) as { id: string; name?: string; type?: ServerType; url?: string });
    if (servers.length) result.servers = servers;
  }
  if (isRecord(input.routes)) {
    const routes: Partial<Record<UseId, ModelRoute>> = {};
    for (const use of USE_IDS) {
      const route = input.routes[use];
      if (!isRecord(route) || typeof route.server !== 'string') continue;
      const backups = Array.isArray(route.backups)
        ? route.backups
            .filter(isRecord)
            .map((target) => compact({ server: text(target.server), model: text(target.model) }))
            .filter((target): target is RouteTarget => typeof target.server === 'string')
        : [];
      routes[use] = compact({
        server: route.server.trim(),
        model: text(route.model),
        backups: backups.length ? backups : undefined,
        spread: route.spread === true ? true : undefined,
        voice: text(route.voice),
        style: text(route.style),
      }) as ModelRoute;
    }
    if (Object.keys(routes).length) result.routes = routes;
  }
  return result;
}

export function isLocalUrl(url: string): boolean {
  try {
    return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(url).hostname);
  } catch {
    return false;
  }
}

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

function validUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return url.protocol === 'http:' || url.protocol === 'https:' ? trimUrl(raw) : undefined;
  } catch {
    return undefined;
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function compact<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as Partial<T>;
}
