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

export interface VrmAvatarRendererProps {
  frame: VisemeFrame | null;
  model: AvatarModelSummary | null | undefined;
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
}

const CAMERA_DISTANCE = 1.45;
const CAMERA_HEIGHT = 1.35;
const CAMERA_FOV = 35;
const VRM_CANVAS_WIDTH = 480;
const VRM_CANVAS_HEIGHT = 640;

export const VrmAvatarRenderer = memo(function VrmAvatarRenderer({
  frame,
  model,
  onStatusChange,
  onGroundPositionChange,
  className,
  idleOptions,
  animationVersion,
  room = null,
  roomAvatarHeight,
  showWalkableArea = false,
  sceneActions = null,
}: VrmAvatarRendererProps) {
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

  actor.setVisemeFrame(frame);
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
        frameActor.update(delta, now, { afterMixer: () => roomControllerRef.current?.step(delta) });
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
  }, [actor, idleOptions]);

  useEffect(() => {
    if (animationVersion === undefined) {
      return;
    }
    return actor.reloadClipRegistry();
  }, [actor, animationVersion]);

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
    }
    void controller.setRoom(room);
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

  useEffect(() => {
    roomControllerRef.current?.setDebugNavmesh(showWalkableArea);
  }, [showWalkableArea, rendererReady, room]);

  return <canvas ref={canvasRef} className={className} data-renderer="vrm" />;
});
