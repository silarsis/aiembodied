import * as THREE from 'three';
import { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';

import {
  VrmHumanoidBoneName,
  createExpressionTrack,
  createHumanoidRotationTrack,
  createVrmAnimationClip,
} from './index.js';

const DEFAULT_FADE_IN = 0.35;
const DEFAULT_FADE_OUT = 0.3;

export interface IdleClipRegistration {
  name: string;
  clip: THREE.AnimationClip;
  weight?: number;
  priority?: number;
  loop?: THREE.AnimationActionLoopStyles;
}

export interface IdleAnimationSchedulerConfig {
  enableBreathing?: boolean;
  enableMicroMovement?: boolean;
  enableBlink?: boolean;
  additionalClips?: IdleClipRegistration[];
}

interface IdleClipHandle {
  name: string;
  action: THREE.AnimationAction;
  priority: number;
  weight: number;
  loop: THREE.AnimationActionLoopStyles;
  enabled: boolean;
  playing: boolean;
  fadeIn: number;
  fadeOut: number;
  mode: 'loop' | 'trigger';
}

interface BlinkState {
  cooldown: number;
  minInterval: number;
  maxInterval: number;
  playing: boolean;
  handle: IdleClipHandle | null;
}

export interface IdleSchedulerOptions {
  breathingWeight?: number;
  headMovementWeight?: number;
  blinkWeight?: number;
  blinkInterval?: [number, number];
}

const DEFAULT_CONFIG: Required<IdleAnimationSchedulerConfig> = {
  enableBreathing: true,
  enableMicroMovement: true,
  enableBlink: true,
  additionalClips: [],
};

export class IdleAnimationScheduler {
  private readonly mixer: THREE.AnimationMixer;
  private readonly vrm: VRM;
  private readonly clips = new Map<string, IdleClipHandle>();
  private readonly suspensions = new Map<number, number>();
  private readonly options: Required<IdleSchedulerOptions>;
  private blink: BlinkState;
  private disposed = false;
  private tokenCounter = 0;

  constructor(
    params: {
      mixer: THREE.AnimationMixer;
      vrm: VRM;
      config?: IdleAnimationSchedulerConfig;
      options?: IdleSchedulerOptions;
    },
  ) {
    const {
      mixer,
      vrm,
      config = DEFAULT_CONFIG,
      options = {},
    } = params;

    this.mixer = mixer;
    this.vrm = vrm;

    const interval = options.blinkInterval ?? [2.8, 5.6];
    this.options = {
      breathingWeight: options.breathingWeight ?? 0.5,
      headMovementWeight: options.headMovementWeight ?? 0.25,
      blinkWeight: options.blinkWeight ?? 0.85,
      blinkInterval: interval,
    };

    this.blink = {
      cooldown: this.randomBlinkCooldown(interval[0], interval[1]) * 0.5,
      minInterval: interval[0],
      maxInterval: interval[1],
      playing: false,
      handle: null,
    };

    this.registerCoreClips();
    this.updateConfig(config);
  }

  public updateConfig(config: IdleAnimationSchedulerConfig): void {
    if (this.disposed) {
      return;
    }

    const merged = {
      ...DEFAULT_CONFIG,
      ...config,
      additionalClips: config.additionalClips ?? [],
    } satisfies Required<IdleAnimationSchedulerConfig>;

    this.setClipEnabled('breathing', merged.enableBreathing);
    this.setClipEnabled('micro_head', merged.enableMicroMovement);
    this.setClipEnabled('blink', merged.enableBlink);

    const registered = new Set<string>(['breathing', 'micro_head', 'blink']);

    for (const clip of merged.additionalClips) {
      const handle = this.ensureClip(clip);
      if (handle) {
        registered.add(handle.name);
      }
    }

    for (const [name, handle] of this.clips) {
      if (!registered.has(name)) {
        this.stopClip(handle);
        this.clips.delete(name);
      }
    }

    this.applySuspensionState();
  }

  public update(deltaSeconds: number): void {
    if (this.disposed || !Number.isFinite(deltaSeconds)) {
      return;
    }

    this.tickBlink(deltaSeconds);
  }

  public suspend(priority = 1): () => void {
    if (this.disposed) {
      return () => undefined;
    }

    const token = ++this.tokenCounter;
    this.suspensions.set(token, priority);
    this.applySuspensionState();
    return () => {
      if (!this.disposed) {
        this.suspensions.delete(token);
        this.applySuspensionState();
      }
    };
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }

    this.disposed = true;
    this.mixer.removeEventListener('finished', this.handleMixerFinished);

    for (const handle of this.clips.values()) {
      this.stopClip(handle);
    }

    this.clips.clear();
    this.suspensions.clear();
  }

  private registerCoreClips(): void {
    const breathing = this.createBreathingClip();
    if (breathing) {
      this.clips.set('breathing', breathing);
    }

    const microHead = this.createMicroHeadClip();
    if (microHead) {
      this.clips.set('micro_head', microHead);
    }

    const blink = this.createBlinkClip();
    if (blink) {
      this.clips.set('blink', blink);
      this.blink.handle = blink;
      this.mixer.addEventListener('finished', this.handleMixerFinished);
    }
  }

  private ensureClip(clip: IdleClipRegistration): IdleClipHandle | null {
    if (this.disposed) {
      return null;
    }

    const existing = this.clips.get(clip.name);
    if (existing) {
      existing.action.stop();
      existing.action = this.mixer.clipAction(clip.clip);
      existing.action.enabled = false;
      existing.playing = false;
      existing.weight = clip.weight ?? existing.weight;
      existing.priority = clip.priority ?? existing.priority;
      existing.loop = clip.loop ?? existing.loop;
      this.applySuspensionState();
      return existing;
    }

    const action = this.mixer.clipAction(clip.clip);
    action.enabled = false;

    const handle: IdleClipHandle = {
      name: clip.name,
      action,
      priority: clip.priority ?? 0,
      weight: clip.weight ?? 1,
      loop: clip.loop ?? THREE.LoopRepeat,
      enabled: true,
      playing: false,
      fadeIn: DEFAULT_FADE_IN,
      fadeOut: DEFAULT_FADE_OUT,
      mode: 'loop',
    };

    this.clips.set(handle.name, handle);
    return handle;
  }

  private createBreathingClip(): IdleClipHandle | null {
    const clip = createVrmAnimationClip(this.vrm, {
      name: 'idle_breath',
      rotations: [
        {
          bone: 'spine' as VrmHumanoidBoneName,
          track: createHumanoidRotationTrack(this.vrm, 'spine' as VrmHumanoidBoneName, [
            { time: 0, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-0.5), 0, 0) },
            { time: 1.5, rotation: new THREE.Euler(THREE.MathUtils.degToRad(1.2), 0, 0) },
            { time: 3, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-0.5), 0, 0) },
          ]),
        },
        {
          bone: 'chest' as VrmHumanoidBoneName,
          track: createHumanoidRotationTrack(this.vrm, 'chest' as VrmHumanoidBoneName, [
            { time: 0, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-0.25), 0, 0) },
            { time: 1.5, rotation: new THREE.Euler(THREE.MathUtils.degToRad(1.0), 0, 0) },
            { time: 3, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-0.25), 0, 0) },
          ]),
        },
        {
          bone: 'upperChest' as VrmHumanoidBoneName,
          track: createHumanoidRotationTrack(this.vrm, 'upperChest' as VrmHumanoidBoneName, [
            { time: 0, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-0.1), 0, 0) },
            { time: 1.5, rotation: new THREE.Euler(THREE.MathUtils.degToRad(0.6), THREE.MathUtils.degToRad(0.3), 0) },
            { time: 3, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-0.1), 0, 0) },
          ]),
        },
      ],
      duration: 3,
    });

    if (!clip) {
      return null;
    }

    const action = this.mixer.clipAction(clip);
    action.enabled = false;

    return {
      name: 'breathing',
      action,
      priority: -1,
      weight: this.options.breathingWeight,
      loop: THREE.LoopRepeat,
      enabled: true,
      playing: false,
      fadeIn: DEFAULT_FADE_IN,
      fadeOut: DEFAULT_FADE_OUT,
      mode: 'loop',
    };
  }

  private createMicroHeadClip(): IdleClipHandle | null {
    const clip = createVrmAnimationClip(this.vrm, {
      name: 'idle_micro_head',
      rotations: [
        {
          bone: 'neck' as VrmHumanoidBoneName,
          track: createHumanoidRotationTrack(this.vrm, 'neck' as VrmHumanoidBoneName, [
            { time: 0, rotation: new THREE.Euler(0, THREE.MathUtils.degToRad(-1.8), 0) },
            { time: 2.4, rotation: new THREE.Euler(THREE.MathUtils.degToRad(0.8), THREE.MathUtils.degToRad(1.8), 0) },
            { time: 4.8, rotation: new THREE.Euler(0, THREE.MathUtils.degToRad(-1.8), 0) },
          ]),
        },
        {
          bone: 'head' as VrmHumanoidBoneName,
          track: createHumanoidRotationTrack(this.vrm, 'head' as VrmHumanoidBoneName, [
            { time: 0, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-2.2), THREE.MathUtils.degToRad(-1.2), 0) },
            { time: 2.4, rotation: new THREE.Euler(THREE.MathUtils.degToRad(2.4), THREE.MathUtils.degToRad(1.5), 0) },
            { time: 4.8, rotation: new THREE.Euler(THREE.MathUtils.degToRad(-2.2), THREE.MathUtils.degToRad(-1.2), 0) },
          ]),
        },
      ],
      duration: 4.8,
    });

    if (!clip) {
      return null;
    }

    const action = this.mixer.clipAction(clip);
    action.enabled = false;

    return {
      name: 'micro_head',
      action,
      priority: 0,
      weight: this.options.headMovementWeight,
      loop: THREE.LoopRepeat,
      enabled: true,
      playing: false,
      fadeIn: DEFAULT_FADE_IN,
      fadeOut: DEFAULT_FADE_OUT,
      mode: 'loop',
    };
  }

  private createBlinkClip(): IdleClipHandle | null {
    const blinkTrack = createExpressionTrack(
      VRMExpressionPresetName.Blink,
      [0, 0.05, 0.12, 0.18],
      [0, 1, 1, 0],
    );

    const clip = createVrmAnimationClip(this.vrm, {
      name: 'idle_blink',
      expressions: [blinkTrack],
      duration: 0.18,
    });

    if (!clip) {
      return null;
    }

    const action = this.mixer.clipAction(clip);
    action.enabled = false;
    action.clampWhenFinished = true;

    return {
      name: 'blink',
      action,
      priority: 1,
      weight: this.options.blinkWeight,
      loop: THREE.LoopOnce,
      enabled: true,
      playing: false,
      fadeIn: 0.08,
      fadeOut: 0.1,
      mode: 'trigger',
    };
  }

  private setClipEnabled(name: string, enabled: boolean): void {
    const handle = this.clips.get(name);
    if (!handle) {
      return;
    }

    handle.enabled = enabled;

    if (!enabled) {
      this.stopClip(handle);
    } else if (!this.isSuspended(handle.priority)) {
      this.startClip(handle);
    }
  }

  private startClip(handle: IdleClipHandle): void {
    if (this.disposed) {
      return;
    }

    if (!handle.enabled || handle.playing) {
      return;
    }

    if (handle.mode === 'loop') {
      handle.action.reset();
      handle.action.enabled = true;
      handle.action.setLoop(handle.loop, Infinity);
      handle.action.setEffectiveWeight(handle.weight);
      handle.action.setEffectiveTimeScale(1);
      if (typeof handle.action.fadeIn === 'function') {
        handle.action.fadeIn(handle.fadeIn);
      }
      handle.action.play();
      handle.playing = true;
    }
  }

  private stopClip(handle: IdleClipHandle): void {
    if (!handle.playing && !handle.action.enabled) {
      handle.action.stop();
      return;
    }

    if (typeof handle.action.fadeOut === 'function' && handle.mode === 'loop') {
      handle.action.fadeOut(handle.fadeOut);
    }
    handle.action.stop();
    handle.action.enabled = false;
    handle.playing = false;
  }

  private applySuspensionState(): void {
    for (const handle of this.clips.values()) {
      if (!handle.enabled) {
        continue;
      }

      if (this.isSuspended(handle.priority)) {
        if (handle.mode === 'loop') {
          this.stopClip(handle);
        } else if (handle.mode === 'trigger' && handle.playing) {
          this.stopClip(handle);
          this.blink.playing = false;
        }
      } else if (handle.mode === 'loop') {
        this.startClip(handle);
      }
    }
  }

  private isSuspended(priority: number): boolean {
    if (this.suspensions.size === 0) {
      return false;
    }

    let maxPriority = -Infinity;
    for (const value of this.suspensions.values()) {
      maxPriority = Math.max(maxPriority, value);
    }

    return maxPriority >= priority;
  }

  private tickBlink(deltaSeconds: number): void {
    const handle = this.blink.handle;
    if (!handle || !handle.enabled || this.isSuspended(handle.priority)) {
      return;
    }

    if (this.blink.playing) {
      return;
    }

    this.blink.cooldown -= deltaSeconds;

    if (this.blink.cooldown > 0) {
      return;
    }

    handle.action.reset();
    handle.action.enabled = true;
    handle.action.setLoop(THREE.LoopOnce, 1);
    handle.action.setEffectiveWeight(handle.weight);
    handle.action.clampWhenFinished = true;
    if (typeof handle.action.fadeIn === 'function') {
      handle.action.fadeIn(handle.fadeIn);
    }
    handle.action.play();
    this.blink.playing = true;
    this.blink.cooldown = this.randomBlinkCooldown(
      this.blink.minInterval,
      this.blink.maxInterval,
    );
  }

  private handleMixerFinished = (event: { action?: THREE.AnimationAction | null }): void => {
    if (!event.action || this.disposed) {
      return;
    }

    const handle = this.blink.handle;
    if (!handle || event.action !== handle.action) {
      return;
    }

    this.stopClip(handle);
    this.blink.playing = false;
  };

  private randomBlinkCooldown(min: number, max: number): number {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max <= 0) {
      return 3.2;
    }
    const lower = Math.min(min, max);
    const upper = Math.max(min, max);
    return lower + Math.random() * (upper - lower);
  }
}
