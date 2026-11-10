import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { ModelRoutingView, ModelServerView } from '../../../main/src/config/config-manager.js';
import {
  ADDABLE_SERVER_TYPES,
  USE_SERVER_TYPES,
  USES_WITH_BACKUPS,
  USES_WITH_SPREAD,
  USES_THAT_CAN_BE_OFF,
  BUILT_IN_SERVER_IDS,
  OPENAI_TTS_VOICES,
  type ModelRoute,
  type ServerType,
  type UseId,
} from '../../../main/src/config/model-routing.js';
import type { ModelRole, ServerProbe } from '../../../main/src/config/model-server-probe.js';
import type { CodingBridge } from '../../../main/src/coding/bridge-types.js';
import type { ModelsBridge } from '../preload-api.js';
import { CodingSettings } from './coding-settings.js';
import { ModelDownloads } from './model-downloads.js';
import { ThinkingDownloads } from './thinking-downloads.js';
import { VisionDownload } from './vision-download.js';
import type { AvatarBridge } from '../avatar/types.js';
import { useCharacterModels } from '../avatar/use-character-models.js';
import { useImageModels } from '../avatar/use-image-models.js';
import { SpeakingEngineFields } from './speaking-engines.js';

/** The Realtime API's voices, for OpenAI speaking and the Realtime engine. */
export const OPENAI_VOICES: string[] = [...OPENAI_TTS_VOICES];

interface UseInfo {
  id: UseId;
  group: 'Talking' | 'Creating an avatar' | 'Helpers' | 'Rooms' | 'Coding' | 'Memory';
  name: string;
  what: string;
  /** Kept in the config but not listed. */
  hidden?: boolean;
}

export const MODEL_USES: UseInfo[] = [
  { id: 'stt', group: 'Talking', name: 'Hearing', what: 'Turns what you say into text.' },
  { id: 'llm', group: 'Talking', name: 'Thinking', what: 'Writes the replies and decides on tool calls.' },
  { id: 'tts', group: 'Talking', name: 'Speaking', what: 'Reads the replies aloud.' },
  { id: 'motion', group: 'Talking', name: 'Moving', what: 'Body movement while the avatar talks.' },
  { id: 'search', group: 'Talking', name: 'Web search', what: 'The web_search tool the assistant can call.' },
  { id: 'image', group: 'Creating an avatar', name: 'Concept image', what: 'Draws the character from the description, repaints textures and makes backgrounds.' },
  { id: 'mesh', group: 'Creating an avatar', name: '3D model', what: 'Turns the approved image into a textured mesh. Rigging runs in Blender on this PC.' },
  { id: 'describe', group: 'Helpers', name: 'Describe the avatar', what: 'Looks at a screenshot of the avatar and writes a short character description that guides animation. Needs a model that reads images; it starts out on a small one that runs on this PC.' },
  // Nothing in the app makes or checks poses since the sidebar pose controls went (they come back
  // built on the motion service), so these routes stay in the config but are not shown.
  { id: 'posegen', group: 'Helpers', name: 'Make poses', what: 'Writes bone rotations for a pose from a text prompt.', hidden: true },
  { id: 'posecheck', group: 'Helpers', name: 'Check poses', what: 'Looks at a rendered pose and says whether it matches the prompt. Needs a model that reads images.', hidden: true },
  {
    id: 'clips',
    group: 'Helpers',
    name: 'Animation clips',
    what: 'Writes keyframe animation clips from a prompt when the motion service (ARDY) is not running or not picked for Moving. It starts out on the same model as Thinking.',
  },
  {
    id: 'idle',
    group: 'Rooms',
    name: 'Idle thoughts',
    what: 'Picks what the avatar does next on its own in a 3D room when nobody is talking. It starts out on the same model as Thinking; a small, fast model is enough.',
  },
  {
    id: 'scenelayout',
    group: 'Rooms',
    name: 'Room layout',
    what: 'Writes the furniture list and layout when you describe a 3D room. It starts out on the same model as Thinking; a larger model gives better rooms.',
  },
  {
    id: 'coding',
    group: 'Coding',
    name: 'Coding model',
    what: 'The model the coding agent works with. The local one is Qwen3-Coder-Next: while a task runs, the app swaps Echo’s chat model out and this one in.',
  },
  {
    id: 'memory',
    group: 'Memory',
    name: 'Memory database',
    what: 'Where long-term memory is kept: every conversation, fact and summary. Picking an empty database copies everything there first; one that already holds memory is used as it is, nothing is merged.',
  },
  {
    id: 'memorymirror',
    group: 'Memory',
    name: 'Memory mirror',
    what: 'An optional second database, such as Supabase, that gets a copy of everything within a minute or so. Deletes are copied too.',
  },
];
const USE_GROUPS = ['Talking', 'Creating an avatar', 'Helpers', 'Rooms', 'Coding', 'Memory'] as const;

export const SERVER_TYPE_LABELS: Record<ServerType, string> = {
  chat: 'Chat model server',
  transcribe: 'Transcription server',
  speech: 'Speech service',
  motion: 'Motion service',
  comfy: 'ComfyUI',
  search: 'SearXNG',
  memory: 'Memory database (PostgreSQL)',
  homeassistant: 'Home Assistant',
  coder: 'Coding runner',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  github: 'GitHub',
  brave: 'Brave Search',
  civitai: 'Civitai',
  huggingface: 'Hugging Face',
};

const SERVER_TYPE_HINTS: Partial<Record<ServerType, { hint: string; example: string }>> = {
  chat: { hint: 'Any OpenAI-compatible server: llama-server, LM Studio, vLLM, Ollama. An address with no path gets /v1 added.', example: 'http://192.168.1.20:1234/v1' },
  transcribe: { hint: 'An OpenAI-compatible /v1/audio/transcriptions server, such as speaches or whisper.cpp.', example: 'http://192.168.1.20:8000/v1' },
  speech: { hint: 'services/speech from this repo: Kokoro, Kitten TTS and Piper voices, and its speech recognition.', example: 'http://192.168.1.20:8192' },
  motion: { hint: 'services/motion from this repo, running ARDY or Kimodo.', example: 'http://192.168.1.20:8190' },
  comfy: { hint: 'Image, texture and 3D jobs. Needs the same models installed as this PC’s ComfyUI.', example: 'http://192.168.1.20:8188' },
  search: { hint: 'A SearXNG instance with JSON output turned on.', example: 'http://192.168.1.20:8888' },
  memory: {
    hint: 'A PostgreSQL database with the pgvector extension, such as Supabase (use its session pooler connection string). A password in the address is moved to the key store.',
    example: 'postgresql://postgres.yourproject@aws-0-region.pooler.supabase.com:5432/postgres',
  },
  coder: {
    hint: 'services/coder from this repo, running on another PC. It runs the pi coding agent in git worktrees on that PC. Pick it on the Coding page.',
    example: 'http://192.168.1.20:8195',
  },
  homeassistant: {
    hint: 'A long-lived access token from your Home Assistant profile. Tag entities with the label aiembodied to have them remembered.',
    example: 'http://homeassistant.local:8123',
  },
};

/** What a server's key is called: databases have a password, Home Assistant a token. */
const keyLabel = (type: ServerType) => (type === 'memory' ? 'Password' : type === 'homeassistant' || type === 'github' ? 'Token' : 'API key');

/** Which of a server's model lists a use picks from. */
function roleFor(use: UseId, type: ServerType): ModelRole | null {
  if (use === 'llm' || use === 'coding' || use === 'describe' || use === 'posegen' || use === 'posecheck' || use === 'clips' || use === 'idle' || use === 'scenelayout') return 'chat';
  if (use === 'stt') return 'transcribe';
  if (use === 'tts') return type === 'speech' ? 'voices' : 'realtime';
  if (use === 'motion') return type === 'motion' ? 'motion' : null;
  return null;
}

function modelLabel(use: UseId, type: ServerType): string {
  if (type === 'memory') return '';
  // A speech service's engine, model and voice have their own fields (speaking-engines.tsx).
  if (use === 'tts' && type === 'speech') return '';
  if (use === 'stt' && type === 'speech') return '';
  return 'Model';
}

type Page = { kind: 'use'; use: UseId } | { kind: 'coding' } | { kind: 'engine' } | { kind: 'servers' } | { kind: 'server'; id: string };

interface AddDraft {
  type: ServerType;
  name: string;
  url: string;
  key: string;
  probe?: ServerProbe;
  /** The use to send back to, with the new server picked, once it is added. */
  returnTo?: UseId;
}

export interface EngineControls {
  backend: 'local' | 'openai';
  onBackendChange(backend: 'local' | 'openai'): void;
  voice: string;
  voices: string[];
  onVoiceChange(voice: string): void;
  disabled?: boolean;
}

export interface ModelsDialogProps {
  api: ModelsBridge;
  avatarApi?: AvatarBridge;
  /** The Coding page's settings (workspaces, runner, coder model file). Without it the page shows the model only. */
  codingApi?: CodingBridge;
  engine?: EngineControls;
  onClose(): void;
  /** Called after any change, so the app can reload what depends on it (such as the OpenAI key). */
  onChanged?(change: { openAiKey: boolean }): void;
  initialUse?: UseId;
}

const ONLINE_TYPES: readonly ServerType[] = ['openai', 'anthropic', 'github', 'brave', 'civitai', 'huggingface'];
const where = (server: ModelServerView) => (server.managed ? 'local' : ONLINE_TYPES.includes(server.type) ? 'online' : 'remote');
const WHERE_LABEL = { local: 'This PC', remote: 'Your server', online: 'Online' } as const;

export function ModelsDialog({ api, avatarApi, codingApi, engine, onClose, onChanged, initialUse = 'llm' }: ModelsDialogProps) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [view, setView] = useState<ModelRoutingView | null>(null);
  const [page, setPage] = useState<Page>(initialUse === 'coding' ? { kind: 'coding' } : { kind: 'use', use: initialUse });
  const [probes, setProbes] = useState<Record<string, ServerProbe | 'checking'>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState<AddDraft | null>(null);
  const imageModels = useImageModels(avatarApi, page.kind === 'use' && page.use === 'image');
  const characterModels = useCharacterModels(avatarApi, page.kind === 'use' && page.use === 'mesh');

  useEffect(() => {
    const element = dialog.current;
    element?.showModal?.();
    return () => element?.close?.();
  }, []);

  useEffect(() => {
    let cancelled = false;
    void Promise.resolve()
      .then(() => api.get())
      .then((next) => {
        if (!cancelled) setView(next);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Could not load the model servers.');
      });
    return () => {
      cancelled = true;
    };
  }, [api]);

  const probe = useCallback(
    async (serverId: string) => {
      setProbes((current) => ({ ...current, [serverId]: 'checking' }));
      try {
        const result = await api.probe({ serverId });
        setProbes((current) => ({ ...current, [serverId]: result }));
      } catch (err) {
        setProbes((current) => ({
          ...current,
          [serverId]: { status: 'error', message: err instanceof Error ? err.message : 'Check failed.', models: {}, checkedAt: Date.now() },
        }));
      }
    },
    [api],
  );

  // Check every server once as soon as the list loads (and any added later), so every status
  // dot in the rail and the server list is right without opening each page first.
  const probesRef = useRef(probes);
  useEffect(() => {
    probesRef.current = probes;
  }, [probes]);
  useEffect(() => {
    if (!view) return;
    const pending = view.servers.map((server) => server.id).filter((id) => id && !probesRef.current[id]);
    if (!pending.length) return;
    // Marked at once, so a re-render before the effect's probes start doesn't check twice.
    probesRef.current = { ...probesRef.current, ...Object.fromEntries(pending.map((id) => [id, 'checking' as const])) };
    void Promise.resolve().then(() => Promise.all(pending.map((id) => probe(id))));
  }, [view, probe]);

  const run = async (action: () => Promise<ModelRoutingView | void>, done?: string, openAiKey = false) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const next = await action();
      if (next) setView(next);
      if (done) setNotice(done);
      onChanged?.({ openAiKey });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'That change could not be saved.');
    } finally {
      setBusy(false);
    }
  };

  const setRoute = (use: UseId, route: ModelRoute) => run(() => api.setRoute(use, route));

  const serverById = (id: string) => view?.servers.find((server) => server.id === id);

  const rail = (
    <nav className="modelsDialog__rail" aria-label="Model uses">
      {engine ? (
        <>
          <span className="modelsDialog__group">Talking</span>
          <RailItem current={page.kind === 'engine'} onClick={() => setPage({ kind: 'engine' })} label="Conversation engine" chip={engine.backend === 'openai' ? 'Online' : 'Step by step'} status="none" />
        </>
      ) : null}
      {USE_GROUPS.map((group) => (
        <div key={group} className="modelsDialog__railGroup">
          {group !== 'Talking' || !engine ? <span className="modelsDialog__group">{group}</span> : null}
          {group === 'Coding' ? (
            <RailItem
              current={page.kind === 'coding'}
              onClick={() => {
                setNotice(null);
                setPage({ kind: 'coding' });
              }}
              label="Coding"
              chip={view ? (serverById(view.routes.coding.server)?.name ?? 'Off') : ''}
              status={view ? probes[BUILT_IN_SERVER_IDS.coderRunner] : undefined}
            />
          ) : null}
          {MODEL_USES.filter((use) => use.group === group && group !== 'Coding' && !use.hidden).map((use) => {
            const server = view ? serverById(view.routes[use.id].server) : undefined;
            const status: RailStatus = server ? probes[server.id] : 'off';
            return (
              <RailItem
                key={use.id}
                current={page.kind === 'use' && page.use === use.id}
                onClick={() => {
                  setNotice(null);
                  setPage({ kind: 'use', use: use.id });
                }}
                label={use.name}
                chip={server ? WHERE_LABEL[where(server)] : 'Off'}
                status={status}
              />
            );
          })}
        </div>
      ))}
      <span className="modelsDialog__group">Setup</span>
      <RailItem current={page.kind === 'servers' || page.kind === 'server'} onClick={() => setPage({ kind: 'servers' })} label="Servers" chip={view ? String(view.servers.length) : ''} status="none" />
    </nav>
  );

  let main: ReactNode = <p className="kiosk__helper">Loading…</p>;
  if (view && page.kind === 'engine' && engine) {
    main = (
      <section className="modelsDialog__page" aria-labelledby="models-engine-title">
        <Heading id="models-engine-title" group="Talking" title="Conversation engine">
          Step by step uses Hearing, Thinking and Speaking. OpenAI Realtime hands the whole turn to one OpenAI model, using the OpenAI key.
        </Heading>
        <div className="modelsDialog__fields">
          <label htmlFor="models-engine">Engine</label>
          <select id="models-engine" value={engine.backend} disabled={engine.disabled} onChange={(event) => engine.onBackendChange(event.target.value === 'openai' ? 'openai' : 'local')}>
            <option value="local">Step by step</option>
            <option value="openai">OpenAI Realtime</option>
          </select>
          {engine.backend === 'openai' ? (
            <>
              <label htmlFor="models-engine-voice">Voice</label>
              <select id="models-engine-voice" value={engine.voice} disabled={engine.disabled} onChange={(event) => engine.onVoiceChange(event.target.value)}>
                {engine.voices.map((voice) => (
                  <option key={voice} value={voice}>
                    {voice}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      </section>
    );
  } else if (view && page.kind === 'coding') {
    const runners = view.servers.filter((server) => server.type === 'coder');
    main = (
      <>
        <UsePage
          key="coding"
          use="coding"
          view={view}
          probes={probes}
          busy={busy}
          onProbe={probe}
          onRoute={(route) => void setRoute('coding', route)}
          onOpenServer={(id) => setPage({ kind: 'server', id })}
          onAddServer={(type) => {
            setAdding({ type, name: '', url: '', key: '', returnTo: 'coding' });
            setPage({ kind: 'servers' });
          }}
          imageModels={imageModels}
          characterModels={characterModels}
          api={api}
        />
        {codingApi ? (
          <CodingSettings api={codingApi} runners={runners} runnerProbe={probes[view.servers.find((server) => server.type === 'coder')?.id ?? '']} onProbeRunner={(id) => void probe(id)} />
        ) : null}
      </>
    );
  } else if (view && page.kind === 'use') {
    main = (
      <>
      <UsePage
        key={page.use}
        use={page.use}
        view={view}
        probes={probes}
        busy={busy}
        onProbe={probe}
        onRoute={(route) => void setRoute(page.use, route)}
        onOpenServer={(id) => setPage({ kind: 'server', id })}
        onAddServer={(type) => {
          setAdding({ type, name: '', url: '', key: '', returnTo: page.use });
          setPage({ kind: 'servers' });
        }}
        imageModels={imageModels}
        characterModels={characterModels}
        api={api}
      />
      {page.use === 'llm' ? <ThinkingDownloads api={api} busy={busy} onView={setView} /> : null}
      {page.use === 'describe' && view.routes.describe.server === BUILT_IN_SERVER_IDS.vision ? <VisionDownload api={api} busy={busy} /> : null}
      </>
    );
  } else if (view && page.kind === 'servers') {
    main = (
      <section className="modelsDialog__page" aria-labelledby="models-servers-title">
        <Heading id="models-servers-title" group="Setup" title="Servers">
          Everything that runs a model. Add your own machines here, then pick them for any job. This PC’s servers are started
          by the app when a job needs them.
        </Heading>
        {adding ? (
          <AddServerForm
            draft={adding}
            busy={busy}
            onChange={setAdding}
            onTest={async () => {
              const draft = adding;
              setBusy(true);
              try {
                const result = await api.probe({ draft: { type: draft.type, url: draft.url, key: draft.key || undefined } });
                setAdding((current) => (current ? { ...current, probe: result } : current));
              } catch (err) {
                setAdding((current) =>
                  current
                    ? { ...current, probe: { status: 'error', message: err instanceof Error ? err.message : 'Check failed.', models: {}, checkedAt: Date.now() } }
                    : current,
                );
              } finally {
                setBusy(false);
              }
            }}
            onCancel={() => setAdding(null)}
            onSave={() =>
              run(async () => {
                const draft = adding;
                const result = await api.saveServer({ name: draft.name || undefined, type: draft.type, url: draft.url, key: draft.key || undefined });
                setAdding(null);
                const tested = draft.probe;
                if (tested) setProbes((current) => ({ ...current, [result.id]: tested }));
                const name = result.models.servers.find((server) => server.id === result.id)?.name ?? 'the server';
                if (draft.returnTo && USE_SERVER_TYPES[draft.returnTo].includes(draft.type)) {
                  const current = result.models.routes[draft.returnTo];
                  const routed = await api.setRoute(draft.returnTo, { ...current, server: result.id, model: undefined, backups: (current.backups ?? []).filter((b) => b.server !== result.id) });
                  setPage({ kind: 'use', use: draft.returnTo });
                  setNotice(`Added ${name} and picked it.`);
                  return routed;
                }
                setNotice(`Added ${name}. Pick it for any job it can do.`);
                return result.models;
              })
            }
          />
        ) : (
          <div>
            <button type="button" className="modelsDialog__primary" onClick={() => setAdding({ type: 'chat', name: '', url: '', key: '' })} disabled={busy}>
              Add a server
            </button>
          </div>
        )}
        {(['local', 'remote', 'online'] as const).map((group) => {
          const list = view.servers.filter((server) => where(server) === group);
          return list.length ? (
            <div key={group} className="modelsDialog__list">
              <span className="modelsDialog__group">{group === 'local' ? 'This PC' : group === 'remote' ? 'Your servers' : 'Online services'}</span>
              {list.map((server) => (
                <ServerRow key={server.id} server={server} probe={probes[server.id]} onOpen={() => setPage({ kind: 'server', id: server.id })} />
              ))}
            </div>
          ) : null;
        })}
      </section>
    );
  } else if (view && page.kind === 'server') {
    const server = serverById(page.id);
    main = server ? (
      <ServerPage
        key={server.id}
        api={api}
        server={server}
        view={view}
        probe={probes[server.id]}
        busy={busy}
        onProbe={() => void probe(server.id)}
        onSave={(changes) =>
          run(async () => {
            const result = await api.saveServer({ id: server.id, ...changes });
            setProbes((current) => {
              const next = { ...current };
              delete next[server.id];
              return next;
            });
            return result.models;
          }, 'Saved.')
        }
        onKey={(key) =>
          run(async () => {
            const next = await api.setKey(server.id, key);
            setProbes((current) => {
              const copy = { ...current };
              delete copy[server.id];
              return copy;
            });
            return next;
          }, key ? 'Key saved.' : 'Key removed.', server.type === 'openai')
        }
        onRemove={() =>
          run(async () => {
            const next = await api.removeServer(server.id);
            setPage({ kind: 'servers' });
            return next;
          }, `Removed ${server.name}. Jobs that used it are back on their defaults.`)
        }
        onOpenUse={(use) => setPage({ kind: 'use', use })}
      />
    ) : (
      <p className="kiosk__helper">That server was removed.</p>
    );
  }

  return createPortal(
    <dialog
      ref={dialog}
      className="modelsDialog"
      aria-label="Models and servers"
      onClose={(event) => {
        if (event.target === dialog.current) onClose();
      }}
      onCancel={(event) => {
        if (event.target !== dialog.current) return;
        event.preventDefault();
        onClose();
      }}
      onKeyDown={(event) => {
        if (event.key === 'Escape') event.stopPropagation();
      }}
    >
      <header className="modelsDialog__header">
        <h2>Models and servers</h2>
        <span>Changes apply straight away.</span>
        <button type="button" onClick={onClose} aria-label="Close models and servers">
          ✕ Close
        </button>
      </header>
      {error ? (
        <p role="alert" className="kiosk__error modelsDialog__banner">
          {error}
        </p>
      ) : null}
      {notice ? (
        <p role="status" className="modelsDialog__banner modelsDialog__notice">
          {notice}
        </p>
      ) : null}
      <div className="modelsDialog__body">
        {rail}
        <div className="modelsDialog__main">{main}</div>
      </div>
    </dialog>,
    document.body,
  );
}

function Heading({ id, group, title, children }: { id: string; group: string; title: string; children?: ReactNode }) {
  return (
    <div className="modelsDialog__heading">
      <span className="modelsDialog__group">{group}</span>
      <h3 id={id}>{title}</h3>
      {children ? <p className="kiosk__helper">{children}</p> : null}
    </div>
  );
}

function StatusDot({ probe }: { probe?: ServerProbe | 'checking' }) {
  const state = !probe ? 'unknown' : probe === 'checking' ? 'checking' : probe.status;
  const label =
    state === 'up' ? 'Running' : state === 'down' ? 'Not reachable' : state === 'needs-key' ? 'Needs a key' : state === 'error' ? 'Not ready' : state === 'checking' ? 'Checking' : 'Not checked';
  return <span className={`modelsDialog__dot is-${state}`} title={label} aria-label={label} role="img" />;
}

function statusText(probe?: ServerProbe | 'checking'): string {
  if (!probe) return 'Not checked yet';
  if (probe === 'checking') return 'Checking…';
  if (probe.status === 'up') return probe.queue ? `Running · ${probe.queue} in queue` : 'Running';
  return probe.message ?? (probe.status === 'down' ? 'Not reachable' : 'Not ready');
}

/** A rail entry's dot: its server's status, 'off' for a use with no server, 'none' for no dot. */
type RailStatus = ServerProbe | 'checking' | 'off' | 'none' | undefined;

function RailItem({ current, onClick, label, chip, status }: { current: boolean; onClick(): void; label: string; chip?: string; status?: RailStatus }) {
  return (
    <button type="button" className="modelsDialog__item" aria-current={current} onClick={onClick}>
      {status === 'none' ? (
        <span className="modelsDialog__dot is-none" aria-hidden="true" />
      ) : status === 'off' ? (
        <span className="modelsDialog__dot is-off" title="Off" aria-label="Off" role="img" />
      ) : (
        <StatusDot probe={status} />
      )}
      <span>{label}</span>
      {chip ? <small>{chip}</small> : null}
    </button>
  );
}

function ServerRow({ server, probe, onOpen, children }: { server: ModelServerView; probe?: ServerProbe | 'checking'; onOpen?(): void; children?: ReactNode }) {
  return (
    <div className="modelsDialog__server">
      <StatusDot probe={probe} />
      <div className="modelsDialog__serverText">
        <b>{server.name}</b>
        <code>{server.url}</code>
      </div>
      <small className={`modelsDialog__where is-${where(server)}`}>{WHERE_LABEL[where(server)]}</small>
      <span className="modelsDialog__state">{statusText(probe)}</span>
      {children}
      {onOpen ? (
        <button type="button" onClick={onOpen} aria-label={`Open ${server.name}`}>
          Open
        </button>
      ) : null}
    </div>
  );
}

interface UsePageProps {
  use: UseId;
  view: ModelRoutingView;
  probes: Record<string, ServerProbe | 'checking'>;
  busy: boolean;
  onProbe(id: string): void;
  onRoute(route: ModelRoute): void;
  onOpenServer(id: string): void;
  onAddServer(type: ServerType): void;
  imageModels: ReturnType<typeof useImageModels>;
  characterModels: ReturnType<typeof useCharacterModels>;
  api: Pick<ModelsBridge, 'speechEngines' | 'speechDownload'>;
}

function UsePage({ use, view, probes, busy, onProbe, onRoute, onOpenServer, onAddServer, imageModels, characterModels, api }: UsePageProps) {
  const info = MODEL_USES.find((entry) => entry.id === use) ?? MODEL_USES[0];
  const route = view.routes[use];
  // The mirror can't be this PC's own memory database (only the engine knows its address).
  const fitting = view.servers.filter(
    (server) => USE_SERVER_TYPES[use].includes(server.type) && !(use === 'memorymirror' && server.id === BUILT_IN_SERVER_IDS.memory),
  );
  const server = fitting.find((entry) => entry.id === route.server);
  const probe = server ? probes[server.id] : undefined;
  const role = server ? roleFor(use, server.type) : null;
  const found = role && probe && probe !== 'checking' ? (probe.models[role] ?? []) : [];
  const addable = USE_SERVER_TYPES[use].find((type) => ADDABLE_SERVER_TYPES.includes(type));
  const label = server ? modelLabel(use, server.type) : 'Model';
  const backups = route.backups ?? [];
  const others = fitting.filter((entry) => entry.id !== route.server);

  const [model, setModel] = useState(route.model ?? '');
  const [syncedModel, setSyncedModel] = useState(route.model ?? '');
  if ((route.model ?? '') !== syncedModel) {
    setSyncedModel(route.model ?? '');
    setModel(route.model ?? '');
  }
  const [style, setStyle] = useState(route.style ?? '');
  const [typing, setTyping] = useState(false);
  // Only the picked server's own list: this PC's motion service offers its two backends.
  const choices = server?.managed && use === 'motion' ? ['ardy', 'kimodo'] : found;

  // The image and 3D lists come from the step's first ComfyUI server, so read them again when it changes.
  const refreshImage = imageModels.refresh;
  const refreshMesh = characterModels.refresh;
  const firstServer = route.server;
  const listedFor = useRef(firstServer);
  useEffect(() => {
    if (listedFor.current === firstServer) return;
    listedFor.current = firstServer;
    if (use === 'image') void refreshImage();
    if (use === 'mesh') void refreshMesh();
  }, [use, firstServer, refreshImage, refreshMesh]);

  const pickServer = (id: string) => {
    if (id === '__add') {
      if (addable) onAddServer(addable);
      return;
    }
    setTyping(false);
    onRoute({ ...route, server: id, model: undefined, backups: backups.filter((backup) => backup.server !== id) });
  };

  const saveModel = (value: string) => {
    setModel(value);
    if (value === (route.model ?? '')) return;
    onRoute({ ...route, model: value || undefined });
  };

  const groups = (['local', 'remote', 'online'] as const).map((group) => ({ group, servers: fitting.filter((entry) => where(entry) === group) }));

  return (
    <section className="modelsDialog__page" aria-labelledby={`models-${use}-title`}>
      <Heading id={`models-${use}-title`} group={info.group} title={info.name}>
        {info.what}
      </Heading>
      <div className="modelsDialog__fields">
        <label htmlFor={`models-${use}-server`}>Runs on</label>
        <select id={`models-${use}-server`} value={route.server} onChange={(event) => pickServer(event.target.value)} disabled={busy}>
          {USES_THAT_CAN_BE_OFF.includes(use) ? <option value="">Off</option> : null}
          {groups.map(({ group, servers }) =>
            servers.length ? (
              <optgroup key={group} label={WHERE_LABEL[group]}>
                {servers.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name}
                  </option>
                ))}
              </optgroup>
            ) : null,
          )}
          {addable ? <option value="__add">Add a server…</option> : null}
        </select>

        {server && use === 'image' ? (
          <ImageModelSelect models={imageModels} busy={busy} serverName={server.name} />
        ) : server && use === 'mesh' ? (
          <MeshModelSelect models={characterModels} busy={busy} serverName={server.name} />
        ) : server && use === 'motion' && server.type === 'openai' ? (
          <>
            <span />
            <p className="kiosk__helper">Moving writes keyframe clips with the Animation clips server and model.</p>
          </>
        ) : server && label ? (
          <>
            <label htmlFor={`models-${use}-model`}>{label}</label>
            <span className="modelsDialog__model">
              {choices.length && !typing ? (
                <select
                  id={`models-${use}-model`}
                  value={route.model ?? ''}
                  onChange={(event) => {
                    if (event.target.value === '__other') {
                      setTyping(true);
                      return;
                    }
                    saveModel(event.target.value);
                  }}
                  disabled={busy}
                >
                  <option value="">Server default{choices[0] ? ` (${choices[0]})` : ''}</option>
                  {route.model && !choices.includes(route.model) ? <option value={route.model}>{route.model} (not on this server)</option> : null}
                  {choices.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                  <option value="__other">Type a name…</option>
                </select>
              ) : (
                <input
                  id={`models-${use}-model`}
                  value={model}
                  placeholder={probe === 'checking' ? 'Reading the server’s models…' : 'Server default'}
                  onChange={(event) => setModel(event.target.value)}
                  onBlur={() => saveModel(model.trim())}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') saveModel(model.trim());
                  }}
                  disabled={busy}
                />
              )}
              <span className="modelsDialog__modelActions">
                {choices.length && typing ? (
                  <button type="button" onClick={() => setTyping(false)}>
                    Pick from the list
                  </button>
                ) : null}
                {!(server.managed && use === 'motion') ? (
                  <button type="button" onClick={() => onProbe(server.id)} disabled={probe === 'checking'}>
                    {probe === 'checking' ? 'Refreshing…' : 'Refresh list'}
                  </button>
                ) : null}
                {probe && probe !== 'checking' && probe.status !== 'up' ? <small className="kiosk__error">{statusText(probe)}</small> : null}
              </span>
            </span>
          </>
        ) : server && use === 'tts' && server.type === 'speech' ? (
          <SpeakingEngineFields key={server.id} api={api} server={server} route={route} busy={busy} onRoute={onRoute} />
        ) : server && use === 'stt' && server.type === 'speech' ? (
          <>
            <span />
            <p className="kiosk__helper">
              The speech service uses the recogniser it was started with{found[0] ? ` (now ${found[0]})` : ''}.
            </p>
          </>
        ) : null}

        {server && use === 'tts' && server.type === 'openai' ? (
          <>
            <label htmlFor="models-tts-voice">Voice</label>
            <select id="models-tts-voice" value={route.voice ?? 'alloy'} onChange={(event) => onRoute({ ...route, voice: event.target.value })} disabled={busy}>
              {OPENAI_VOICES.map((voice) => (
                <option key={voice} value={voice}>
                  {voice}
                </option>
              ))}
            </select>
            <label htmlFor="models-tts-style">Speaking style</label>
            <input
              id="models-tts-style"
              value={style}
              placeholder="e.g. Warm and upbeat, with a light British accent."
              onChange={(event) => setStyle(event.target.value)}
              onBlur={() => {
                if (style.trim() !== (route.style ?? '')) onRoute({ ...route, style: style.trim() || undefined });
              }}
              disabled={busy}
            />
          </>
        ) : null}
        {server?.managed && use === 'motion' ? (
          <>
            <span />
            <p className="kiosk__helper">pnpm dev:run starts the motion service with this model; restart it for a change to apply.</p>
          </>
        ) : null}
      </div>

      {server ? (
        <ServerRow server={server} probe={probe}>
          <button type="button" onClick={() => onProbe(server.id)} disabled={probe === 'checking'}>
            Test
          </button>
          <button type="button" onClick={() => onOpenServer(server.id)}>
            Open
          </button>
        </ServerRow>
      ) : use === 'search' ? (
        <p className="kiosk__helper">Web search is off: the assistant can’t look things up.</p>
      ) : use === 'memorymirror' ? (
        <p className="kiosk__helper">No mirror: memory is kept only in the memory database.</p>
      ) : null}
      {server && use === 'memorymirror' && view.routes.memory.server === server.id ? (
        <p className="kiosk__error">This is also the memory database, so nothing is mirrored. Pick another one.</p>
      ) : null}

      {USES_WITH_BACKUPS.includes(use) && server ? (
        <div className="modelsDialog__backups">
          <span className="modelsDialog__group">If it’s busy or down, try</span>
          {others.length ? (
            <div className="modelsDialog__chips" role="group" aria-label="Backup servers">
              {others.map((entry) => {
                const index = backups.findIndex((backup) => backup.server === entry.id);
                return (
                  <button
                    key={entry.id}
                    type="button"
                    aria-pressed={index >= 0}
                    disabled={busy}
                    onClick={() =>
                      onRoute({
                        ...route,
                        backups: index >= 0 ? backups.filter((backup) => backup.server !== entry.id) : [...backups, { server: entry.id }],
                      })
                    }
                  >
                    {index >= 0 ? <b>{index + 1}</b> : null}
                    {entry.name}
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="kiosk__helper">No other server can do this yet. Add one under Servers.</p>
          )}
          {USES_WITH_SPREAD.includes(use) && backups.length ? (
            <label className="modelsDialog__check">
              <input type="checkbox" checked={route.spread === true} onChange={(event) => onRoute({ ...route, spread: event.target.checked || undefined })} disabled={busy} />
              Send each job to whichever of these has the shortest queue
            </label>
          ) : backups.length ? (
            <p className="kiosk__helper">Tried in the order you picked them. A backup of the same kind asks for the same model.</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function ImageModelSelect({ models, busy, serverName }: { models: ReturnType<typeof useImageModels>; busy: boolean; serverName: string }) {
  return (
    <>
      <label htmlFor="models-image-model">Model</label>
      <span className="modelsDialog__model">
        <select id="models-image-model" value={models.selectedModelId ?? ''} onChange={(event) => void models.select(event.target.value)} disabled={busy || models.loading || !models.models.length}>
          {!models.models.length ? <option value="">{models.loading ? 'Finding models…' : 'No image models found'}</option> : null}
          {models.models.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.available}>
              {entry.name}
              {entry.available ? '' : ' (missing parts)'}
            </option>
          ))}
        </select>
        <span className="modelsDialog__modelActions">
          <button type="button" onClick={() => void models.refresh()} disabled={models.loading}>
            {models.loading ? 'Refreshing…' : 'Refresh list'}
          </button>
          <small>From {serverName}</small>
        </span>
        {models.error ? <small className="kiosk__error">{models.error}</small> : null}
      </span>
    </>
  );
}

function MeshModelSelect({ models, busy, serverName }: { models: ReturnType<typeof useCharacterModels>; busy: boolean; serverName: string }) {
  return (
    <>
      <label htmlFor="models-mesh-model">Model</label>
      <span className="modelsDialog__model">
        <select
          id="models-mesh-model"
          value={models.selectedGeometryId ?? ''}
          onChange={(event) => void models.select('geometry', event.target.value)}
          disabled={busy || models.loading || !models.geometry.length}
        >
          {!models.geometry.length ? <option value="">{models.loading ? 'Finding models…' : 'No 3D models found'}</option> : null}
          {models.geometry.map((entry) => (
            <option key={entry.id} value={entry.id} disabled={!entry.available}>
              {entry.name}
              {entry.available ? '' : ` (${entry.unavailableReason ?? 'unavailable'})`}
            </option>
          ))}
        </select>
        <span className="modelsDialog__modelActions">
          <button type="button" onClick={() => void models.refresh()} disabled={models.loading}>
            {models.loading ? 'Refreshing…' : 'Refresh list'}
          </button>
          <small>From {serverName}</small>
        </span>
        {models.error ? <small className="kiosk__error">{models.error}</small> : null}
      </span>
    </>
  );
}

function AddServerForm({
  draft,
  busy,
  onChange,
  onTest,
  onCancel,
  onSave,
}: {
  draft: AddDraft;
  busy: boolean;
  onChange(next: AddDraft): void;
  onTest(): void;
  onCancel(): void;
  onSave(): void;
}) {
  const hint = SERVER_TYPE_HINTS[draft.type];
  const found = draft.probe ? [...new Set(Object.values(draft.probe.models).flat())] : [];
  return (
    <form
      className="modelsDialog__add"
      aria-label="New server"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <b>New server</b>
      <div className="modelsDialog__fields">
        <label htmlFor="models-add-type">Type</label>
        <select id="models-add-type" value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value as ServerType, probe: undefined })}>
          {ADDABLE_SERVER_TYPES.map((type) => (
            <option key={type} value={type}>
              {SERVER_TYPE_LABELS[type]}
            </option>
          ))}
        </select>
        {hint ? (
          <>
            <span />
            <p className="kiosk__helper">{hint.hint}</p>
          </>
        ) : null}
        <label htmlFor="models-add-name">Name</label>
        <input id="models-add-name" value={draft.name} placeholder={`${SERVER_TYPE_LABELS[draft.type]} on …`} onChange={(event) => onChange({ ...draft, name: event.target.value })} />
        <label htmlFor="models-add-url">Address</label>
        <input id="models-add-url" value={draft.url} placeholder={hint?.example} onChange={(event) => onChange({ ...draft, url: event.target.value, probe: undefined })} />
        <label htmlFor="models-add-key">{keyLabel(draft.type)}</label>
        <input id="models-add-key" type="password" autoComplete="off" value={draft.key} placeholder={draft.type === 'memory' ? 'The database password' : draft.type === 'homeassistant' ? 'The long-lived access token' : 'Only if the server asks for one'} onChange={(event) => onChange({ ...draft, key: event.target.value, probe: undefined })} />
      </div>
      {draft.probe ? (
        <p role="status" className={draft.probe.status === 'up' ? 'kiosk__info' : 'kiosk__error'}>
          {draft.probe.status === 'up' ? `It answered.${found.length ? ` Models: ${found.slice(0, 8).join(', ')}${found.length > 8 ? '…' : ''}` : ''}` : statusText(draft.probe)}
        </p>
      ) : null}
      <div className="modelsDialog__actions">
        <button type="button" onClick={onTest} disabled={busy || !draft.url.trim()}>
          Test
        </button>
        <button type="submit" className="modelsDialog__primary" disabled={busy || !draft.url.trim()}>
          Add server
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
      {!draft.probe ? <p className="kiosk__helper">You can add a server that isn’t running yet; Test checks it first.</p> : null}
    </form>
  );
}

function ServerPage({
  api,
  server,
  view,
  probe,
  busy,
  onProbe,
  onSave,
  onKey,
  onRemove,
  onOpenUse,
}: {
  api: ModelsBridge;
  server: ModelServerView;
  view: ModelRoutingView;
  probe?: ServerProbe | 'checking';
  busy: boolean;
  onProbe(): void;
  onSave(changes: { name?: string; url?: string }): void;
  onKey(key: string): void;
  onRemove(): void;
  onOpenUse(use: UseId): void;
}) {
  const [name, setName] = useState(server.name);
  const [url, setUrl] = useState(server.url);
  const [key, setKey] = useState('');
  const [confirmRemove, setConfirmRemove] = useState(false);
  const fixedUrl = ONLINE_TYPES.includes(server.type);
  const usedBy = MODEL_USES.filter((use) => {
    const route = view.routes[use.id];
    return route.server === server.id || (route.backups ?? []).some((backup) => backup.server === server.id);
  });
  const models = probe && probe !== 'checking' ? [...new Set(Object.values(probe.models).flat())] : [];
  const dirty = name.trim() !== server.name || (!fixedUrl && url.trim() !== server.url);
  return (
    <section className="modelsDialog__page" aria-labelledby="models-server-title">
      <Heading id="models-server-title" group={`Server · ${SERVER_TYPE_LABELS[server.type]}`} title={server.name} />
      <ServerRow server={server} probe={probe}>
        <button type="button" onClick={onProbe} disabled={probe === 'checking'}>
          Test
        </button>
      </ServerRow>
      <form
        className="modelsDialog__fields"
        onSubmit={(event) => {
          event.preventDefault();
          if (dirty) onSave({ name: name.trim(), ...(fixedUrl ? {} : { url: url.trim() }) });
        }}
      >
        <label htmlFor="models-server-name">Name</label>
        <input id="models-server-name" value={name} onChange={(event) => setName(event.target.value)} />
        <label htmlFor="models-server-url">Address</label>
        <input id="models-server-url" value={url} onChange={(event) => setUrl(event.target.value)} disabled={fixedUrl} />
        <span />
        <span>
          <button type="submit" disabled={busy || !dirty}>
            Save
          </button>
        </span>
      </form>
      {server.managed ? <p className="kiosk__helper">On this PC: the app (or pnpm dev:run) starts it when a job needs it.</p> : null}
      {server.type !== 'speech' && server.type !== 'motion' && server.type !== 'comfy' && server.type !== 'coder' && server.id !== BUILT_IN_SERVER_IDS.memory ? (
        <form
          className="modelsDialog__fields"
          onSubmit={(event) => {
            event.preventDefault();
            if (key.trim()) {
              onKey(key.trim());
              setKey('');
            }
          }}
        >
          <label htmlFor="models-server-key">{keyLabel(server.type)}</label>
          <input
            id="models-server-key"
            type="password"
            autoComplete="off"
            value={key}
            placeholder={
              server.hasKey
                ? 'Saved. Enter a new one to replace it.'
                : server.type === 'civitai'
                  ? 'Needed for many downloads'
                  : server.type === 'huggingface'
                    ? 'Only for gated or private models'
                  : server.type === 'memory'
                    ? 'The database password'
                  : server.type === 'homeassistant'
                    ? 'The long-lived access token'
                  : server.type === 'github'
                    ? 'A token that can push branches and open pull requests'
                  : server.type === 'openai' || server.type === 'anthropic' || server.type === 'brave'
                    ? 'Needed'
                    : 'Only if the server asks for one'
            }
            onChange={(event) => setKey(event.target.value)}
          />
          <span />
          <span className="modelsDialog__actions">
            <button type="submit" disabled={busy || !key.trim()}>
              Save key
            </button>
            {server.hasKey && !server.keyFromEnv ? (
              <button type="button" onClick={() => onKey('')} disabled={busy}>
                Remove key
              </button>
            ) : null}
          </span>
          {server.keyFromEnv ? (
            <>
              <span />
              <p className="kiosk__helper">The key comes from an environment variable, which wins over a saved one.</p>
            </>
          ) : null}
        </form>
      ) : null}
      {server.type === 'comfy' && api.download ? <ModelDownloads api={api} server={server} onFinished={onProbe} /> : null}
      {server.type === 'huggingface' ? (
        <p className="kiosk__helper">
          Hugging Face runs no job itself. It supplies thinking models (Thinking → Download a thinking model). Gated models such as Llama and Gemma need a
          token (huggingface.co → Settings → Access Tokens) and their licence accepted on the website.
        </p>
      ) : null}
      {server.type === 'civitai' ? (
        <p className="kiosk__helper">Civitai runs no job itself. Its key lets ComfyUI servers download models from a pasted Civitai link (open a ComfyUI server, then Download a model).</p>
      ) : null}
      <div className="modelsDialog__list" hidden={server.type === 'civitai' || server.type === 'huggingface' || server.type === 'memory' || server.type === 'homeassistant' || server.type === 'github' || server.type === 'coder'}>
        <span className="modelsDialog__group">
          Models it offers{' '}
          <button type="button" onClick={onProbe} disabled={probe === 'checking'}>
            {probe === 'checking' ? 'Refreshing…' : 'Refresh list'}
          </button>
        </span>
        {models.length ? (
          <div className="modelsDialog__found">
            {models.map((model) => (
              <code key={model}>{model}</code>
            ))}
          </div>
        ) : (
          <p className="kiosk__helper">
            {probe === 'checking' ? 'Reading the list…' : probe && probe.status !== 'up' ? statusText(probe) : 'None reported. Refresh the list to read it again.'}
          </p>
        )}
      </div>
      {server.type === 'github' ? (
        <p className="kiosk__helper">GitHub runs no model. Its token lets the coding runner push a task’s branch and open the pull request.</p>
      ) : null}
      {server.type === 'coder' ? (
        <p className="kiosk__helper">A coding runner takes the coding tasks. Choose which one on the Coding page.</p>
      ) : null}
      {server.type === 'homeassistant' ? (
        <p className="kiosk__helper">Home Assistant runs no job. The memory engine watches the entities tagged aiembodied and remembers what they do.</p>
      ) : null}
      <div className="modelsDialog__list" hidden={server.type === 'civitai' || server.type === 'huggingface' || server.type === 'homeassistant' || server.type === 'github' || server.type === 'coder'}>
        <span className="modelsDialog__group">Used by</span>
        {usedBy.length ? (
          <div className="modelsDialog__chips">
            {usedBy.map((use) => (
              <button key={use.id} type="button" onClick={() => onOpenUse(use.id)}>
                {use.name}
                {view.routes[use.id].server === server.id ? '' : ' (backup)'}
              </button>
            ))}
          </div>
        ) : (
          <p className="kiosk__helper">Nothing yet. Pick it for a job to send work here.</p>
        )}
      </div>
      {!server.builtIn ? (
        confirmRemove ? (
          <div className="modelsDialog__actions" role="group" aria-label="Confirm removal">
            <span>Remove {server.name}? Jobs that use it go back to their defaults.</span>
            <button type="button" onClick={onRemove} disabled={busy}>
              Remove
            </button>
            <button type="button" onClick={() => setConfirmRemove(false)}>
              Keep it
            </button>
          </div>
        ) : (
          <div>
            <button type="button" onClick={() => setConfirmRemove(true)} disabled={busy}>
              Remove server
            </button>
          </div>
        )
      ) : null}
    </section>
  );
}
