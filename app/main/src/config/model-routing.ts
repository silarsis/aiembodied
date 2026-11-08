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

export type ServerType =
  | 'chat'
  | 'transcribe'
  | 'speech'
  | 'motion'
  | 'comfy'
  | 'search'
  | 'memory'
  | 'openai'
  | 'brave'
  | 'civitai'
  | 'huggingface'
  | 'homeassistant'
  | 'anthropic'
  | 'github'
  | 'coder';
export const SERVER_TYPES: readonly ServerType[] = [
  'chat', 'transcribe', 'speech', 'motion', 'comfy', 'search', 'memory', 'homeassistant', 'coder', 'openai', 'anthropic', 'github', 'brave', 'civitai', 'huggingface',
];
/**
 * Types a user can add more servers of. OpenAI, Brave, Civitai and Hugging Face are one account each; Civitai and
 * Hugging Face run no job, they supply model downloads.
 * Home Assistant runs no job either: the memory engine watches the homes listed here.
 * Anthropic and GitHub are one account each (GitHub holds the token for pull requests). A coding
 * runner runs no job as such: the Coding page picks which one takes the tasks, so one on another
 * machine can be added.
 */
export const ADDABLE_SERVER_TYPES: readonly ServerType[] = ['chat', 'transcribe', 'speech', 'motion', 'comfy', 'search', 'memory', 'homeassistant', 'coder'];

export type UseId =
  | 'llm'
  | 'stt'
  | 'tts'
  | 'motion'
  | 'search'
  | 'image'
  | 'mesh'
  | 'describe'
  | 'posegen'
  | 'posecheck'
  | 'clips'
  | 'memory'
  | 'memorymirror'
  | 'coding';
export const USE_IDS: readonly UseId[] = [
  'llm',
  'stt',
  'tts',
  'motion',
  'search',
  'image',
  'mesh',
  'describe',
  'posegen',
  'posecheck',
  'clips',
  'memory',
  'memorymirror',
  'coding',
];
/** Uses that can be turned off (no server). */
export const USES_THAT_CAN_BE_OFF: readonly UseId[] = ['search', 'memorymirror'];

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
  // Long-term memory: the PostgreSQL database the memory engine keeps everything in, and an
  // optional second one it copies everything to (such as Supabase).
  memory: ['memory'],
  memorymirror: ['memory'],
  // The model the coding agent (pi, run by services/coder) works with.
  coding: ['chat', 'openai', 'anthropic'],
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
  memory: 'local-memory',
  coderRunner: 'local-coder-runner',
  coderLlm: 'local-coder-llm',
  openai: 'openai',
  anthropic: 'anthropic',
  github: 'github',
  brave: 'brave',
  civitai: 'civitai',
  huggingface: 'huggingface',
} as const;

export const OPENAI_BASE_URL = 'https://api.openai.com/v1';
export const ANTHROPIC_BASE_URL = 'https://api.anthropic.com';
export const GITHUB_API_URL = 'https://api.github.com';
export const DEFAULT_CODER_RUNNER_URL = 'http://127.0.0.1:8195';
/** The llama-server that runs Qwen3-Coder-Next while a coding task needs it. */
export const DEFAULT_CODER_LLM_URL = 'http://127.0.0.1:1236/v1';
export const DEFAULT_CODER_MODEL = 'qwen3-coder-next';
export const BRAVE_BASE_URL = 'https://api.search.brave.com';
export const CIVITAI_BASE_URL = 'https://civitai.com';
export const HUGGINGFACE_BASE_URL = 'https://huggingface.co';
/**
 * The memory engine's own database on this PC (services/memory starts it). Only shown: picking
 * this server tells the engine to use its own database, whatever address it was started with.
 */
export const LOCAL_MEMORY_DATABASE_URL = 'postgresql://127.0.0.1:5433/memory';

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
  /** CODING_RUNNER_URL. */
  coderRunnerUrl?: string;
  /** CODER_LLM_URL. */
  coderLlmUrl?: string;
}

export const DEFAULT_SEARXNG_URL = 'http://127.0.0.1:8888';
/** The models the helpers used before they became settings. */
export const DEFAULT_HELPER_MODELS: Record<'describe' | 'posegen' | 'posecheck', string> = {
  describe: 'gpt-4.1-mini',
  posegen: 'gpt-4.1-mini',
  posecheck: 'gpt-4o',
};

export function builtInServers({ providers, comfyUiBaseUrl, searxngUrl, coderRunnerUrl, coderLlmUrl }: BuiltInServerSources): ModelServer[] {
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
    local(BUILT_IN_SERVER_IDS.memory, 'Memory database on this PC', 'memory', LOCAL_MEMORY_DATABASE_URL),
    local(BUILT_IN_SERVER_IDS.coderRunner, 'Coding runner on this PC', 'coder', coderRunnerUrl || DEFAULT_CODER_RUNNER_URL),
    local(BUILT_IN_SERVER_IDS.coderLlm, 'Qwen3-Coder-Next (coding)', 'chat', coderLlmUrl || DEFAULT_CODER_LLM_URL),
    { id: BUILT_IN_SERVER_IDS.openai, name: 'OpenAI', type: 'openai', url: OPENAI_BASE_URL, builtIn: true, managed: false },
    { id: BUILT_IN_SERVER_IDS.anthropic, name: 'Anthropic', type: 'anthropic', url: ANTHROPIC_BASE_URL, builtIn: true, managed: false },
    { id: BUILT_IN_SERVER_IDS.github, name: 'GitHub', type: 'github', url: GITHUB_API_URL, builtIn: true, managed: false },
    { id: BUILT_IN_SERVER_IDS.brave, name: 'Brave Search', type: 'brave', url: BRAVE_BASE_URL, builtIn: true, managed: false },
    { id: BUILT_IN_SERVER_IDS.civitai, name: 'Civitai', type: 'civitai', url: CIVITAI_BASE_URL, builtIn: true, managed: false },
    { id: BUILT_IN_SERVER_IDS.huggingface, name: 'Hugging Face', type: 'huggingface', url: HUGGINGFACE_BASE_URL, builtIn: true, managed: false },
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
    memory: { server: BUILT_IN_SERVER_IDS.memory },
    memorymirror: { server: '' },
    coding: { server: BUILT_IN_SERVER_IDS.coderLlm, model: DEFAULT_CODER_MODEL },
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
    const fixed = server.type === 'openai' || server.type === 'anthropic' || server.type === 'github' || server.type === 'brave' || server.type === 'civitai' || server.type === 'huggingface' || server.id === BUILT_IN_SERVER_IDS.memory;
    const url = override.url && !fixed ? serverUrl(server.type, override.url) : server.url;
    return { ...server, name: override.name || server.name, url, managed: server.managed && isLocalUrl(url) };
  });
  for (const entry of stored.servers ?? []) {
    if (servers.some((server) => server.id === entry.id)) continue;
    if (!entry.type || !ADDABLE_SERVER_TYPES.includes(entry.type) || !entry.url) continue;
    servers.push({ id: entry.id, name: entry.name || entry.url, type: entry.type, url: serverUrl(entry.type, entry.url), builtIn: false, managed: false });
  }

  const routes: Partial<Record<UseId, ModelRoute>> = {};
  for (const use of USE_IDS) {
    const saved = stored.routes?.[use];
    const fits = (id: string) => {
      const server = servers.find((entry) => entry.id === id);
      return Boolean(server && USE_SERVER_TYPES[use].includes(server.type));
    };
    const base = saved && (fits(saved.server) || (USES_THAT_CAN_BE_OFF.includes(use) && saved.server === '')) ? saved : defaults[use];
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

/**
 * A server that takes a use's jobs first for a while, whatever the saved route says. The coding
 * model swap uses it to let Echo's chat run on the coder model while Echo's own model is stopped.
 */
export interface RouteOverride {
  server: ModelServer;
  model?: string;
  /** Servers left out meanwhile, such as the one that was stopped to make room. */
  exclude?: string[];
}

/** routeTargets with the override put first and its excluded servers left out. */
export function routeTargetsWithOverride(
  routing: ModelRouting,
  use: UseId,
  override: RouteOverride | null | undefined,
): Array<{ server: ModelServer; model?: string }> {
  const targets = routeTargets(routing, use);
  if (!override) return targets;
  const skip = new Set([override.server.id, ...(override.exclude ?? [])]);
  return [{ server: override.server, model: override.model }, ...targets.filter(({ server }) => !skip.has(server.id))];
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

/**
 * A server's address as the app uses it. OpenAI-compatible servers (llama-server, LM Studio,
 * vLLM, Ollama) serve their API under /v1, so an address with no path gets /v1 added.
 */
export function serverUrl(type: ServerType, url: string): string {
  const trimmed = trimUrl(url);
  if (type === 'homeassistant') return trimUrl(trimmed.replace(/\/api\/?$/, ''));
  if (type !== 'chat' && type !== 'transcribe') return trimmed;
  try {
    const parsed = new URL(trimmed);
    if (parsed.pathname === '/' || parsed.pathname === '') return `${trimmed}/v1`;
  } catch {
    // Left as typed; saving checks the address.
  }
  return trimmed;
}

function trimUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** Web addresses, and PostgreSQL ones for memory databases. */
export const SERVER_PROTOCOLS: readonly string[] = ['http:', 'https:', 'postgres:', 'postgresql:'];

function validUrl(value: unknown): string | undefined {
  const raw = text(value);
  if (!raw) return undefined;
  try {
    const url = new URL(raw);
    return SERVER_PROTOCOLS.includes(url.protocol) ? trimUrl(raw) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A memory database address with its password taken out, so the address can be shown and saved
 * in preferences while the password goes to the key store. Supabase's connection strings carry
 * the password inline (postgresql://postgres.ref:PASSWORD@host:5432/postgres).
 */
export function splitDatabasePassword(url: string): { url: string; password?: string } {
  try {
    const parsed = new URL(url.trim());
    if (!parsed.password) return { url: trimUrl(url) };
    const password = decodeURIComponent(parsed.password);
    parsed.password = '';
    return { url: trimUrl(parsed.toString()), password };
  } catch {
    return { url: trimUrl(url) };
  }
}

/** A memory database address with the saved password put back in, for the memory engine only. */
export function databaseUrlWithPassword(url: string, password: string | undefined): string {
  if (!password) return url;
  try {
    const parsed = new URL(url);
    if (parsed.password) return url;
    parsed.password = encodeURIComponent(password);
    return parsed.toString();
  } catch {
    return url;
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

/** The text-to-speech engines in services/speech. */
export type SpeakingEngineId = 'kokoro' | 'kitten' | 'piper';
export const SPEAKING_ENGINES: readonly SpeakingEngineId[] = ['kokoro', 'kitten', 'piper'];
export const DEFAULT_KITTEN_MODEL = 'mini-0.8';

/**
 * Which engine (and, for Kitten, which model) a speech-service Speaking route uses. Its `model`
 * holds "kokoro", "kitten:<model>" or "piper". Before there was a choice it held a Kokoro voice
 * name, which still means Kokoro with that voice.
 */
export function parseSpeakingModel(model?: string): { engine: SpeakingEngineId; model?: string; legacyVoice?: string } {
  const value = model?.trim() ?? '';
  if (!value || value === 'kokoro') return { engine: 'kokoro' };
  if (value === 'piper') return { engine: 'piper' };
  if (value === 'kitten' || value.startsWith('kitten:')) {
    return { engine: 'kitten', model: value.slice('kitten:'.length) || DEFAULT_KITTEN_MODEL };
  }
  return { engine: 'kokoro', legacyVoice: value };
}

export function formatSpeakingModel(engine: SpeakingEngineId, model?: string): string {
  return engine === 'kitten' ? `kitten:${model || DEFAULT_KITTEN_MODEL}` : engine;
}

/** The Realtime API's voices, for OpenAI speaking and the Realtime conversation engine. */
export const OPENAI_TTS_VOICES = ['alloy', 'ash', 'ballad', 'cedar', 'coral', 'echo', 'marin', 'sage', 'shimmer', 'verse'] as const;

/**
 * What a character's voice choice is saved for: each engine has its own voices, so a character
 * keeps one per engine. Null when nothing speaks.
 */
export function speakingVoiceKey(routing: ModelRouting): SpeakingEngineId | 'openai' | null {
  const target = routeTargets(routing, 'tts')[0];
  if (!target) return null;
  if (target.server.type === 'openai') return 'openai';
  return parseSpeakingModel(target.model).engine;
}
