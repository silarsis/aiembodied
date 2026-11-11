import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMLoaderPlugin,
  VRMUtils,
  VRMExpressionPresetName,
  VRMHumanBoneList,
  type VRMExpressionManager,
} from '@pixiv/three-vrm';
import { measureRestSkeleton, setAvatarRestSkeleton } from './rest-skeleton.js';
import type { AvatarRestSkeleton } from './types.js';
import type {
  AvatarAnimationEvent,
  AvatarAnimationRequest,
  AvatarAnimationTiming,
  PoseTransitionConfig,
  VRMPoseData,
  VRMPoseExpressions,
} from './animation-bus.js';
import { LIVE_MOTION_SOURCE } from './live-motion.js';
import { pinHipsHorizontal } from './hips-pinning.js';
import { JumpDetector } from '../rooms/jump-detector.js';
import { PoseBlend } from './pose-blend.js';
import type { VisemeFrame } from '../audio/viseme-driver.js';
import { createClipFromVrma, createMixerForVrm } from './animations/index.js';
import { IdleAnimationScheduler } from './animations/idle-scheduler.js';
import {
  BLINK_HOLD_SECONDS,
  CLIP_FADE_IN_SECONDS,
  CLIP_FADE_OUT_SECONDS,
  DEFAULT_POSE_TRANSITION_DURATION,
  MAX_RENDERABLE_SIZE,
  MOTION_RELEASE_BLEND_SECONDS,
  VISEME_PRESETS,
  applyBaseNeutralPose,
  applyExpressionFrameAtTime,
  applyPoseExpressions,
  buildIdleSchedulerConfig,
  captureCurrentPose,
  clamp01,
  computeRenderableBounds,
  createDefaultBlinkState,
  createDefaultVisemeState,
  createPoseTransitionClip,
  createRightArmWaveClip,
  disposeVrm,
  getHeadBounds,
  loadVrmaAnimation,
  loadVrmaClips,
  mapVisemeToPreset,
  normalizeVrmScene,
  poseBonesForVrm,
  smoothWeight,
  suppressOutlierMeshes,
  type BlinkState,
  type IdleAnimationOptions,
  type VisemeWeightState,
  type VrmaClipWithMetadata,
  type VrmaGltf,
} from './vrm-avatar-helpers.js';

/** The avatar every pre-multi-avatar request and event belongs to. */
export const DEFAULT_AVATAR_ID = 'echo';

type AnimationQueueIntent = 'play' | 'pose';

interface QueuedAnimation {
  slug: string;
  intent: AnimationQueueIntent;
  source?: string;
  timing?: AvatarAnimationTiming;
  /** Registered for a single playback (streamed clips); dropped from the registry once played. */
  ephemeral?: boolean;
  onEnd?: AvatarAnimationRequest['onEnd'];
  continuation?: boolean;
}

interface ActiveAnimation {
  action: THREE.AnimationAction;
  intent: AnimationQueueIntent;
  onFinish: (event: { action?: THREE.AnimationAction | null }) => void;
  vrmaData?: VrmaGltf;
  /** The clip ended on request 'hold': its last frame stays (a seated pose) until another clip replaces it. */
  held?: boolean;
  dispose?: () => void;
}

export interface AvatarActorOptions {
  /** Avatar id; the animation bus routes requests to the actor with the matching id. Default 'echo'. */
  id?: string;
  /**
   * Whether a 3D room is the stage. Streamed live-motion clips only get their horizontal hips travel
   * dropped on the 2D backdrop, where the avatar stays on its spot.
   */
  hasRoom?: () => boolean;
}

export interface AvatarActorLoadOptions {
  /** The VRM file. Fetching it (IPC) is the caller's job. */
  binary: ArrayBuffer;
  modelId: string;
  /** The scene (or group) the loaded VRM is added to. */
  parent: THREE.Object3D;
  /** True once the caller no longer wants this load; checked at the same points as before the refactor. */
  isCancelled?: () => boolean;
  /**
   * Called once the model is normalised and posed, before it is added to the scene, with the bounds of
   * its renderable meshes (null when it has none). The scene uses it to frame the camera.
   */
  onBounds?: (bounds: { box: THREE.Box3; size: THREE.Vector3; center: THREE.Vector3 } | null) => void;
  /** Called right after the model is added to the scene (room controllers attach the body here). */
  onAttached?: (attached: { actor: AvatarActor; vrm: VRM; restSkeleton: AvatarRestSkeleton | null }) => void;
}

export interface AvatarActorUnloadOptions {
  /** Scene the model was added to, so it can be removed from it. */
  parent?: THREE.Object3D | null;
  /** Called where the body is detached from the scene's room controller. */
  onDetach?: () => void;
}

export interface AvatarActorUpdateHooks {
  /** Runs right after the mixer update and before expression keyframes, idle motion and pose blending. */
  afterMixer?: () => void;
}

/**
 * Everything that belongs to one avatar in a scene: the VRM and its normalised scene graph, the
 * animation mixer and clip registry, expression (viseme / blink / emotion) state, the idle scheduler,
 * pose transitions, the animation-queue consumer, the rest-skeleton measurement and the jump
 * diagnostic. The scene (WebGL renderer, camera, lights, room stage, frame loop) lives in
 * `VrmAvatarRenderer`, which calls `update` once per frame.
 *
 * Plain TypeScript, no React. `dispose()` leaves the actor reusable, because the owning component
 * can tear its scene down and build it again while keeping the same actor.
 */
export class AvatarActor {
  readonly id: string;

  private readonly hasRoom: () => boolean;
  private vrm: VRM | null = null;
  private parent: THREE.Object3D | null = null;
  private restSkeleton: AvatarRestSkeleton | null = null;
  private mixer: THREE.AnimationMixer | null = null;
  private idleScheduler: IdleAnimationScheduler | null = null;
  private waveAction: THREE.AnimationAction | null = null;
  private expressionManager: VRMExpressionManager | null = null;
  private visemeState: VisemeWeightState = createDefaultVisemeState();
  private blinkState: BlinkState = createDefaultBlinkState();
  private frame: VisemeFrame | null = null;
  private idleOptions: IdleAnimationOptions | undefined;
  private clipRegistry = new Map<string, VrmaClipWithMetadata>();
  private animationQueue: QueuedAnimation[] = [];
  private streamedClipLoad: Promise<void> = Promise.resolve();
  private activeAnimation: ActiveAnimation | null = null;
  private animationSuspension: (() => void) | null = null;
  private vrmaRegistryReady = false;
  /** Clips that handed over to a continuation clip; stopped just before the next mixer update. */
  private handedOver: (() => void)[] = [];
  private readonly jumpDetector = new JumpDetector();
  private readonly poseBlend = new PoseBlend();
  /** Position the normaliser gave the scene (feet on the floor, centred); `placeAt` offsets from it. */
  private baseX = 0;
  private baseZ = 0;
  private baseYaw = 0;
  private lastUpdateAt = 0;

  constructor(options: AvatarActorOptions = {}) {
    this.id = options.id ?? DEFAULT_AVATAR_ID;
    this.hasRoom = options.hasRoom ?? (() => false);
  }

  // ---- accessors -----------------------------------------------------------------------------

  /** The loaded model's root, or null before a model is loaded. */
  getObject3D(): THREE.Object3D | null {
    return this.vrm?.scene ?? null;
  }

  getVrm(): VRM | null {
    return this.vrm;
  }

  /** The rest skeleton measured when the model loaded, before the relaxed pose bent the arms. */
  getRestSkeleton(): AvatarRestSkeleton | null {
    return this.restSkeleton;
  }

  /** True while a queued or playing clip/pose is keeping the idle scheduler suspended. */
  isIdleSuspended(): boolean {
    return this.animationSuspension !== null;
  }

  /** Current smoothed viseme weight for a preset, for diagnostics and tests. */
  getVisemeWeight(preset: VRMExpressionPresetName): number {
    return this.visemeState.weights.get(preset) ?? 0;
  }

  getBlinkValue(): number {
    return this.blinkState.value;
  }

  /** Wall-clock time (ms) of the last `update`, 0 before the first. */
  getLastUpdateAt(): number {
    return this.lastUpdateAt;
  }

  getQueuedAnimationCount(): number {
    return this.animationQueue.length;
  }

  // ---- inputs set by the owner on every render -----------------------------------------------

  /** The latest viseme frame from the audio driver. The actor smooths it into expression weights. */
  setVisemeFrame(frame: VisemeFrame | null): void {
    this.frame = frame;
  }

  /** Idle options used the next time the scheduler config is built (load or `applyIdleOptions`). */
  setIdleOptions(options: IdleAnimationOptions | undefined): void {
    this.idleOptions = options;
  }

  /** Push (possibly changed) idle options to the live scheduler. */
  applyIdleOptions(options: IdleAnimationOptions | undefined): void {
    const vrm = this.vrm;
    const scheduler = this.idleScheduler;
    if (!vrm || !scheduler) {
      return;
    }
    scheduler.updateConfig(buildIdleSchedulerConfig(vrm, options));
  }

  // ---- loading -------------------------------------------------------------------------------

  /**
   * Parse and prepare the VRM, add it to `options.parent`, and start its mixer, idle scheduler and
   * clip registry. Resolves false if the load was cancelled before the model went into the scene.
   * Throws on a parse failure; the caller then calls `unload()` and reports the error.
   */
  async load(options: AvatarActorLoadOptions): Promise<boolean> {
    const { binary, modelId, parent } = options;
    const isCancelled = options.isCancelled ?? (() => false);

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));
    const gltf = (await loader.parseAsync(binary, '/')) as { userData?: { vrm?: VRM } };
    const vrm = gltf.userData?.vrm;
    if (!vrm) {
      throw new Error('Parsed GLTF did not include a VRM extension.');
    }

    if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
      VRMUtils.removeUnnecessaryVertices(vrm.scene);
    }
    if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
      VRMUtils.removeUnnecessaryJoints(vrm.scene);
    }
    if (typeof VRMUtils.rotateVRM0 === 'function') {
      VRMUtils.rotateVRM0(vrm);
    }
    // Before the relaxed pose bends the arms: the motion service calibrates the arm swing from it.
    const restSkeleton = measureRestSkeleton(vrm);

    vrm.scene.traverse((object: THREE.Object3D) => {
      object.frustumCulled = false;
    });

    vrm.scene.rotation.y = vrm.meta?.metaVersion === '1' ? 0 : Math.PI;
    vrm.scene.updateWorldMatrix(true, true);
    normalizeVrmScene(vrm);
    applyBaseNeutralPose(vrm);
    vrm.scene.updateWorldMatrix(true, true);
    const hiddenMeshes = suppressOutlierMeshes(vrm.scene, MAX_RENDERABLE_SIZE);

    if (isCancelled()) {
      disposeVrm(vrm);
      return false;
    }

    const renderableBounds = computeRenderableBounds(vrm.scene);
    options.onBounds?.(renderableBounds);
    const meshStats = { meshes: 0, skinnedMeshes: 0 };
    vrm.scene.traverse((object) => {
      if ((object as THREE.Mesh).isMesh) {
        meshStats.meshes += 1;
      }
      if ((object as THREE.SkinnedMesh).isSkinnedMesh) {
        meshStats.skinnedMeshes += 1;
      }
    });
    const headBounds = getHeadBounds(vrm);
    const metricsPayload = {
      modelId,
      meshCount: meshStats.meshes,
      skinnedMeshCount: meshStats.skinnedMeshes,
      hiddenMeshes,
      bounds: renderableBounds
        ? {
          size: {
            x: Number(renderableBounds.size.x.toFixed(3)),
            y: Number(renderableBounds.size.y.toFixed(3)),
            z: Number(renderableBounds.size.z.toFixed(3)),
          },
          center: {
            x: Number(renderableBounds.center.x.toFixed(3)),
            y: Number(renderableBounds.center.y.toFixed(3)),
            z: Number(renderableBounds.center.z.toFixed(3)),
          },
        }
        : null,
      head: headBounds
        ? {
          widthCm: Number((headBounds.width * 100).toFixed(1)),
          heightCm: Number((headBounds.height * 100).toFixed(1)),
          depthCm: Number((headBounds.depth * 100).toFixed(1)),
        }
        : null,
    };
    console.info('[vrm-avatar-renderer] VRM scene metrics', JSON.stringify(metricsPayload));

    parent.add(vrm.scene);
    this.parent = parent;
    this.vrm = vrm;
    this.restSkeleton = restSkeleton;
    this.baseX = vrm.scene.position.x;
    this.baseZ = vrm.scene.position.z;
    this.baseYaw = vrm.scene.rotation.y;
    options.onAttached?.({ actor: this, vrm, restSkeleton });
    this.jumpDetector.track(vrm.scene, vrm.humanoid?.getNormalizedBoneNode('hips'), [
      vrm.humanoid?.getNormalizedBoneNode('leftHand'),
      vrm.humanoid?.getNormalizedBoneNode('rightHand'),
    ]);
    // The module-level slot serves the single body that `{move:...}` streams are calibrated for: Echo's.
    if (this.id === DEFAULT_AVATAR_ID) setAvatarRestSkeleton(restSkeleton);
    this.expressionManager = vrm.expressionManager ?? null;
    this.expressionManager?.resetValues();
    const mixer = createMixerForVrm(vrm);
    this.mixer = mixer;
    const idleSchedulerConfig = buildIdleSchedulerConfig(vrm, this.idleOptions);
    const idleScheduler = new IdleAnimationScheduler({
      mixer,
      vrm,
      config: idleSchedulerConfig,
    });
    idleScheduler.updateConfig(idleSchedulerConfig);
    this.idleScheduler = idleScheduler;
    this.clipRegistry.clear();
    this.animationQueue = [];
    this.vrmaRegistryReady = false;
    try {
      const animationRegistry = await loadVrmaClips(vrm);
      this.clipRegistry = animationRegistry;
    } catch (error) {
      console.warn('[vrm-avatar-renderer] failed to load VRMA registry', error);
    } finally {
      this.vrmaRegistryReady = true;
      if (!isCancelled()) {
        this.playNextQueuedAnimation();
      }
    }
    const clip = createRightArmWaveClip(vrm);
    if (clip) {
      const action = mixer.clipAction(clip);
      action.clampWhenFinished = true;
      action.enabled = false;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      this.waveAction = action;
    } else {
      this.waveAction = null;
    }
    return true;
  }

  /**
   * Drop the current model and everything derived from it (a new model is about to load, or loading
   * failed). The actor stays usable.
   */
  unload(options: AvatarActorUnloadOptions = {}): void {
    this.clearActiveAnimation();
    this.clipRegistry.clear();
    this.animationQueue = [];
    this.vrmaRegistryReady = false;
    if (this.vrm) {
      (options.parent ?? this.parent)?.remove(this.vrm.scene);
    }
    disposeVrm(this.vrm);
    this.vrm = null;
    this.restSkeleton = null;
    options.onDetach?.();
    this.jumpDetector.track(null, null, []);
    this.poseBlend.cancel();
    for (const stopHandedOver of this.handedOver.splice(0)) stopHandedOver();
    if (this.id === DEFAULT_AVATAR_ID) setAvatarRestSkeleton(null);
    try {
      this.mixer?.stopAllAction();
    } catch (error) {
      console.warn('[vrm-avatar-renderer] failed to stop animation mixer during unload', error);
    }
    this.mixer = null;
    this.idleScheduler?.dispose();
    this.idleScheduler = null;
    this.waveAction = null;
    this.expressionManager = null;
    this.visemeState = createDefaultVisemeState();
    this.blinkState = createDefaultBlinkState();
    this.releaseIdleSuspension();
  }

  /**
   * Release everything because the scene is going away. Safe to call repeatedly, and the actor can be
   * loaded again afterwards. Unlike `unload` it does not remove the model from its parent (the scene
   * is being discarded), and it leaves the pose blend and handed-over clips alone, as the component's
   * cleanup did.
   */
  dispose(): void {
    this.clearActiveAnimation();
    this.clipRegistry.clear();
    this.animationQueue = [];
    this.vrmaRegistryReady = false;
    this.releaseIdleSuspension();
    disposeVrm(this.vrm);
    try {
      this.mixer?.stopAllAction();
    } catch (error) {
      console.warn('[vrm-avatar-renderer] failed to stop animation mixer during cleanup', error);
    }
    this.mixer = null;
    this.idleScheduler?.dispose();
    this.idleScheduler = null;
    this.waveAction = null;
    this.expressionManager = null;
    this.vrm = null;
    this.parent = null;
    this.restSkeleton = null;
    if (this.id === DEFAULT_AVATAR_ID) setAvatarRestSkeleton(null);
    this.visemeState = createDefaultVisemeState();
    this.blinkState = createDefaultBlinkState();
  }

  // ---- per-frame -----------------------------------------------------------------------------

  /**
   * Advance the avatar by one frame: viseme/blink smoothing, mixer, expression keyframes from the
   * playing VRMA, idle scheduler, pose blend and the VRM's own update. `now` is a wall-clock
   * millisecond timestamp. Rendering is the scene's job.
   */
  update(deltaSeconds: number, now: number, hooks: AvatarActorUpdateHooks = {}): void {
    this.lastUpdateAt = now;
    const delta = deltaSeconds;
    const manager = this.expressionManager;
    if (manager) {
      const visemeState = this.visemeState;
      const blinkState = this.blinkState;
      const currentFrame = this.frame;
      const preset = mapVisemeToPreset(currentFrame?.index);
      const targetWeight = clamp01(currentFrame?.intensity ?? 0);

      for (const visemePreset of VISEME_PRESETS) {
        const target = visemePreset === preset ? targetWeight : 0;
        const current = visemeState.weights.get(visemePreset) ?? 0;
        const next = smoothWeight(current, target, delta);
        visemeState.weights.set(visemePreset, next);
        manager.setValue(visemePreset, next);
      }

      if (currentFrame?.blink) {
        blinkState.target = 1;
        blinkState.hold = BLINK_HOLD_SECONDS;
      } else if (blinkState.hold > 0) {
        blinkState.hold = Math.max(0, blinkState.hold - delta);
        if (blinkState.hold === 0) {
          blinkState.target = 0;
        }
      }

      blinkState.value = smoothWeight(blinkState.value, blinkState.target, delta, 22, 14);
      if (blinkState.target === 0 && blinkState.value < 0.01) {
        blinkState.value = 0;
      }
      manager.setValue(VRMExpressionPresetName.Blink, blinkState.value);
      manager.update();
    }

    for (const stopHandedOver of this.handedOver.splice(0)) stopHandedOver();
    this.mixer?.update(delta);
    hooks.afterMixer?.();

    // Apply expression keyframes from VRMA metadata at current animation time
    const activeAnimation = this.activeAnimation;
    if (activeAnimation?.vrmaData && this.vrm) {
      const animationTime = activeAnimation.action.time;
      applyExpressionFrameAtTime(this.vrm, activeAnimation.vrmaData, animationTime);
    }

    this.idleScheduler?.update(delta);
    this.poseBlend.apply(delta);
    this.vrm?.update(delta);
  }

  /** Call after the scene has rendered a frame: flags pelvis/hand jumps while in a room. */
  checkJump(roomActive: boolean): void {
    if (roomActive) {
      const playing = this.activeAnimation;
      this.jumpDetector.check(
        playing
          ? {
              clip: playing.action.getClip().name,
              clipTime: Math.round(playing.action.time * 1000) / 1000,
              clipWeight: Math.round(playing.action.getEffectiveWeight() * 1000) / 1000,
            }
          : {},
      );
    } else {
      this.jumpDetector.reset();
    }
  }

  // ---- expression and placement --------------------------------------------------------------

  /** Apply emotion expression weights (VRM preset and custom names) to the face. */
  setEmotion(expressions: VRMPoseExpressions | undefined): void {
    if (!this.vrm) {
      return;
    }
    applyPoseExpressions(this.vrm, expressions);
  }

  /**
   * Stand the avatar at (x, z) in its parent's space, turned `facing` radians about Y from its
   * model-forward direction. Offsets from the position the loader normalised to. Rooms place the
   * body through their own controller instead; this is for scenes that lay avatars out themselves.
   */
  placeAt(x: number, z: number, facing = 0): void {
    const scene = this.vrm?.scene;
    if (!scene) {
      return;
    }
    scene.position.x = this.baseX + x;
    scene.position.z = this.baseZ + z;
    scene.rotation.y = this.baseYaw + facing;
    scene.updateWorldMatrix(true, true);
  }

  // ---- animation -----------------------------------------------------------------------------

  /** True when an animation-bus event addresses this avatar (no id means 'echo'). */
  accepts(event: AvatarAnimationEvent): boolean {
    const target = event.type === 'enqueue' ? event.request.avatarId : event.avatarId;
    return (target ?? DEFAULT_AVATAR_ID) === this.id;
  }

  /** Animation-bus consumer: handles the event if it is addressed to this avatar. Returns whether it did. */
  handleAnimationEvent(event: AvatarAnimationEvent): boolean {
    if (!this.accepts(event)) {
      return false;
    }

    if (event.type === 'response') {
      this.signalResponse();
      return true;
    }

    if (event.type === 'applyPose') {
      this.transitionToPose(event.pose, {
        source: event.source,
        transitionDuration: event.transitionDuration,
        transitionConfig: event.transitionConfig,
      });
      return true;
    }

    this.playClip(event.request);
    return true;
  }

  /** The assistant's reply started: a held pose gives way to the queue. */
  signalResponse(): void {
    if (this.activeAnimation?.intent === 'pose') {
      this.clearActiveAnimation();
      this.playNextQueuedAnimation();
    }
  }

  /** Queue a library clip, or a streamed clip carried on the request as `vrmaBinary`. */
  playClip(request: AvatarAnimationRequest): void {
    const slug = request.slug.trim();
    if (!slug) {
      console.warn('[vrm-avatar-renderer] received animation request without a slug');
      return;
    }

    if (this.activeAnimation?.held && !request.continuation) {
      // Seated: only the clip that continues from the seat (standing up) may replace the pose.
      console.info('[vrm-avatar-renderer] ignoring a clip while the avatar is seated', { slug });
      return;
    }

    if (this.activeAnimation?.intent === 'pose') {
      this.clearActiveAnimation();
    }

    const binary = request.vrmaBinary;
    if (binary) {
      // Parse streamed clips one at a time so chunks are queued in the order they arrived.
      this.streamedClipLoad = this.streamedClipLoad
        .then(async () => {
          const vrm = this.vrm;
          if (!vrm) {
            return;
          }
          const result = await loadVrmaAnimation(binary);
          if (!result) {
            console.warn('[vrm-avatar-renderer] streamed VRMA clip contained no animation', { slug });
            return;
          }
          const clip = createClipFromVrma(vrm, result.animation, slug);
          if (request.source === LIVE_MOTION_SOURCE && !this.hasRoom()) {
            // 2D backdrop: the avatar stays on its spot, so drop the clip's horizontal hips travel.
            pinHipsHorizontal(clip, vrm.humanoid?.getNormalizedBoneNode('hips')?.name);
          }
          this.clipRegistry.set(slug, { clip, vrmaData: result.gltf });
          // A held seated pose gives way here, in the same tick the next clip starts.
          if (this.activeAnimation?.held) this.clearActiveAnimation();
          this.enqueueAnimation({
            slug,
            intent: request.intent,
            source: request.source,
            timing: request.timing,
            ephemeral: true,
            onEnd: request.onEnd,
            continuation: request.continuation,
          });
        })
        .catch((error: unknown) => {
          console.warn('[vrm-avatar-renderer] failed to load streamed VRMA clip', { slug, error });
        });
      return;
    }

    if (this.activeAnimation?.held) this.clearActiveAnimation();
    this.enqueueAnimation({
      slug,
      intent: request.intent,
      source: request.source,
      timing: request.timing,
      onEnd: request.onEnd,
      continuation: request.continuation,
    });
  }

  /** Queue a registered pose clip (a `playClip` with the pose intent). */
  playPose(request: Omit<AvatarAnimationRequest, 'intent'>): void {
    this.playClip({ ...request, intent: 'pose' });
  }

  /** Ease the body from its current bones into `pose` with a generated transition clip. */
  transitionToPose(
    pose: VRMPoseData,
    options: { source?: string; transitionDuration?: number; transitionConfig?: PoseTransitionConfig } = {},
  ): void {
    if (this.activeAnimation?.held) {
      // Seated: a pose would stand the avatar up out of the chair.
      return;
    }
    // Apply pose via animated transition for smooth interpolation
    const vrm = this.vrm;
    const mixer = this.mixer;
    if (!vrm?.humanoid || !mixer) {
      console.warn('[vrm-avatar-renderer] VRM humanoid or mixer not available for pose application');
      return;
    }

    try {
      // Normalize pose to get bone names for capture
      const { bones: targetBones } = poseBonesForVrm(vrm, pose);

      // IMPORTANT: Capture current bone rotations BEFORE clearing the active animation
      // This prevents the bones from snapping back to default when action.stop() is called
      const targetBoneNames = Object.keys(targetBones);
      const capturedPose = captureCurrentPose(vrm, targetBoneNames);

      // Clear any existing pose animation (this may reset bones, but we've captured them)
      if (this.activeAnimation?.intent === 'pose') {
        this.clearActiveAnimation();
      }

      // Create transition clip from captured pose to target pose
      const duration = options.transitionDuration ?? DEFAULT_POSE_TRANSITION_DURATION;
      const transitionResult = createPoseTransitionClip(vrm, pose, duration, capturedPose, options.transitionConfig);

      if (!transitionResult) {
        console.warn('[vrm-avatar-renderer] Could not create pose transition clip');
        return;
      }

      const { clip: transitionClip, expressions: poseExpressions } = transitionResult;

      // Suspend idle animations during transition
      this.suspendIdleAnimations();

      const action = mixer.clipAction(transitionClip);

      const handleFinished = (finishedEvent: { action?: THREE.AnimationAction | null }) => {
        if (finishedEvent.action !== action) {
          return;
        }

        mixer.removeEventListener('finished', handleFinished);

        // Keep the pose clamped at the end
        action.clampWhenFinished = true;
        action.enabled = true;
        action.setEffectiveTimeScale(0);
        this.activeAnimation = {
          action,
          intent: 'pose',
          onFinish: handleFinished,
        };

        // Apply facial expressions when transition completes
        if (poseExpressions && vrm.expressionManager) {
          applyPoseExpressions(vrm, poseExpressions);
          console.info('[vrm-avatar-renderer] Applied pose expressions:', JSON.stringify({
            presets: poseExpressions.presets ? Object.keys(poseExpressions.presets) : [],
          }));
        }

        // Resume idle animations (breathing, micro-movements) on top of the pose
        // This allows the static pose to still have natural breathing applied
        this.releaseIdleSuspension();

        console.info('[vrm-avatar-renderer] Pose transition completed:', JSON.stringify({
          source: options.source,
        }));
      };

      this.activeAnimation = {
        action,
        intent: 'pose',
        onFinish: handleFinished,
      };

      // Play the transition animation
      action.reset();
      action.enabled = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      action.clampWhenFinished = true;
      mixer.addEventListener('finished', handleFinished);
      action.play();

      console.info('[vrm-avatar-renderer] Started smooth pose transition:', JSON.stringify({
        source: options.source,
        boneCount: targetBoneNames.length,
        duration,
        hasExpressions: !!poseExpressions,
      }));
    } catch (error) {
      console.error('[vrm-avatar-renderer] Failed to apply pose transition', error);
      this.releaseIdleSuspension();
    }
  }

  /** Cancel whatever is playing or queued and let idle motion resume (the stage changed). */
  cancelAnimations(): void {
    this.clearActiveAnimation();
    this.animationQueue = [];
    this.releaseIdleSuspension();
  }

  /**
   * Reload the VRMA clip library for the current model (the library changed). Returns a function that
   * abandons the reload if it has not finished.
   */
  reloadClipRegistry(): () => void {
    const vrm = this.vrm;
    if (!vrm) {
      return () => {};
    }

    let cancelled = false;
    void (async () => {
      this.vrmaRegistryReady = false;
      try {
        const animationRegistry = await loadVrmaClips(vrm);
        if (cancelled) {
          return;
        }
        this.clipRegistry = animationRegistry;
      } catch (error) {
        console.warn('[vrm-avatar-renderer] failed to reload VRMA registry', error);
      } finally {
        if (!cancelled) {
          this.vrmaRegistryReady = true;
          this.playNextQueuedAnimation();
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }

  /** The greeting wave (a behaviour cue). Returns false when the model has no wave clip. */
  playWave(): boolean {
    const mixer = this.mixer;
    const action = this.waveAction;
    if (!mixer || !action) {
      return false;
    }

    const idleScheduler = this.idleScheduler;
    const releaseIdle = idleScheduler?.suspend(5) ?? null;

    const handleFinished = (event: { action?: THREE.AnimationAction | null }) => {
      if (event.action !== action) {
        return;
      }
      mixer.removeEventListener('finished', handleFinished);
      releaseIdle?.();
      try {
        action.stop();
      } catch (stopError) {
        console.warn('[vrm-avatar-renderer] failed to stop wave animation after completion', stopError);
      }
    };

    try {
      action.reset();
      action.enabled = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      action.clampWhenFinished = true;
      if (typeof action.fadeIn === 'function') {
        action.fadeIn(0.2);
      }
      mixer.addEventListener('finished', handleFinished);
      action.play();
      if (typeof action.fadeOut === 'function') {
        action.fadeOut(0.25);
      }
      return true;
    } catch (error) {
      mixer.removeEventListener('finished', handleFinished);
      releaseIdle?.();
      console.error('[vrm-avatar-renderer] failed to play wave animation', error);
      return false;
    }
  }

  // ---- queue internals -----------------------------------------------------------------------

  private releaseIdleSuspension(): void {
    if (this.animationSuspension) {
      this.animationSuspension();
      this.animationSuspension = null;
    }
  }

  private suspendIdleAnimations(): void {
    if (this.animationSuspension) {
      return;
    }
    const scheduler = this.idleScheduler;
    this.animationSuspension = scheduler?.suspend(8) ?? null;
  }

  private clearActiveAnimation(): void {
    const active = this.activeAnimation;
    if (!active) {
      return;
    }

    const mixer = this.mixer;
    if (mixer) {
      mixer.removeEventListener('finished', active.onFinish);
    }

    try {
      active.action.stop();
      active.dispose?.();
    } catch (error) {
      console.warn('[vrm-avatar-renderer] failed to stop animation action', error);
    }

    this.activeAnimation = null;
    if (this.animationQueue.length === 0) {
      this.releaseIdleSuspension();
    }
  }

  private enqueueAnimation(request: QueuedAnimation): void {
    if (request.intent === 'pose' && this.activeAnimation?.intent === 'pose') {
      this.clearActiveAnimation();
    }

    this.animationQueue.push(request);
    this.playNextQueuedAnimation();
  }

  private playNextQueuedAnimation(continuation = false): void {
    if (this.activeAnimation) {
      return;
    }

    const mixer = this.mixer;
    if (!mixer) {
      return;
    }

    if (!this.vrmaRegistryReady) {
      return;
    }

    const next = this.animationQueue.shift();
    if (!next) {
      this.releaseIdleSuspension();
      return;
    }

    const clipData = this.clipRegistry.get(next.slug);
    if (!clipData) {
      console.warn('[vrm-avatar-renderer] requested animation clip is unavailable', { slug: next.slug });
      this.playNextQueuedAnimation();
      return;
    }

    this.suspendIdleAnimations();

    const action = mixer.clipAction(clipData.clip);
    if (next.timing?.onStart) {
      const startAt = next.timing.startAt ?? Date.now();
      next.timing.onStart(startAt);
    }
    const handleFinished = (event: { action?: THREE.AnimationAction | null }) => {
      if (event.action !== action) {
        return;
      }

      mixer.removeEventListener('finished', handleFinished);

      if (next.intent === 'pose') {
        action.clampWhenFinished = true;
        action.enabled = true;
        action.setEffectiveTimeScale(0);
        this.activeAnimation = {
          action,
          intent: 'pose',
          onFinish: handleFinished,
          vrmaData: clipData.vrmaData,
        };
        return;
      }

      let verdict = next.onEnd?.();
      if (verdict === 'hold' && this.animationQueue.length === 0) {
        // A seated pose: keep the last frame, and keep idle motion off, until the next clip replaces it.
        action.clampWhenFinished = true;
        action.enabled = true;
        action.setEffectiveTimeScale(0);
        this.clipRegistry.delete(next.slug);
        this.activeAnimation = {
          action,
          intent: 'play',
          onFinish: handleFinished,
          vrmaData: clipData.vrmaData,
          held: true,
          dispose: () => mixer.uncacheClip(clipData.clip),
        };
        return;
      }
      if (verdict === 'hold') verdict = undefined;

      const finish = () => {
        try {
          action.stop();
        } catch (error) {
          console.warn('[vrm-avatar-renderer] failed to stop animation after completion', error);
        }
        if (next.ephemeral) {
          this.clipRegistry.delete(next.slug);
          mixer.uncacheClip(clipData.clip);
        }
      };

      this.activeAnimation = null;
      if (this.animationQueue.length > 0) {
        // The next clip (e.g. the following streamed chunk) starts where this one ended: hand over instantly.
        // This clip is stopped only before the next mixer update: stopped now, the next clip may not be
        // sampled until then, and for one frame the bones would drop back to their rest pose.
        this.handedOver.push(finish);
        this.playNextQueuedAnimation(true);
        return;
      }

      if (verdict === 'release') {
        // The root has been moved to where the motion ended: hand over to the idle pose in the same frame,
        // easing the limbs out of the motion's last frame. The hips are left out: their heading now
        // lives in the root.
        const vrm = this.vrm;
        if (vrm?.humanoid) {
          this.poseBlend.capture(
            VRMHumanBoneList.filter((bone) => bone !== 'hips').map((bone) => vrm.humanoid.getNormalizedBoneNode(bone)),
            MOTION_RELEASE_BLEND_SECONDS,
          );
        }
        finish();
        this.playNextQueuedAnimation();
        return;
      }

      // Nothing queued: hold the final frame and fade it out while idle animations resume, instead of
      // snapping straight back to the rest pose.
      if (typeof action.fadeOut === 'function') {
        action.fadeOut(CLIP_FADE_OUT_SECONDS);
        setTimeout(() => {
          if (this.activeAnimation?.action !== action) {
            finish();
          }
        }, CLIP_FADE_OUT_SECONDS * 1000);
      } else {
        finish();
      }
      this.playNextQueuedAnimation();
    };

    this.activeAnimation = {
      action,
      intent: next.intent,
      onFinish: handleFinished,
      vrmaData: clipData.vrmaData,
    };

    try {
      action.reset();
      action.enabled = true;
      action.setLoop(THREE.LoopOnce, 1);
      action.setEffectiveWeight(1);
      action.setEffectiveTimeScale(1);
      action.clampWhenFinished = true;
      if (!continuation && !next.continuation && typeof action.fadeIn === 'function') {
        // Blend in from the idle pose; continuation clips already start on the previous clip's last frame.
        action.fadeIn(CLIP_FADE_IN_SECONDS);
      }
      mixer.addEventListener('finished', handleFinished);
      action.play();
    } catch (error) {
      mixer.removeEventListener('finished', handleFinished);
      this.activeAnimation = null;
      console.error('[vrm-avatar-renderer] failed to play animation clip', error);
      this.playNextQueuedAnimation();
    }
  }
}
