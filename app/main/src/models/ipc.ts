import { ConfigManager } from '../config/config-manager.js';
import {
  lookupCivitai,
  parseCivitaiRef,
  planCivitaiDownload,
} from '../avatar/generation/civitai.js';
import { ModelDownloadService } from '../avatar/generation/model-downloads.js';
import { AicontrollerBridge } from '../aicontroller/bridge.js';
import { AUTO_HOST, RemoteDownloads } from '../aicontroller/remote-downloads.js';
import type { MemoryEngineRuntime } from '../memory-engine/index.js';
import { SpeechServiceClient } from '../local-voice/speech-service-client.js';
import {
  BUILT_IN_SERVER_IDS,
  databaseUrlWithPassword,
  serverUrl,
  USE_SERVER_TYPES,
  type ModelRoute,
  type ServerType,
  type UseId,
} from '../shared/config/model-routing.js';
import { probeMemoryDatabase, probeModelServer } from '../config/model-server-probe.js';
import { LocalLlmControl } from '../local-voice/local-llm-control.js';
import { lookupHuggingFace, parseHuggingFaceRef } from '../local-llm/huggingface.js';
import { LlmLibrary } from '../local-llm/llm-library.js';
import type { LocalLlmSettings } from '../shared/local-llm/llm-settings-types.js';
import { VisionModel } from '../local-vision/vision-model.js';
import { VisionServer } from '../local-vision/vision-server.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface ModelsIpcOptions {
  handle: HandleIpc;
  manager: ConfigManager;
  memoryEngine: () => MemoryEngineRuntime | null;
  aicontroller: AicontrollerBridge;
  modelDownloads: ModelDownloadService;
  comfyAddonDirectory: string;
  getLocalLlmTools: () => { library: LlmLibrary; control: LocalLlmControl };
  getVisionTools: () => { model: VisionModel; server: VisionServer };
  useLocalLlm: (id: string | null, settings?: Partial<LocalLlmSettings>) => Promise<string>;
  applyProviderSettings: () => Promise<void>;
}

export function registerModelsIpc(options: ModelsIpcOptions): void {
  const {
    handle,
    manager,
    memoryEngine,
    aicontroller,
    modelDownloads,
    comfyAddonDirectory,
    getLocalLlmTools,
    getVisionTools,
    useLocalLlm,
    applyProviderSettings,
  } = options;

  // Models and servers pop-up. Keys go in, never out: the view only says whether one is set.
  handle('models:get', () => manager.getModelRoutingView());
  handle(
    'models:probe',
    async (
      _event,
      payload: { serverId?: unknown; draft?: { type?: unknown; url?: unknown; key?: unknown } },
    ) => {
      if (typeof payload?.serverId === 'string') {
        const server = manager
          .getConfig()
          .models.servers.find((entry) => entry.id === payload.serverId);
        if (!server) throw new Error('That server no longer exists.');
        if (server.type === 'memory') {
          return probeMemoryDatabase(
            {
              url: databaseUrlWithPassword(server.url, manager.getServerKey(server.id)),
              local: server.id === BUILT_IN_SERVER_IDS.memory,
            },
            memoryEngine()?.client ?? null,
          );
        }
        return probeModelServer(server, manager.getServerKey(server.id));
      }
      const draft = payload?.draft;
      if (!draft || typeof draft.type !== 'string' || typeof draft.url !== 'string') {
        throw new Error('Choose a server type and address first.');
      }
      let url: string;
      try {
        url = new URL(draft.url.trim()).toString().replace(/\/+$/, '');
      } catch {
        throw new Error('Enter the server address as a URL, such as http://192.168.1.20:8188.');
      }
      const type = draft.type as ServerType;
      if (type === 'memory') {
        const password =
          typeof draft.key === 'string' && draft.key.trim() ? draft.key.trim() : undefined;
        return probeMemoryDatabase(
          { url: databaseUrlWithPassword(url, password), local: false },
          memoryEngine()?.client ?? null,
        );
      }
      return probeModelServer(
        { type, url: serverUrl(type, url) },
        typeof draft.key === 'string' ? draft.key : undefined,
      );
    },
  );
  handle(
    'models:save-server',
    async (
      _event,
      payload: { id?: unknown; name?: unknown; type?: unknown; url?: unknown; key?: unknown },
    ) => {
      const id = await manager.saveModelServer({
        id: typeof payload?.id === 'string' ? payload.id : undefined,
        name: typeof payload?.name === 'string' ? payload.name : undefined,
        type: typeof payload?.type === 'string' ? (payload.type as ServerType) : undefined,
        url: typeof payload?.url === 'string' ? payload.url : undefined,
      });
      if (typeof payload?.key === 'string' && payload.key.trim())
        await manager.setServerKey(id, payload.key);
      await applyProviderSettings();
      return { id, models: manager.getModelRoutingView() };
    },
  );
  handle('models:remove-server', async (_event, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Choose a server to remove.');
    await manager.removeModelServer(id);
    await applyProviderSettings();
    return manager.getModelRoutingView();
  });
  handle('models:set-route', async (_event, payload: { use?: unknown; route?: unknown }) => {
    const use = payload?.use as UseId;
    if (typeof use !== 'string' || !(use in USE_SERVER_TYPES))
      throw new Error('Unknown model use.');
    await manager.setModelRoute(use, (payload?.route ?? {}) as ModelRoute);
    await applyProviderSettings();
    return manager.getModelRoutingView();
  });
  const comfyServer = (serverId: unknown) => {
    const server = manager.getConfig().models.servers.find((entry) => entry.id === serverId);
    if (!server || server.type !== 'comfy') throw new Error('Choose a ComfyUI server.');
    return server;
  };
  handle(
    'models:civitai-lookup',
    async (_event, payload: { ref?: unknown; versionId?: unknown }) => {
      const ref = parseCivitaiRef(typeof payload?.ref === 'string' ? payload.ref : '');
      if (!ref)
        throw new Error(
          'Paste a Civitai link (civitai.com, .green or .red: a model page or download link) or an AIR (urn:air:…:civitai:123@456).',
        );
      const model = await lookupCivitai(ref, manager.getServerKey(BUILT_IN_SERVER_IDS.civitai));
      const versionId = typeof payload?.versionId === 'number' ? payload.versionId : undefined;
      return {
        versions: model.versions.map((version) => ({
          id: version.id,
          name: version.name,
          baseModel: version.baseModel,
        })),
        plan: planCivitaiDownload(model, versionId, ref.fileId),
      };
    },
  );
  // Downloads the model controller runs on another machine (or the one it picks).
  const remoteDownloads = new RemoteDownloads(aicontroller);
  /** A machine name or "auto" when the download goes through the controller, else null (this PC's own downloader). */
  const remoteHost = (value: unknown): string | null => {
    if (typeof value !== 'string' || !value.trim() || value === 'local') return null;
    if (!aicontroller.inUse())
      throw new Error(
        'The model controller is not running, so downloads to other machines are unavailable.',
      );
    return value === AUTO_HOST ? AUTO_HOST : value.trim();
  };
  handle('models:download-hosts', async () => {
    const { local, hosts } = await aicontroller.hostNames();
    return { inUse: aicontroller.inUse(), local, hosts };
  });
  handle(
    'models:download',
    async (
      _event,
      payload: { serverId?: unknown; ref?: unknown; versionId?: unknown; host?: unknown },
    ) => {
      const host = remoteHost(payload?.host);
      if (host) {
        const ref = parseCivitaiRef(typeof payload?.ref === 'string' ? payload.ref : '');
        if (!ref) throw new Error('Paste a Civitai model link or AIR.');
        const key = manager.getServerKey(BUILT_IN_SERVER_IDS.civitai);
        const model = await lookupCivitai(ref, key);
        const plan = planCivitaiDownload(
          model,
          typeof payload?.versionId === 'number' ? payload.versionId : undefined,
          ref.fileId,
        );
        return remoteDownloads.startCivitai(host, plan);
      }
      const server = comfyServer(payload?.serverId);
      const ref = parseCivitaiRef(typeof payload?.ref === 'string' ? payload.ref : '');
      if (!ref) throw new Error('Paste a Civitai model link or AIR.');
      const key = manager.getServerKey(BUILT_IN_SERVER_IDS.civitai);
      const model = await lookupCivitai(ref, key);
      const plan = planCivitaiDownload(
        model,
        typeof payload?.versionId === 'number' ? payload.versionId : undefined,
        ref.fileId,
      );
      if (!server.managed && !(await modelDownloads.hasAddon(server))) {
        throw new Error(
          `${server.name} needs the aiembodied ComfyUI add-on before it can download models. See "Add-on" on this page.`,
        );
      }
      return modelDownloads.start(server, plan, key);
    },
  );
  handle('models:downloads', async () => [
    ...modelDownloads.list(),
    ...(await remoteDownloads.listModels()),
  ]);
  const speechServerClient = (serverId: unknown) => {
    const server = manager
      .getConfig()
      .models.servers.find((entry) => entry.id === serverId && entry.type === 'speech');
    if (!server) throw new Error('That is not a speech service.');
    return new SpeechServiceClient({ baseUrl: server.url });
  };
  handle('models:speech-engines', (_event, serverId: unknown) =>
    speechServerClient(serverId).ttsEngines(),
  );
  handle(
    'models:speech-download',
    async (_event, payload: { serverId?: unknown; engine?: unknown; model?: unknown }) => {
      if (typeof payload?.engine !== 'string' || typeof payload.model !== 'string') {
        throw new Error('Pick a model to download.');
      }
      const client = speechServerClient(payload.serverId);
      await client.downloadTtsModel(payload.engine, payload.model);
      return client.ttsEngines();
    },
  );
  handle('models:cancel-download', async (_event, id: unknown) => {
    if (typeof id === 'string' && RemoteDownloads.isRemoteId(id)) await remoteDownloads.cancel(id);
    else if (typeof id === 'string') modelDownloads.cancel(id);
    return [...modelDownloads.list(), ...(await remoteDownloads.listModels())];
  });
  handle('models:comfy-addon', async (_event, serverId: unknown) => {
    const server = comfyServer(serverId);
    return { installed: await modelDownloads.hasAddon(server), folder: comfyAddonDirectory };
  });
  // Thinking models from Hugging Face, for this PC's llama-server.
  const hfToken = () => manager.getServerKey(BUILT_IN_SERVER_IDS.huggingface);
  const localLlmList = async () => {
    const { library } = getLocalLlmTools();
    return {
      ...(await library.read()),
      folder: library.modelsDirectory,
      settings: await library.settings(),
    };
  };
  handle('models:hf-lookup', async (_event, ref: unknown) => {
    const parsed = parseHuggingFaceRef(typeof ref === 'string' ? ref : '');
    if (!parsed)
      throw new Error(
        'Paste a Hugging Face link or repo name (such as unsloth/Qwen3-8B-GGUF), or type words to search for.',
      );
    return lookupHuggingFace(parsed, hfToken());
  });
  handle(
    'models:hf-download',
    async (_event, payload: { repo?: unknown; quant?: unknown; use?: unknown; host?: unknown }) => {
      if (typeof payload?.repo !== 'string' || typeof payload.quant !== 'string')
        throw new Error('Pick a model and size first.');
      // Read the repo again here rather than trusting file names from the page.
      const lookup = await lookupHuggingFace({ repo: payload.repo }, hfToken());
      const quant = lookup.quants.find((entry) => entry.id === payload.quant);
      if (!lookup.repo || !quant)
        throw new Error('That size is no longer in the repo. Look it up again.');
      const host = remoteHost(payload.host);
      if (host) return remoteDownloads.startHuggingFace(host, lookup.repo, quant);
      return getLocalLlmTools().library.start(lookup.repo, quant, {
        token: hfToken(),
        use: payload.use !== false,
        ...(lookup.contextLength ? { contextLength: lookup.contextLength } : {}),
      });
    },
  );
  handle('models:hf-downloads', async () => [
    ...getLocalLlmTools().library.list(),
    ...(await remoteDownloads.listLlm()),
  ]);
  handle('models:hf-cancel', async (_event, id: unknown) => {
    const { library } = getLocalLlmTools();
    if (typeof id === 'string' && RemoteDownloads.isRemoteId(id)) await remoteDownloads.cancel(id);
    else if (typeof id === 'string') library.cancel(id);
    return [...library.list(), ...(await remoteDownloads.listLlm())];
  });
  // The vision model (Qwen3-VL) for Describe the avatar: download status and progress.
  handle('models:vision-status', () => getVisionTools().model.status());
  handle('models:vision-download', async (_event, ref: unknown) => {
    const { model } = getVisionTools();
    await model.download(typeof ref === 'string' ? ref : undefined);
    return model.status();
  });
  handle('models:vision-cancel', async () => {
    const { model } = getVisionTools();
    model.cancel();
    return model.status();
  });
  handle('models:local-llms', () => localLlmList());
  handle('models:use-local-llm', async (_event, id: unknown, settings: unknown) => {
    const given =
      settings && typeof settings === 'object'
        ? (settings as Partial<LocalLlmSettings>)
        : undefined;
    const message = await useLocalLlm(typeof id === 'string' && id ? id : null, given);
    return { message, library: await localLlmList(), models: manager.getModelRoutingView() };
  });
  handle('models:delete-local-llm', async (_event, id: unknown) => {
    if (typeof id === 'string') await getLocalLlmTools().library.remove(id);
    return localLlmList();
  });
  handle('models:set-key', async (_event, payload: { serverId?: unknown; key?: unknown }) => {
    if (typeof payload?.serverId !== 'string') throw new Error('Choose a server.');
    await manager.setServerKey(
      payload.serverId,
      typeof payload.key === 'string' ? payload.key : '',
    );
    await applyProviderSettings();
    return manager.getModelRoutingView();
  });
}
