import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaderState = vi.hoisted(() => ({
  createVrm: (() => {
    throw new Error('mock VRM factory not initialized');
  }) as () => unknown,
  vrmaAnimations: [] as unknown[],
}));

type MockAnimationAction = {
  reset: ReturnType<typeof vi.fn>;
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setLoop: ReturnType<typeof vi.fn>;
  setEffectiveWeight: ReturnType<typeof vi.fn>;
  setEffectiveTimeScale: ReturnType<typeof vi.fn>;
  fadeIn: ReturnType<typeof vi.fn>;
  fadeOut: ReturnType<typeof vi.fn>;
  enabled: boolean;
  clampWhenFinished: boolean;
};

type MockAnimationMixer = {
  clipAction: ReturnType<typeof vi.fn>;
  stopAllAction: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  emitFinished: (action: MockAnimationAction) => void;
  actions: MockAnimationAction[];
};

const threeMockState = vi.hoisted(() => ({
  mixers: [] as MockAnimationMixer[],
}));

function createMockAction(): MockAnimationAction {
  const action = {
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
  } as unknown as MockAnimationAction;
  return action;
}

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');

  class MockWebGLRenderer {
    constructor(public readonly options: unknown) {}
    setClearColor() {}
    setPixelRatio() {}
    setSize() {}
    render() {}
    dispose() {}
  }

  class MockClock {
    getDelta = vi.fn(() => 1 / 60);
  }

  class MockMixer implements MockAnimationMixer {
    public readonly clipAction = vi.fn(() => {
      const action = createMockAction();
      this.actions.push(action);
      return action;
    });
    public readonly stopAllAction = vi.fn();
    public readonly update = vi.fn();
    public readonly addEventListener = vi.fn((event: string, listener: (payload: { action: MockAnimationAction }) => void) => {
      if (event === 'finished') {
        this.finishListeners.add(listener);
      }
    });
    public readonly removeEventListener = vi.fn((event: string, listener: (payload: { action: MockAnimationAction }) => void) => {
      if (event === 'finished') {
        this.finishListeners.delete(listener);
      }
    });
    public readonly actions: MockAnimationAction[] = [];
    private readonly finishListeners = new Set<(payload: { action: MockAnimationAction }) => void>();

    constructor(public readonly root: unknown) {
      threeMockState.mixers.push(this);
    }

    emitFinished(action: MockAnimationAction) {
      for (const listener of this.finishListeners) {
        listener({ action });
      }
    }
  }

  threeMockState.mixers.length = 0;

  return {
    ...actual,
    WebGLRenderer: MockWebGLRenderer,
    Clock: MockClock,
    AnimationMixer: MockMixer,
  };
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
    },
  };
});

vi.mock('@pixiv/three-vrm-animation', async () => {
  const actual = await vi.importActual<typeof import('@pixiv/three-vrm-animation')>('@pixiv/three-vrm-animation');
  return {
    ...actual,
    VRMAnimationLoaderPlugin: class {},
  };
});

vi.mock('../../src/avatar/animations/index.js', async () => {
  const actual = await vi.importActual<typeof import('../../src/avatar/animations/index.js')>(
    '../../src/avatar/animations/index.js',
  );
  const { AnimationClip } = await vi.importActual<typeof import('three')>('three');
  return {
    ...actual,
    createClipFromVrma: vi.fn((_vrm: unknown, _animation: unknown, name?: string) => {
      const clipName = name ?? 'clip';
      return new AnimationClip(clipName, 1, []);
    }),
  };
});

import type { VRM } from '@pixiv/three-vrm';
import { useEffect } from 'react';
import * as THREE from 'three';
import {
  AnimationBusProvider,
  useAvatarAnimationBus,
  type AvatarAnimationRequest,
} from '../../src/avatar/animation-bus.js';
import { VrmAvatarRenderer } from '../../src/avatar/vrm-avatar-renderer.js';
import { toAnimationSlug } from '../../src/avatar/animation-tags.js';
import type { AvatarModelSummary } from '../../src/avatar/types.js';

function BusCapture({
  onReady,
}: {
  onReady: (bus: { enqueue: (request: AvatarAnimationRequest) => void } | null) => void;
}) {
  const bus = useAvatarAnimationBus() as {
    enqueue: (request: AvatarAnimationRequest) => void;
  } | null;
  useEffect(() => {
    onReady(bus);
  }, [bus, onReady]);
  return null;
}

describe('VrmAvatarRenderer animation queue', () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalGetBoundingClientRect: typeof HTMLCanvasElement.prototype.getBoundingClientRect;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  const defaultLoader = loaderState.createVrm;
  const model: AvatarModelSummary = {
    id: 'vrm-1',
    name: 'Test',
    createdAt: Date.now(),
    version: '1.0',
    fileSha: 'abc',
    thumbnailDataUrl: null,
  };

  beforeEach(() => {
    loaderState.createVrm = () => {
      const scene = new THREE.Object3D();
      return {
        scene,
        humanoid: {
          getNormalizedBoneNode: () => null,
          normalizedRestPose: {
            hips: { position: [0, 1, 0] as [number, number, number] },
          },
        },
        expressionManager: {
          resetValues: vi.fn(),
          setValue: vi.fn(),
          update: vi.fn(),
          getExpressionTrackName: vi.fn((name: string) => name),
        },
        meta: { metaVersion: '1' },
        update: vi.fn(),
      } as unknown as VRM;
    };

    loaderState.vrmaAnimations = [{ name: 'mock' }];

    originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi
      .fn(() => ({} as CanvasRenderingContext2D))
      .mockName('getContextStub') as unknown as typeof HTMLCanvasElement.prototype.getContext;
    originalGetBoundingClientRect = HTMLCanvasElement.prototype.getBoundingClientRect;
    HTMLCanvasElement.prototype.getBoundingClientRect = () => new DOMRect(0, 0, 320, 240);
    originalRequestAnimationFrame = window.requestAnimationFrame;
    window.requestAnimationFrame = vi.fn(() => 1);
    originalCancelAnimationFrame = window.cancelAnimationFrame;
    window.cancelAnimationFrame = vi.fn();
    originalResizeObserver = window.ResizeObserver;
    window.ResizeObserver = class {
      observe() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;

    (window as unknown as { aiembodied?: unknown }).aiembodied = {
      avatar: {
        loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(8)),
        listAnimations: vi.fn().mockResolvedValue([
          {
            id: 'anim-1',
            name: 'First',
            createdAt: Date.now(),
            fileSha: 'sha',
            duration: null,
            fps: null,
          },
          {
            id: 'anim-2',
            name: 'Second',
            createdAt: Date.now(),
            fileSha: 'sha',
            duration: null,
            fps: null,
          },
        ]),
        loadAnimationBinary: vi.fn().mockResolvedValue(new ArrayBuffer(4)),
      },
    };
  });

  afterEach(() => {
    loaderState.createVrm = defaultLoader;
    HTMLCanvasElement.prototype.getContext = originalGetContext;
    HTMLCanvasElement.prototype.getBoundingClientRect = originalGetBoundingClientRect;
    window.requestAnimationFrame = originalRequestAnimationFrame;
    window.cancelAnimationFrame = originalCancelAnimationFrame;
    if (originalResizeObserver) {
      window.ResizeObserver = originalResizeObserver;
    } else {
      Reflect.deleteProperty(window as unknown as Record<string, unknown>, 'ResizeObserver');
    }
    delete (window as unknown as { aiembodied?: unknown }).aiembodied;
    threeMockState.mixers.length = 0;
  });

  it('queues animations sequentially', async () => {
    let busRef: { enqueue: (request: AvatarAnimationRequest) => void } | null = null;
    render(
      <AnimationBusProvider>
        <BusCapture onReady={(bus) => (busRef = bus)} />
        <VrmAvatarRenderer frame={null} model={model} />
      </AnimationBusProvider>,
    );

    await waitFor(() => {
      expect(threeMockState.mixers.length).toBeGreaterThan(0);
    });

    const mixer = threeMockState.mixers[0];
    const initialActions = mixer.actions.length;
    const firstSlug = toAnimationSlug('First');
    const secondSlug = toAnimationSlug('Second');
    const bus = busRef as unknown as { enqueue: (request: AvatarAnimationRequest) => void } | null;
    bus?.enqueue({ slug: firstSlug, intent: 'play' });
    bus?.enqueue({ slug: secondSlug, intent: 'play' });

    await waitFor(() => {
      expect(mixer.actions.length).toBe(initialActions + 1);
    });

    const firstAction = mixer.actions.at(-1);
    if (!firstAction) {
      throw new Error('Expected animation action to be created.');
    }
    mixer.emitFinished(firstAction);

    await waitFor(() => {
      expect(mixer.actions.length).toBe(initialActions + 2);
    });
  });

  it('invokes timing callbacks when starting playback', async () => {
    let busRef: { enqueue: (request: AvatarAnimationRequest) => void } | null = null;
    render(
      <AnimationBusProvider>
        <BusCapture onReady={(bus) => (busRef = bus)} />
        <VrmAvatarRenderer frame={null} model={model} />
      </AnimationBusProvider>,
    );

    await waitFor(() => {
      expect(threeMockState.mixers.length).toBeGreaterThan(0);
    });

    const mixer = threeMockState.mixers[0];
    const initialActions = mixer.actions.length;
    const onStart = vi.fn();
    const slug = toAnimationSlug('First');
    const bus = busRef as unknown as { enqueue: (request: AvatarAnimationRequest) => void } | null;
    bus?.enqueue({ slug, intent: 'play', timing: { startAt: 1234, onStart } });

    await waitFor(() => {
      expect(mixer.actions.length).toBe(initialActions + 1);
    });

    expect(onStart).toHaveBeenCalledWith(1234);
  });

  it('holds pose animations on the final frame', async () => {
    let busRef: { enqueue: (request: AvatarAnimationRequest) => void } | null = null;
    render(
      <AnimationBusProvider>
        <BusCapture onReady={(bus) => (busRef = bus)} />
        <VrmAvatarRenderer frame={null} model={model} />
      </AnimationBusProvider>,
    );

    await waitFor(() => {
      expect(threeMockState.mixers.length).toBeGreaterThan(0);
    });

    const mixer = threeMockState.mixers[0];
    const initialActions = mixer.actions.length;
    const poseSlug = toAnimationSlug('First');
    const bus = busRef as unknown as { enqueue: (request: AvatarAnimationRequest) => void } | null;
    bus?.enqueue({ slug: poseSlug, intent: 'pose' });

    await waitFor(() => {
      expect(mixer.actions.length).toBe(initialActions + 1);
    });

    const action = mixer.actions.at(-1);
    if (!action) {
      throw new Error('Expected pose animation action to be created.');
    }
    mixer.emitFinished(action);

    expect(action.setEffectiveTimeScale).toHaveBeenCalledWith(0);
    expect(action.stop).not.toHaveBeenCalled();
  });

  it('looks up clips by slug name', async () => {
    let busRef: { enqueue: (request: AvatarAnimationRequest) => void } | null = null;
    const avatarBridge = (window as unknown as { aiembodied?: { avatar?: { listAnimations?: ReturnType<typeof vi.fn> } } })
      .aiembodied?.avatar;
    if (avatarBridge?.listAnimations) {
      avatarBridge.listAnimations.mockResolvedValueOnce([
        {
          id: 'anim-3',
          name: 'Happy Wave',
          createdAt: Date.now(),
          fileSha: 'sha',
          duration: null,
          fps: null,
        },
      ]);
    }

    render(
      <AnimationBusProvider>
        <BusCapture onReady={(bus) => (busRef = bus)} />
        <VrmAvatarRenderer frame={null} model={model} />
      </AnimationBusProvider>,
    );

    await waitFor(() => {
      expect(threeMockState.mixers.length).toBeGreaterThan(0);
    });

    const mixer = threeMockState.mixers[0];
    const initialActions = mixer.actions.length;
    const slug = toAnimationSlug('Happy Wave');
    const bus = busRef as unknown as { enqueue: (request: AvatarAnimationRequest) => void } | null;
    bus?.enqueue({ slug, intent: 'play' });

    await waitFor(() => {
      expect(mixer.actions.length).toBe(initialActions + 1);
    });

    const clipArg = mixer.clipAction.mock.calls.at(-1)?.[0];
    expect(clipArg?.name).toBe('Happy Wave');
  });
});
