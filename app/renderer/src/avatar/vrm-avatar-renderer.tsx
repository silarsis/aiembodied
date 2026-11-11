import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import type { VisemeFrame } from '../audio/viseme-driver.js';
import type { AvatarModelSummary } from './types.js';
import { getPreloadApi } from '../preload-api.js';
import { useAvatarAnimationQueue, type AvatarAnimationEvent } from './animation-bus.js';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { RoomSceneController } from '../rooms/room-scene-controller.js';
import type { SceneActionExecutor } from '../rooms/scene-executor.js';
import { useBehaviorCues, type BehaviorCueEvent } from './behavior-cues.js';
import { AvatarActor, DEFAULT_AVATAR_ID } from './avatar-actor.js';
import {
  fitCameraToBounds,
  renderedFootFraction,
  type IdleAnimationOptions,
} from './vrm-avatar-helpers.js';

// The pure helpers moved to vrm-avatar-helpers.ts (and the per-avatar state to avatar-actor.ts);
// they stay importable from here.
export {
  applyBaseNeutralPose,
  applyPoseExpressions,
  captureCurrentPose,
  clamp01,
  createPoseTransitionClip,
  createRightArmWaveClip,
  mapVisemeToPreset,
  normalizePoseData,
  poseBonesForVrm,
  renderedFootFraction,
  smoothWeight,
  suppressOutlierMeshes,
} from './vrm-avatar-helpers.js';
export type { CapturedBoneState, IdleAnimationOptions } from './vrm-avatar-helpers.js';

export interface VrmRendererStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
}

/** One avatar on the 2D stage. */
export interface VrmStageAvatar {
  id: string;
  /** Shown under the avatar when two or more share the stage. */
  name?: string;
  /** The body to wear (null while it is not known; the caller resolves shared bodies to Echo's model). */
  model: AvatarModelSummary | null;
  /** This avatar's own lip-sync frame. */
  frame: VisemeFrame | null;
}

export interface VrmAvatarRendererProps {
  frame: VisemeFrame | null;
  model: AvatarModelSummary | null | undefined;
  /**
   * The avatars on the stage, side by side (2D only). Absent means one `echo` avatar made of the
   * `model` and `frame` props, exactly as before. In a 3D room the others stand still beside Echo.
   */
  avatars?: VrmStageAvatar[];
  onStatusChange?: (status: VrmRendererStatus) => void;
  onGroundPositionChange?: (fraction: number) => void;
  className?: string;
  idleOptions?: IdleAnimationOptions;
  animationVersion?: number;
  /** A 3D room to stand in. Null or absent keeps the 2D backdrop behaviour. */
  room?: RoomFile | null;
  /** How tall the avatar stands in rooms, sole to crown, in metres. */
  roomAvatarHeight?: number;
  /** Developer overlay of the walkable area (rooms only). */
  showWalkableArea?: boolean;
  /** Runs scene actions (walk, sit, pick up) in the room; it is given the room's env while this renders. */
  sceneActions?: SceneActionExecutor | null;
  /**
   * The scene action executor of each avatar other than Echo (null when it has none). Each is given that avatar's
   * env while the avatar is on stage, and reset when the room changes.
   */
  sceneExecutors?: ((avatarId: string) => SceneActionExecutor | null) | null;
}

const CAMERA_DISTANCE = 1.45;
const CAMERA_HEIGHT = 1.35;
const CAMERA_FOV = 35;
const VRM_CANVAS_WIDTH = 480;
const VRM_CANVAS_HEIGHT = 640;
/** Gap between neighbouring avatars, as a fraction of the wider one's width. */
const AVATAR_GAP_FRACTION = 0.15;
const MAX_STAGE_AVATARS = 3;
/** A frame this open counts as the avatar speaking (name label highlight). */
const SPEAKING_INTENSITY = 0.05;

interface ActorBounds {
  size: THREE.Vector3;
  center: THREE.Vector3;
}

/**
 * Side-by-side x offsets, symmetric around the centre, for models of these widths (in order).
 * One model stays where the loader put it (offset 0).
 */
export function layoutOffsets(widths: number[]): number[] {
  if (widths.length <= 1) {
    return widths.map(() => 0);
  }
  const widest = Math.max(...widths, 0.1);
  const gap = widest * AVATAR_GAP_FRACTION;
  const total = widths.reduce((sum, width) => sum + width, 0) + gap * (widths.length - 1);
  const offsets: number[] = [];
  let cursor = -total / 2;
  for (const width of widths) {
    offsets.push(cursor + width / 2);
    cursor += width + gap;
  }
  return offsets;
}

export const VrmAvatarRenderer = memo(function VrmAvatarRenderer({
  frame,
  model: modelProp,
  avatars,
  onStatusChange,
  onGroundPositionChange,
  className,
  idleOptions,
  animationVersion,
  room = null,
  roomAvatarHeight,
  showWalkableArea = false,
  sceneActions = null,
  sceneExecutors = null,
}: VrmAvatarRendererProps) {
  const sceneExecutorsRef = useRef(sceneExecutors);
  useEffect(() => { sceneExecutorsRef.current = sceneExecutors; }, [sceneExecutors]);
  const roomRef = useRef<RoomFile | null>(room);
  roomRef.current = room;
  const roomControllerRef = useRef<RoomSceneController | null>(null);
  /** Id of the room the stage was last given, so a reload of the same room can be told from a new one. */
  const lastRoomIdRef = useRef<string | null>(null);
  const groundCallbackRef = useRef(onGroundPositionChange);
  const groundMeasuredRef = useRef(false);
  useEffect(() => { groundCallbackRef.current = onGroundPositionChange; }, [onGroundPositionChange]);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  /**
   * The avatars in this scene, by id. Exactly one today ('echo'); the per-avatar state (VRM, mixer,
   * expressions, idle, animation queue) lives in the actor, the per-scene state stays here.
   */
  const actorsRef = useRef<Map<string, AvatarActor> | null>(null);
  if (actorsRef.current === null) {
    actorsRef.current = new Map([
      [DEFAULT_AVATAR_ID, new AvatarActor({ id: DEFAULT_AVATAR_ID, hasRoom: () => roomRef.current !== null })],
    ]);
  }
  const actors = actorsRef.current;
  const actor = actors.get(DEFAULT_AVATAR_ID) as AvatarActor;
  const [rendererReady, setRendererReady] = useState(false);

  // Without `avatars` the stage is the one echo avatar of the model and frame props.
  const echoEntry = avatars ? avatars.find((entry) => entry.id === DEFAULT_AVATAR_ID) : undefined;
  const model = avatars ? echoEntry?.model : modelProp;
  const echoFrame = avatars ? (echoEntry?.frame ?? null) : frame;
  const extraEntries = useMemo(
    () => (avatars ? avatars.filter((entry) => entry.id !== DEFAULT_AVATAR_ID).slice(0, MAX_STAGE_AVATARS - 1) : []),
    [avatars],
  );
  const extraKey = extraEntries.map((entry) => `${entry.id}:${entry.model?.id ?? ''}:${entry.model?.fileSha ?? ''}`).join('|');
  const stageUnits = 1 + extraEntries.length;
  /** Rest-pose bounds of each loaded body (before it is placed), by avatar id. */
  const boundsRef = useRef(new Map<string, ActorBounds>());
  const loadedModelRef = useRef(new Map<string, string>());
  const laidOutMultiRef = useRef(false);
  const stageUnitsAppliedRef = useRef(1);
  const [labelPositions, setLabelPositions] = useState<Array<{ id: string; leftPct: number }>>([]);
  const relayoutRef = useRef<() => void>(() => undefined);
  relayoutRef.current = () => {
    const camera = cameraRef.current;
    if (!camera || !sceneRef.current || roomRef.current) {
      return;
    }
    const ids = [DEFAULT_AVATAR_ID, ...extraEntries.map((entry) => entry.id)].filter(
      (id) => actors.get(id)?.getVrm() && boundsRef.current.has(id),
    );
    if (ids.length <= 1) {
      if (laidOutMultiRef.current) {
        // Back to one avatar: stand where the loader put it and frame it alone, as a fresh load does.
        laidOutMultiRef.current = false;
        groundMeasuredRef.current = false;
        setLabelPositions([]);
        const own = boundsRef.current.get(DEFAULT_AVATAR_ID);
        if (actor.getVrm()) {
          actor.placeAt(0, 0, 0);
        }
        if (own) {
          camera.aspect = VRM_CANVAS_WIDTH / VRM_CANVAS_HEIGHT;
          fitCameraToBounds(camera, own);
        }
      }
      return;
    }
    const widths = ids.map((id) => (boundsRef.current.get(id) as ActorBounds).size.x);
    const offsets = layoutOffsets(widths);
    const min = { x: Infinity, y: Infinity, z: Infinity };
    const max = { x: -Infinity, y: -Infinity, z: -Infinity };
    ids.forEach((id, index) => {
      const bounds = boundsRef.current.get(id) as ActorBounds;
      const offset = offsets[index] ?? 0;
      actors.get(id)?.placeAt(offset, 0, 0);
      min.x = Math.min(min.x, bounds.center.x - bounds.size.x / 2 + offset);
      max.x = Math.max(max.x, bounds.center.x + bounds.size.x / 2 + offset);
      min.y = Math.min(min.y, bounds.center.y - bounds.size.y / 2);
      max.y = Math.max(max.y, bounds.center.y + bounds.size.y / 2);
      min.z = Math.min(min.z, bounds.center.z - bounds.size.z / 2);
      max.z = Math.max(max.z, bounds.center.z + bounds.size.z / 2);
    });
    // The canvas is as many portrait frames wide as there are avatars (see the canvas size effect).
    camera.aspect = (VRM_CANVAS_WIDTH * stageUnits) / VRM_CANVAS_HEIGHT;
    // fitCameraToBounds frames the largest dimension in the vertical field of view; a wide
    // group is scaled down by the aspect so its width fits too.
    fitCameraToBounds(camera, {
      size: new THREE.Vector3((max.x - min.x) / camera.aspect, max.y - min.y, max.z - min.z),
      center: new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, (min.z + max.z) / 2),
    });
    laidOutMultiRef.current = true;
    groundMeasuredRef.current = false;
    const distance = camera.position.z - (min.z + max.z) / 2;
    const visibleWidth = 2 * distance * Math.tan((CAMERA_FOV * Math.PI) / 360) * camera.aspect;
    setLabelPositions(
      ids.map((id, index) => ({ id, leftPct: 50 + (((offsets[index] ?? 0) + (boundsRef.current.get(id)?.center.x ?? 0) - camera.position.x) / visibleWidth) * 100 })),
    );
  };

  actor.setVisemeFrame(echoFrame);
  for (const entry of extraEntries) {
    actors.get(entry.id)?.setVisemeFrame(entry.frame);
  }
  actor.setIdleOptions(idleOptions);

  const handleBehaviorCue = useCallback(
    (event: BehaviorCueEvent) => {
      if (event.name !== 'greet_face') {
        return;
      }

      const played = actor.playWave();
      if (!played) {
        console.warn('[vrm-avatar-renderer] Received greet_face cue but wave animation is unavailable.', {
          source: event.source,
        });
      } else {
        console.info('[vrm-avatar-renderer] greet_face cue triggered wave animation.', {
          source: event.source,
        });
      }
    },
    [actor],
  );

  useBehaviorCues(handleBehaviorCue);

  const handleAnimationEvent = useCallback(
    (event: AvatarAnimationEvent) => {
      // Each actor consumes only the events addressed to its own id.
      for (const candidate of actors.values()) {
        candidate.handleAnimationEvent(event);
      }
    },
    [actors],
  );

  useAvatarAnimationQueue(handleAnimationEvent);

  const setStatus = useMemo(() => {
    return (status: VrmRendererStatus) => {
      onStatusChange?.(status);
    };
  }, [onStatusChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const isJsdom =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? /jsdom/i.test(navigator.userAgent)
        : false;

    if (isJsdom && typeof (canvas as { getContext?: unknown }).getContext !== 'function') {
      // jsdom canvas stubs may not implement getContext; skip initialization for tests
      setStatus({ status: 'idle' });
      return;
    }

    let renderer: THREE.WebGLRenderer | null = null;

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize WebGL renderer.';
      console.error('[vrm-avatar-renderer] unable to create WebGLRenderer', error);
      setStatus({ status: 'error', message });
      return;
    }

    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 20);
    camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);
    camera.lookAt(0, CAMERA_HEIGHT - 0.1, 0);
    cameraRef.current = camera;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(0.8, 1.6, 1.0);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-1.2, 1.2, 0.8);

    scene.add(ambient);
    scene.add(keyLight);
    scene.add(fillLight);

    const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1;
    canvas.width = Math.floor(VRM_CANVAS_WIDTH * pixelRatio);
    canvas.height = Math.floor(VRM_CANVAS_HEIGHT * pixelRatio);
    canvas.style.width = `${VRM_CANVAS_WIDTH}px`;
    canvas.style.height = `${VRM_CANVAS_HEIGHT}px`;
    renderer.setPixelRatio(pixelRatio);
    renderer.setSize(VRM_CANVAS_WIDTH, VRM_CANVAS_HEIGHT, false);
    if (camera) {
      camera.aspect = VRM_CANVAS_WIDTH / VRM_CANVAS_HEIGHT;
      camera.updateProjectionMatrix();
    }

    roomControllerRef.current = new RoomSceneController({
      renderer,
      scene,
      camera,
      canvas,
      legacySize: { width: VRM_CANVAS_WIDTH, height: VRM_CANVAS_HEIGHT },
    });

    const timer = new THREE.Timer();
    timer.connect(document);

    const renderFrame = () => {
      const rendererInstance = rendererRef.current;
      const sceneInstance = sceneRef.current;
      const cameraInstance = cameraRef.current;
      if (!rendererInstance || !sceneInstance || !cameraInstance) {
        return;
      }

      timer.update();
      const delta = timer.getDelta();

      const now = Date.now();
      for (const frameActor of actors.values()) {
        // The room controller steps between the mixer and the rest of the actor's update.
        // Only Echo's body drives the room (walking, physics); companions just stand.
        frameActor.update(delta, now, {
          afterMixer: frameActor === actor ? () => roomControllerRef.current?.step(delta) : () => undefined,
        });
      }

      rendererInstance.render(sceneInstance, cameraInstance);
      for (const frameActor of actors.values()) {
        frameActor.checkJump(roomControllerRef.current?.active ?? false);
      }
      if (actor.getVrm() && !groundMeasuredRef.current && !roomControllerRef.current?.active) {
        const fraction = renderedFootFraction(rendererInstance);
        if (fraction !== null) {
          groundMeasuredRef.current = true;
          groundCallbackRef.current?.(fraction);
        }
      }
      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    animationFrameRef.current = requestAnimationFrame(renderFrame);
    setRendererReady(true);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      scene.remove(ambient);
      scene.remove(keyLight);
      scene.remove(fillLight);
      roomControllerRef.current?.dispose();
      roomControllerRef.current = null;
      for (const disposable of actors.values()) {
        disposable.dispose();
      }
      timer.dispose();
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
    };
  }, [actor, actors, setStatus]);

  useEffect(() => {
    if (!rendererReady) {
      return;
    }

    const scene = sceneRef.current;
    if (!scene || !rendererRef.current) {
      return;
    }

    let cancelled = false;

    const unload = () => {
      groundMeasuredRef.current = false;
      boundsRef.current.delete(DEFAULT_AVATAR_ID);
      actor.unload({
        parent: scene,
        onDetach: () => roomControllerRef.current?.attachAvatar(null),
      });
    };

    const load = async () => {
      if (!model) {
        unload();
        setStatus({ status: 'idle' });
        return;
      }

      unload();
      setStatus({ status: 'loading' });

      try {
        const bridge = getPreloadApi();
        const binary = await bridge?.avatar?.loadModelBinary(model.id);
        if (!binary) {
          throw new Error('VRM binary payload is unavailable.');
        }

        const loaded = await actor.load({
          binary,
          modelId: model.id,
          parent: scene,
          isCancelled: () => cancelled,
          onBounds: (renderableBounds) => {
            if (renderableBounds) {
              boundsRef.current.set(DEFAULT_AVATAR_ID, { size: renderableBounds.size.clone(), center: renderableBounds.center.clone() });
            } else {
              boundsRef.current.delete(DEFAULT_AVATAR_ID);
            }
            if (renderableBounds && cameraRef.current) {
              // In a room the camera belongs to the room; fit a copy so leaving the room restores this view.
              const controller = roomControllerRef.current;
              if (controller?.active) {
                const spare = cameraRef.current.clone();
                fitCameraToBounds(spare, renderableBounds);
                controller.remember2dCamera(spare);
              } else {
                fitCameraToBounds(cameraRef.current, renderableBounds);
              }
            }
          },
          onAttached: ({ vrm, restSkeleton }) => {
            roomControllerRef.current?.attachAvatar(vrm.scene, vrm.humanoid, restSkeleton?.hips[1]);
          },
        });
        if (!loaded) {
          return;
        }
        relayoutRef.current();
        setStatus({ status: 'ready' });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to load VRM model. Please check the console logs.';
        console.error('[vrm-avatar-renderer] failed to load VRM model', error);
        unload();
        setStatus({ status: 'error', message });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [
    actor,
    model,
    model?.id,
    model?.fileSha,
    rendererReady,
    setStatus,
  ]);

  useEffect(() => {
    actor.applyIdleOptions(idleOptions);
    for (const other of actors.values()) {
      if (other !== actor) {
        other.setIdleOptions(idleOptions);
        other.applyIdleOptions(idleOptions);
      }
    }
  }, [actor, actors, idleOptions]);

  useEffect(() => {
    if (animationVersion === undefined) {
      return;
    }
    return actor.reloadClipRegistry();
  }, [actor, animationVersion]);

  // The canvas is one portrait frame wide per avatar (2D only), so avatars side by side keep their size.
  // Applied whenever the number of frames changes and again when a room hands the canvas back (the room
  // controller restores the single-frame size when it stops), so the drawing size, camera aspect and the
  // CSS box always agree.
  const applyStageSizeRef = useRef<() => void>(() => undefined);
  applyStageSizeRef.current = () => {
    const renderer = rendererRef.current;
    const canvas = canvasRef.current;
    const camera = cameraRef.current;
    if (!renderer || !canvas || !camera || roomRef.current) {
      return;
    }
    const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1;
    const width = VRM_CANVAS_WIDTH * stageUnits;
    canvas.width = Math.floor(width * pixelRatio);
    canvas.height = Math.floor(VRM_CANVAS_HEIGHT * pixelRatio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${VRM_CANVAS_HEIGHT}px`;
    renderer.setSize(width, VRM_CANVAS_HEIGHT, false);
    camera.aspect = width / VRM_CANVAS_HEIGHT;
    camera.updateProjectionMatrix();
    relayoutRef.current();
  };
  useEffect(() => {
    if (!rendererReady) {
      return;
    }
    stageUnitsAppliedRef.current = stageUnits;
    applyStageSizeRef.current();
  }, [stageUnits, rendererReady]);

  /** An extra avatar left the stage: its executor stops (no env) and the room forgets its body. */
  const detachExtra = (id: string) => {
    sceneExecutorsRef.current?.(id)?.setEnv(null);
    roomControllerRef.current?.detachCompanion(id);
  };

  // The other avatars (never Echo, who has the effects above): one actor each, loaded from its own model.
  useEffect(() => {
    if (!rendererReady) {
      return;
    }
    const scene = sceneRef.current;
    if (!scene) {
      return;
    }
    let cancelled = false;
    const wanted = new Set(extraEntries.map((entry) => entry.id));
    for (const [id, other] of [...actors.entries()]) {
      if (id === DEFAULT_AVATAR_ID || wanted.has(id)) {
        continue;
      }
      other.unload({ parent: scene, onDetach: () => detachExtra(id) });
      other.dispose();
      actors.delete(id);
      boundsRef.current.delete(id);
      loadedModelRef.current.delete(id);
    }
    relayoutRef.current();

    const loadOne = async (entry: VrmStageAvatar) => {
      let other = actors.get(entry.id);
      if (!other) {
        other = new AvatarActor({ id: entry.id, hasRoom: () => roomRef.current !== null });
        other.setIdleOptions(idleOptions);
        actors.set(entry.id, other);
      }
      const wantedKey = `${entry.model?.id ?? ''}:${entry.model?.fileSha ?? ''}`;
      if (loadedModelRef.current.get(entry.id) === wantedKey) {
        return;
      }
      loadedModelRef.current.delete(entry.id);
      boundsRef.current.delete(entry.id);
      const detach = () => detachExtra(entry.id);
      other.unload({ parent: scene, onDetach: detach });
      if (!entry.model) {
        relayoutRef.current();
        return;
      }
      try {
        const binary = await getPreloadApi()?.avatar?.loadModelBinary(entry.model.id);
        if (!binary) {
          throw new Error('VRM binary payload is unavailable.');
        }
        const loaded = await other.load({
          binary,
          modelId: entry.model.id,
          parent: scene,
          isCancelled: () => cancelled,
          // The camera is fitted to all avatars together in relayout.
          onAttached: ({ vrm, restSkeleton }) => {
            const controller = roomControllerRef.current;
            controller?.attachCompanion(entry.id, vrm.scene, vrm.humanoid, restSkeleton?.hips[1]);
            // The avatar's executor starts working in the room's env as soon as the avatar is there.
            sceneExecutorsRef.current?.(entry.id)?.setEnv(controller?.envFor(entry.id) ?? null);
          },
          onBounds: (bounds) => {
            if (bounds) {
              boundsRef.current.set(entry.id, { size: bounds.size.clone(), center: bounds.center.clone() });
            }
          },
        });
        if (!loaded || cancelled) {
          return;
        }
        loadedModelRef.current.set(entry.id, wantedKey);
        other.applyIdleOptions(idleOptions);
        relayoutRef.current();
      } catch (error) {
        console.error('[vrm-avatar-renderer] failed to load VRM model for avatar', entry.id, error);
        other.unload({ parent: scene, onDetach: () => detachExtra(entry.id) });
      }
    };
    for (const entry of extraEntries) {
      void loadOne(entry);
    }
    return () => {
      cancelled = true;
    };
    // extraKey stands for the entries' ids and models; frames change every tick and are applied in render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendererReady, extraKey, actors]);

  // After the extras went away (a room, or they left), put Echo back where a single avatar stands.
  useEffect(() => {
    if (rendererReady && extraEntries.length === 0) {
      relayoutRef.current();
    }
  }, [rendererReady, extraEntries.length]);

  useEffect(() => {
    const controller = roomControllerRef.current;
    if (!rendererReady || !controller) {
      return;
    }
    // Any walk, sit or motion in progress is cancelled when the stage changes. The same room
    // loaded again (an object was made for it) leaves the avatar and its action alone.
    const reload = room !== null && lastRoomIdRef.current === room.id;
    lastRoomIdRef.current = room?.id ?? null;
    if (!reload) {
      actor.cancelAnimations();
      sceneActions?.reset();
      for (const [id, other] of actors) {
        if (id === DEFAULT_AVATAR_ID) continue;
        other.cancelAnimations();
        sceneExecutorsRef.current?.(id)?.reset();
      }
    }
    void controller.setRoom(room).then(() => {
      // Leaving a room restores the single-frame canvas size; set it back for the avatars on stage.
      if (roomRef.current === null) {
        applyStageSizeRef.current();
      }
    });
  }, [room, rendererReady, actor, sceneActions]);

  useEffect(() => {
    if (!rendererReady || roomAvatarHeight === undefined) return;
    roomControllerRef.current?.setAvatarHeight(roomAvatarHeight);
  }, [roomAvatarHeight, rendererReady]);

  useEffect(() => {
    const controller = roomControllerRef.current;
    if (!sceneActions || !rendererReady || !controller) {
      return;
    }
    sceneActions.setEnv(controller.sceneEnv);
    return () => sceneActions.setEnv(null);
  }, [sceneActions, rendererReady]);

  // Executors handed over after their avatar loaded (or swapped) get the env of that avatar.
  useEffect(() => {
    const controller = roomControllerRef.current;
    if (!sceneExecutors || !rendererReady || !controller) {
      return;
    }
    const bound: Array<SceneActionExecutor> = [];
    for (const entry of extraEntries) {
      const executor = sceneExecutors(entry.id);
      const env = controller.envFor(entry.id);
      if (!executor || !env) continue;
      executor.setEnv(env);
      bound.push(executor);
    }
    return () => {
      for (const executor of bound) executor.setEnv(null);
    };
    // extraKey stands for the entries' ids and models.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneExecutors, rendererReady, extraKey]);

  // Names for the reasons avatars hear ("Sage is sitting on the sofa").
  const stageNames = (avatars ?? []).map((entry) => `${entry.id}\u0000${entry.name ?? ''}`).join('\u0001');
  useEffect(() => {
    const names: Record<string, string> = {};
    for (const entry of avatars ?? []) if (entry.name) names[entry.id] = entry.name;
    roomControllerRef.current?.occupancy.setNames(names);
    // stageNames stands for the ids and names.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stageNames, rendererReady]);

  useEffect(() => {
    roomControllerRef.current?.setDebugNavmesh(showWalkableArea);
  }, [showWalkableArea, rendererReady, room]);

  const canvasElement = <canvas ref={canvasRef} className={className} data-renderer="vrm" />;
  if (extraEntries.length === 0 || room) {
    // In a room the avatars stand in the scene; the 2D name labels don't apply.
    return canvasElement;
  }
  // Two or more avatars: a small name label under each (the speaking one is marked).
  const shown = [DEFAULT_AVATAR_ID, ...extraEntries.map((entry) => entry.id)];
  const frames = new Map<string, VisemeFrame | null>([[DEFAULT_AVATAR_ID, echoFrame], ...extraEntries.map((entry) => [entry.id, entry.frame] as const)]);
  const names = new Map<string, string>([[DEFAULT_AVATAR_ID, echoEntry?.name ?? 'Echo'], ...extraEntries.map((entry) => [entry.id, entry.name ?? entry.id] as const)]);
  return (
    <>
      {canvasElement}
      <div className="stageAvatarLabels" aria-hidden="true">
        {shown.map((id, index) => {
          const frameOfAvatar = frames.get(id) ?? null;
          const position = labelPositions.find((item) => item.id === id);
          return (
            <span
              key={id}
              className="stageAvatarLabel"
              data-avatar-id={id}
              data-speaking={frameOfAvatar !== null && frameOfAvatar.intensity > SPEAKING_INTENSITY ? 'true' : 'false'}
              style={{ left: `${position?.leftPct ?? ((index + 0.5) / shown.length) * 100}%` }}
            >
              {names.get(id)}
            </span>
          );
        })}
      </div>
    </>
  );
});
