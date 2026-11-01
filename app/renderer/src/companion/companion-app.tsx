/**
 * The phone page: the desktop's active avatar on its background, and nothing to edit. Tap
 * anywhere to talk. The desktop does the thinking (see app/main/src/companion/).
 */
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type FormEvent } from 'react';
import type { CompanionScene, CompanionStreamEvent } from '../../../main/src/companion/types.js';
import { AnimationBusProvider, createAvatarAnimationBus, type AvatarAnimationBus } from '../avatar/animation-bus.js';
import { extractAvatarTags, extractMoveTags, toAnimationSlug } from '../avatar/animation-tags.js';
import { enqueueMotionChunk, MoveRequestFilter } from '../avatar/live-motion.js';
import { getAvatarRestSkeleton } from '../avatar/rest-skeleton.js';
import type { AvatarModelSummary } from '../avatar/types.js';
import { VrmAvatarRenderer, type VrmRendererStatus } from '../avatar/vrm-avatar-renderer.js';
import { VisemeDriver, type VisemeFrame } from '../audio/viseme-driver.js';
import { createMicrophone, getAndroidBridge, SpeechPlayer } from './audio-io.js';
import { CompanionClient, readConnection, saveBrowserCode, type CompanionConnection, type PushState } from './companion-client.js';
import { Conversation, type Caption, type ConversationPhase } from './conversation.js';

const PHASE_LABELS: Record<ConversationPhase, string> = {
  idle: 'Tap anywhere to talk',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Speaking',
};

export function CompanionApp() {
  const [connection, setConnection] = useState<CompanionConnection | null>(() =>
    readConnection(window.location, safeStorage()),
  );
  const android = getAndroidBridge();
  const unpair = useCallback(() => {
    // In a browser, ask for the code again; the Android app has its own settings screen.
    if (!getAndroidBridge()) {
      saveBrowserCode(safeStorage(), '');
      setConnection(null);
    }
  }, []);
  if (!connection) {
    return android ? (
      <main className="companion companion--pairing">
        <p className="companion__pairing">Open the connection settings and enter the desktop&apos;s address and pairing code.</p>
      </main>
    ) : (
      <PairingForm onPaired={setConnection} />
    );
  }
  return <CompanionStage connection={connection} onUnauthorized={unpair} />;
}

function CompanionStage({ connection, onUnauthorized }: { connection: CompanionConnection; onUnauthorized: () => void }) {
  const client = useMemo(() => new CompanionClient(connection), [connection]);
  const bus = useMemo(() => createAvatarAnimationBus(), []);
  const player = useMemo(() => new SpeechPlayer(), []);
  const [scene, setScene] = useState<CompanionScene | null>(null);
  // A plain holder rather than a ref: the avatar bridge and tag handler read the latest scene.
  const sceneRef = useMemo(() => ({ current: null as CompanionScene | null }), []);
  const [pushState, setPushState] = useState<PushState>('connecting');
  const [phase, setPhase] = useState<ConversationPhase>('idle');
  const [caption, setCaption] = useState<Caption | null>(null);
  const [level, setLevel] = useState(0);
  const [loadedBackground, setLoadedBackground] = useState<{ id: string; url: string } | null>(null);
  const [footY, setFootY] = useState(0.9);
  const [visemeFrame, setVisemeFrame] = useState<VisemeFrame | null>(null);
  const [rendererError, setRendererError] = useState<string | null>(null);
  const android = getAndroidBridge();

  // The avatar renderer loads models and animations through window.aiembodied, as on the
  // desktop; here those calls go to the desktop over the network.
  useMemo(() => installAvatarBridge(client, sceneRef), [client, sceneRef]);

  const playTags = useMemo(() => createTagPlayer(client, bus, sceneRef), [client, bus, sceneRef]);

  const conversation = useMemo(
    () =>
      new Conversation(client, createMicrophone(), player, {
        onPhase: setPhase,
        onCaption: setCaption,
        onSentence: playTags,
        onLevel: setLevel,
      }),
    [client, player, playTags, setPhase, setCaption, setLevel],
  );
  useEffect(() => () => conversation.dispose(), [conversation]);

  useEffect(() => {
    const apply = (next: CompanionScene) => {
      sceneRef.current = next;
      setScene(next);
    };
    return client.openPushStream(
      (event: CompanionStreamEvent) => {
        if (event.type === 'scene') {
          apply(event.scene);
        } else {
          conversation.handlePush(event);
        }
      },
      (state) => {
        setPushState(state);
        if (state === 'unauthorized') onUnauthorized();
      },
    );
  }, [client, conversation, onUnauthorized, sceneRef]);

  const backgroundId = scene?.background?.id ?? null;
  useEffect(() => {
    if (!backgroundId) {
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    client
      .loadBackgroundUrl(backgroundId)
      .then((loaded) => {
        url = loaded;
        if (cancelled) URL.revokeObjectURL(loaded);
        else setLoadedBackground({ id: backgroundId, url: loaded });
      })
      .catch((error: unknown) => console.warn('[companion] background failed to load', error));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [client, backgroundId]);

  // Lip sync follows the reply audio, as on the desktop.
  useEffect(() => {
    const driver = new VisemeDriver({ onFrame: setVisemeFrame });
    const stream = player.unlock();
    void driver.attachToStream(stream).catch((error: unknown) => console.warn('[companion] lip sync unavailable', error));
    return () => void driver.destroy();
  }, [player]);

  useEffect(() => {
    android?.setKeepScreenOn?.(true);
    const hide = window.setTimeout(() => setCaption(null), 8000);
    return () => window.clearTimeout(hide);
  }, [android, caption]);

  const avatar = scene?.avatar ?? null;
  const model = useMemo<AvatarModelSummary | null>(
    () =>
      avatar
        ? {
            id: avatar.id,
            name: avatar.name,
            fileSha: avatar.fileSha,
            createdAt: 0,
            version: '1.0',
            thumbnailDataUrl: null,
            description: null,
          }
        : null,
    [avatar],
  );
  const animationVersion = useMemo(() => hashString((scene?.animations ?? []).map((a) => a.id).join(',')), [scene?.animations]);

  const backgroundUrl = loadedBackground && loadedBackground.id === backgroundId ? loadedBackground.url : null;
  const groundY = scene?.background?.groundY ?? 0.86;
  const stageStyle: CSSProperties & Record<string, string | number> = {
    '--stage-ground-y': `${groundY * 100}%`,
    '--avatar-foot-y': footY,
    '--mic-level': level,
  };
  const offline = pushState === 'offline' || pushState === 'connecting';
  const status =
    pushState === 'unauthorized'
      ? 'The pairing code was not accepted'
      : offline && !scene
        ? 'Connecting to the desktop…'
        : offline
          ? 'Desktop unreachable, retrying…'
          : PHASE_LABELS[phase];

  // Stable: the renderer reloads the model when this callback changes.
  const handleRendererStatus = useCallback((next: VrmRendererStatus) => {
    setRendererError(next.status === 'error' ? (next.message ?? 'The avatar failed to load.') : null);
  }, []);

  const onTap = useCallback(() => {
    if (pushState === 'unauthorized') return;
    conversation.tap();
  }, [conversation, pushState]);

  return (
    <AnimationBusProvider bus={bus}>
      <main
        className="companion"
        data-phase={phase}
        data-connection={pushState}
        style={stageStyle}
        onPointerUp={onTap}
        aria-label="Avatar. Tap to talk."
      >
        {backgroundUrl ? (
          <img className="companion__background" src={backgroundUrl} alt="" draggable={false} style={{ objectPosition: `50% ${groundY * 100}%` }} />
        ) : null}
        <div className="companion__avatar">
          {model ? (
            <VrmAvatarRenderer
              key={`${model.id}:${model.fileSha}`}
              frame={visemeFrame}
              model={model}
              onGroundPositionChange={setFootY}
              onStatusChange={handleRendererStatus}
              animationVersion={animationVersion}
            />
          ) : null}
        </div>
        {caption ? (
          <p className="companion__caption" data-speaker={caption.speaker}>
            {caption.text}
          </p>
        ) : null}
        {rendererError ? <p className="companion__caption" data-speaker="notice">{rendererError}</p> : null}
        <div className="companion__status" role="status">
          <span className="companion__dot" aria-hidden="true" />
          {status}
        </div>
        {android ? (
          <button
            type="button"
            className="companion__settings"
            aria-label="Connection settings"
            onPointerUp={(event) => {
              event.stopPropagation();
              android.openSettings();
            }}
          >
            ⚙
          </button>
        ) : null}
      </main>
    </AnimationBusProvider>
  );
}

/** Play the avatar tags in each reply sentence as it starts, like the desktop does. */
function createTagPlayer(
  client: CompanionClient,
  bus: AvatarAnimationBus,
  sceneRef: { current: CompanionScene | null },
): (text: string) => void {
  const moveFilter = new MoveRequestFilter();
  return (text: string) => {
    const scene = sceneRef.current;
    if (!scene) return;
    const animationSlugs = new Set(scene.animations.map((entry) => toAnimationSlug(entry.name)).filter(Boolean));
    const poseSlugs = new Map(scene.poses.map((entry) => [toAnimationSlug(entry.name), entry.id]));
    for (const tag of extractAvatarTags(text, { allowedAnimationSlugs: animationSlugs, allowedPoseSlugs: poseSlugs.keys() })) {
      if (tag.type === 'anim') {
        bus.enqueue({ slug: tag.slug, intent: 'play', source: 'companion' });
      } else {
        const id = poseSlugs.get(tag.slug);
        if (!id) continue;
        client
          .loadPose(id)
          .then((pose) => {
            if (pose && typeof pose === 'object') {
              bus.applyPose(pose as Record<string, { rotation: number[]; position?: number[] }>, 'companion');
            }
          })
          .catch((error: unknown) => console.warn('[companion] pose failed', error));
      }
    }
    if (!scene.motionReady) return;
    for (const move of extractMoveTags(text)) {
      if (!moveFilter.shouldStart(move.text)) continue;
      const streamId = Math.random().toString(36).slice(2, 10);
      client
        .motion({ streamId, prompt: move.text, avatarRest: getAvatarRestSkeleton() ?? undefined }, (event) => {
          if (event.type === 'motion') enqueueMotionChunk(bus, event);
        })
        .catch((error: unknown) => console.warn('[companion] live motion failed', error));
    }
  };
}

function installAvatarBridge(client: CompanionClient, scene: { current: CompanionScene | null }): void {
  const target = window as unknown as { aiembodied?: Record<string, unknown> };
  target.aiembodied = {
    ...(target.aiembodied ?? {}),
    avatar: {
      loadModelBinary: (id: string) => client.loadAvatar(id),
      listAnimations: async () =>
        (scene.current?.animations ?? []).map((entry) => ({ ...entry, createdAt: 0, fileSha: '', duration: null, fps: null })),
      loadAnimationBinary: (id: string) => client.loadAnimation(id),
    },
  };
}

function PairingForm({ onPaired }: { onPaired: (connection: CompanionConnection) => void }) {
  const [code, setCode] = useState('');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = code.trim();
    if (!trimmed) return;
    saveBrowserCode(safeStorage(), trimmed);
    const connection = readConnection(window.location, safeStorage());
    if (connection) onPaired(connection);
  };
  return (
    <main className="companion companion--pairing">
      <form className="companion__pairing" onSubmit={submit}>
        <h1>Pair with the desktop</h1>
        <p>Enter the pairing code from Settings → Phone companion on the desktop app.</p>
        <input
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="ABCD-EFGH-JKMN"
          autoCapitalize="characters"
          autoComplete="off"
          aria-label="Pairing code"
        />
        <button type="submit">Pair</button>
      </form>
    </main>
  );
}

function safeStorage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function hashString(value: string): number {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = (hash * 31 + value.charCodeAt(i)) | 0;
  }
  return hash;
}
