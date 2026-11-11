import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaderState = vi.hoisted(() => ({
  createVrm: (() => {
    throw new Error('mock VRM factory not initialized');
  }) as () => unknown,
  vrmaAnimations: [] as unknown[],
}));

type MockAction = Record<string, ReturnType<typeof vi.fn>> & { enabled: boolean; clampWhenFinished: boolean };

const threeMockState = vi.hoisted(() => ({
  mixers: [] as Array<{
    actions: MockAction[];
    emitFinished: (action: MockAction) => void;
    update: ReturnType<typeof vi.fn>;
    stopAllAction: ReturnType<typeof vi.fn>;
  }>,
}));

function createMockAction(): MockAction {
  return {
    reset: vi.fn().mockReturnThis(),
    play: vi.fn().mockReturnThis(),
    stop: vi.fn().mockReturnThis(),
    setLoop: vi.fn().mockReturnThis(),
    setEffectiveWeight: vi.fn().mockReturnThis(),
    setEffectiveTimeScale: vi.fn().mockReturnThis(),
    fadeIn: vi.fn().mockReturnThis(),
    fadeOut: vi.fn().mockReturnThis(),
    enabled: false,
    clampWhenFinished: false,
  } as unknown as MockAction;
}

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class MockMixer {
    public readonly clipAction = vi.fn(() => {
      const action = createMockAction();
      this.actions.push(action);
      return action;
    });
    public readonly stopAllAction = vi.fn();
    public readonly update = vi.fn();
    public readonly uncacheClip = vi.fn();
    public readonly addEventListener = vi.fn((event: string, listener: (payload: { action: MockAction }) => void) => {
      if (event === 'finished') this.finishListeners.add(listener);
    });
    public readonly removeEventListener = vi.fn((event: string, listener: (payload: { action: MockAction }) => void) => {
      if (event === 'finished') this.finishListeners.delete(listener);
    });
    public readonly actions: MockAction[] = [];
    private readonly finishListeners = new Set<(payload: { action: MockAction }) => void>();

    constructor(public readonly root: unknown) {
      threeMockState.mixers.push(this);
    }

    emitFinished(action: MockAction) {
      for (const listener of this.finishListeners) listener({ action });
    }
  }

  return { ...actual, AnimationMixer: MockMixer };
});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    register() {
      return this;
    }

    async parseAsync(binary: ArrayBuffer) {
      if (binary.byteLength === 4) {
        return { userData: { vrmAnimations: loaderState.vrmaAnimations } };
      }
      return { userData: { vrm: loaderState.createVrm() } };
    }
  },
}));

vi.mock('@pixiv/three-vrm', async () => {
  const actual = await vi.importActual<typeof import('@pixiv/three-vrm')>('@pixiv/three-vrm');
  return {
    ...actual,
    VRMLoaderPlugin: class {},
    VRMUtils: {
      removeUnnecessaryVertices: vi.fn(),
      removeUnnecessaryJoints: vi.fn(),
      rotateVRM0: vi.fn(),
      deepDispose: vi.fn(),
    },
  };
});

vi.mock('@pixiv/three-vrm-animation', async () => {
  const actual = await vi.importActual<typeof import('@pixiv/three-vrm-animation')>('@pixiv/three-vrm-animation');
  return { ...actual, VRMAnimationLoaderPlugin: class {} };
});

vi.mock('../../src/avatar/animations/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/avatar/animations/index.js')>(
    '../../src/avatar/animations/index.js',
  );
  const { AnimationClip } = await vi.importActual<typeof import('three')>('three');
  return {
    ...actual,
    createClipFromVrma: vi.fn((_vrm: unknown, _animation: unknown, name?: string) => new AnimationClip(name ?? 'clip', 1, [])),
  };
});

import { VRMExpressionPresetName, type VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { AvatarActor, DEFAULT_AVATAR_ID } from '../../src/avatar/avatar-actor.js';
import { createAvatarAnimationBus, type AvatarAnimationEvent } from '../../src/avatar/animation-bus.js';
import { getAvatarRestSkeleton } from '../../src/avatar/rest-skeleton.js';
import { toAnimationSlug } from '../../src/avatar/animation-tags.js';

function createVrm() {
  const expressionManager = {
    resetValues: vi.fn(),
    setValue: vi.fn(),
    update: vi.fn(),
    getExpressionTrackName: vi.fn((name: string) => name),
  };
  const vrm = {
    scene: new THREE.Object3D(),
    humanoid: {
      setNormalizedPose: vi.fn(),
      getNormalizedBoneNode: () => null,
      normalizedRestPose: { hips: { position: [0, 1, 0] as [number, number, number] } },
    },
    expressionManager,
    meta: { metaVersion: '1' },
    update: vi.fn(),
  };
  return { vrm: vrm as unknown as VRM, expressionManager };
}

describe('AvatarActor', () => {
  let created: ReturnType<typeof createVrm>;

  beforeEach(() => {
    created = createVrm();
    loaderState.createVrm = () => created.vrm;
    loaderState.vrmaAnimations = [{ name: 'mock' }];
    threeMockState.mixers.length = 0;
    (window as unknown as { aiembodied?: unknown }).aiembodied = {
      avatar: {
        listAnimations: vi.fn().mockResolvedValue([
          { id: 'anim-1', name: 'First', createdAt: 0, fileSha: 'a', duration: null, fps: null },
          { id: 'anim-2', name: 'Second', createdAt: 0, fileSha: 'b', duration: null, fps: null },
        ]),
        loadAnimationBinary: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      },
    };
  });

  afterEach(() => {
    delete (window as unknown as { aiembodied?: unknown }).aiembodied;
  });

  async function loadActor(actor = new AvatarActor()) {
    const parent = new THREE.Object3D();
    const loaded = await actor.load({ binary: new ArrayBuffer(8), modelId: 'vrm-1', parent });
    expect(loaded).toBe(true);
    return { actor, parent };
  }

  it('defaults to the echo id and exposes nothing before a model loads', () => {
    const actor = new AvatarActor();
    expect(actor.id).toBe(DEFAULT_AVATAR_ID);
    expect(DEFAULT_AVATAR_ID).toBe('echo');
    expect(new AvatarActor({ id: 'sage' }).id).toBe('sage');
    expect(actor.getObject3D()).toBeNull();
    expect(actor.getVrm()).toBeNull();
    expect(actor.getRestSkeleton()).toBeNull();
    expect(actor.playWave()).toBe(false);
  });

  it('adds the model to its parent on load and removes it on unload', async () => {
    const { actor, parent } = await loadActor();
    expect(actor.getObject3D()).toBe(created.vrm.scene);
    expect(parent.children).toContain(created.vrm.scene);
    expect(threeMockState.mixers).toHaveLength(1);

    const onDetach = vi.fn();
    actor.unload({ parent, onDetach });
    expect(onDetach).toHaveBeenCalledTimes(1);
    expect(parent.children).not.toContain(created.vrm.scene);
    expect(actor.getObject3D()).toBeNull();
    expect(actor.getRestSkeleton()).toBeNull();
    expect(getAvatarRestSkeleton()).toBeNull();
  });

  it('reports a cancelled load without adding the model', async () => {
    const actor = new AvatarActor();
    const parent = new THREE.Object3D();
    const loaded = await actor.load({
      binary: new ArrayBuffer(8),
      modelId: 'vrm-1',
      parent,
      isCancelled: () => true,
    });
    expect(loaded).toBe(false);
    expect(parent.children).toHaveLength(0);
    expect(actor.getObject3D()).toBeNull();
  });

  it('smooths viseme frames into expression weights and blinks', async () => {
    const { actor } = await loadActor();
    actor.setVisemeFrame({ t: 0, index: 0, intensity: 1 });
    actor.update(1 / 60, 1000);

    const aa = actor.getVisemeWeight(VRMExpressionPresetName.Aa);
    expect(aa).toBeGreaterThan(0);
    expect(aa).toBeLessThan(1);
    expect(created.expressionManager.setValue).toHaveBeenCalledWith(VRMExpressionPresetName.Aa, aa);
    expect(created.expressionManager.setValue).toHaveBeenCalledWith(VRMExpressionPresetName.Ih, 0);
    expect(created.expressionManager.update).toHaveBeenCalled();
    expect(created.vrm.update).toHaveBeenCalled();
    expect(actor.getLastUpdateAt()).toBe(1000);

    actor.update(1 / 60, 1016);
    expect(actor.getVisemeWeight(VRMExpressionPresetName.Aa)).toBeGreaterThan(aa);

    actor.setVisemeFrame({ t: 0, index: 99, intensity: 0, blink: true });
    actor.update(1 / 60, 1032);
    expect(actor.getBlinkValue()).toBeGreaterThan(0);
    // The old viseme releases once the frame no longer targets it.
    expect(actor.getVisemeWeight(VRMExpressionPresetName.Aa)).toBeLessThan(
      1,
    );
  });

  it('runs the afterMixer hook between the mixer update and the VRM update', async () => {
    const { actor } = await loadActor();
    const order: string[] = [];
    threeMockState.mixers[0].update.mockImplementation(() => order.push('mixer'));
    (created.vrm.update as ReturnType<typeof vi.fn>).mockImplementation(() => order.push('vrm'));
    actor.update(1 / 60, 0, { afterMixer: () => order.push('hook') });
    expect(order).toEqual(['mixer', 'hook', 'vrm']);
  });

  it('applies emotion expressions and clears them with a zero weight', async () => {
    const { actor } = await loadActor();
    vi.spyOn(console, 'info').mockImplementation(() => {});
    actor.setEmotion({ presets: { happy: 0.8 } });
    expect(created.expressionManager.setValue).toHaveBeenCalledWith('happy', 0.8);
    actor.setEmotion({ presets: { happy: 0 } });
    expect(created.expressionManager.setValue).toHaveBeenLastCalledWith('happy', 0);
  });

  it('places the model relative to its normalised position', async () => {
    const { actor } = await loadActor();
    const scene = created.vrm.scene;
    const baseX = scene.position.x;
    actor.placeAt(0.5, -0.25, 1);
    expect(scene.position.x).toBeCloseTo(baseX + 0.5);
    expect(scene.position.z).toBeCloseTo(-0.25);
    expect(scene.rotation.y).toBeCloseTo(1);
  });

  describe('animation bus routing', () => {
    const first = toAnimationSlug('First');

    async function playedActions(actor: AvatarActor, event: AvatarAnimationEvent) {
      const mixer = threeMockState.mixers.at(-1)!;
      const before = mixer.actions.length;
      const consumed = actor.handleAnimationEvent(event);
      return { consumed, started: mixer.actions.length - before };
    }

    it('consumes events without an avatar id as echo, and ignores others', async () => {
      const { actor } = await loadActor();
      const plain = await playedActions(actor, { type: 'enqueue', request: { slug: first, intent: 'play' } });
      expect(plain).toEqual({ consumed: true, started: 1 });

      const { actor: sage } = await loadActor(new AvatarActor({ id: 'sage' }));
      const forEcho = await playedActions(sage, { type: 'enqueue', request: { slug: first, intent: 'play' } });
      expect(forEcho).toEqual({ consumed: false, started: 0 });
      expect(sage.getQueuedAnimationCount()).toBe(0);
    });

    it('routes by the avatarId carried on requests, pose events and responses', async () => {
      const echo = new AvatarActor();
      const sage = new AvatarActor({ id: 'sage' });
      const explicitSage: AvatarAnimationEvent = {
        type: 'enqueue',
        request: { slug: first, intent: 'play', avatarId: 'sage' },
      };
      expect(echo.accepts(explicitSage)).toBe(false);
      expect(sage.accepts(explicitSage)).toBe(true);
      expect(echo.accepts({ type: 'enqueue', request: { slug: first, intent: 'play', avatarId: 'echo' } })).toBe(true);
      expect(sage.accepts({ type: 'applyPose', pose: {}, avatarId: 'sage' })).toBe(true);
      expect(echo.accepts({ type: 'applyPose', pose: {}, avatarId: 'sage' })).toBe(false);
      expect(echo.accepts({ type: 'response' })).toBe(true);
      expect(sage.accepts({ type: 'response' })).toBe(false);
      expect(sage.accepts({ type: 'response', avatarId: 'sage' })).toBe(true);
    });

    it('carries avatar ids through the bus', () => {
      const bus = createAvatarAnimationBus();
      const events: AvatarAnimationEvent[] = [];
      bus.subscribe((event) => events.push(event));
      bus.enqueue({ slug: 'a', intent: 'play', avatarId: 'sage' });
      bus.applyPose({}, 'test', undefined, undefined, 'sage');
      bus.applyPose({});
      bus.signalResponse('sage');
      bus.signalResponse();
      expect(events[0]).toEqual({ type: 'enqueue', request: { slug: 'a', intent: 'play', avatarId: 'sage' } });
      expect(events[1]).toMatchObject({ type: 'applyPose', avatarId: 'sage' });
      expect(events[2]).not.toHaveProperty('avatarId');
      expect(events[3]).toEqual({ type: 'response', avatarId: 'sage' });
      expect(events[4]).toEqual({ type: 'response' });
    });

    it('plays queued clips one after another', async () => {
      const { actor } = await loadActor();
      const mixer = threeMockState.mixers[0];
      const initial = mixer.actions.length;
      actor.playClip({ slug: first, intent: 'play' });
      actor.playClip({ slug: toAnimationSlug('Second'), intent: 'play' });
      expect(mixer.actions.length).toBe(initial + 1);
      expect(actor.getQueuedAnimationCount()).toBe(1);
      expect(actor.isIdleSuspended()).toBe(true);

      mixer.emitFinished(mixer.actions.at(-1)!);
      expect(mixer.actions.length).toBe(initial + 2);
    });

    it('cancelAnimations drops the queue and releases the idle suspension', async () => {
      const { actor } = await loadActor();
      actor.playClip({ slug: first, intent: 'play' });
      actor.playClip({ slug: toAnimationSlug('Second'), intent: 'play' });
      actor.cancelAnimations();
      expect(actor.getQueuedAnimationCount()).toBe(0);
      expect(actor.isIdleSuspended()).toBe(false);
    });
  });

  it('dispose is idempotent and leaves the actor reusable', async () => {
    const { actor } = await loadActor();
    expect(() => {
      actor.dispose();
      actor.dispose();
    }).not.toThrow();
    expect(threeMockState.mixers[0].stopAllAction).toHaveBeenCalledTimes(1);
    expect(actor.getObject3D()).toBeNull();
    expect(actor.getRestSkeleton()).toBeNull();
    expect(actor.playWave()).toBe(false);
    // No model: updating is a no-op rather than an error.
    expect(() => actor.update(1 / 60, 0)).not.toThrow();

    created = createVrm();
    const reloaded = await actor.load({ binary: new ArrayBuffer(8), modelId: 'vrm-1', parent: new THREE.Object3D() });
    expect(reloaded).toBe(true);
    expect(actor.getObject3D()).toBe(created.vrm.scene);
    actor.dispose();
  });

  it('unload is safe before any model and when repeated', () => {
    const actor = new AvatarActor();
    expect(() => {
      actor.unload();
      actor.unload();
    }).not.toThrow();
  });
});
