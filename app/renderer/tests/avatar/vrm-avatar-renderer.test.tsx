import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const loaderState = vi.hoisted(() => ({
  createVrm: (() => {
    throw new Error('mock VRM factory not initialized');
  }) as () => unknown,
}));

const threeMockState = vi.hoisted(() => ({ mixers: [] as Array<{ actions: MockAnimationAction[] }> }));

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
    constructor(public readonly options: unknown) { }
    setClearColor() { }
    setPixelRatio() { }
    setSize() { }
    render() { }
    dispose() { }
  }

  class MockTimer {
    connect = vi.fn();
    update = vi.fn();
    dispose = vi.fn();
    getDelta = vi.fn(() => 1 / 60);
  }

  class MockAnimationMixer {
    public readonly clipAction = vi.fn((clip: unknown) => {
      const action = createMockAction();
      this.actions.push(action);
      return action;
    });
    public readonly stopAllAction = vi.fn();
    public readonly update = vi.fn();
    public readonly addEventListener = vi.fn();
    public readonly removeEventListener = vi.fn();
    public readonly actions: MockAnimationAction[] = [];

    constructor(public readonly root: unknown) {
      threeMockState.mixers.push(this);
    }
  }

  threeMockState.mixers.length = 0;

  return {
    ...actual,
    WebGLRenderer: MockWebGLRenderer,
    Timer: MockTimer,
    AnimationMixer: MockAnimationMixer,
  };
});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    register() {
      return this;
    }

    async parseAsync() {
      return { userData: { vrm: loaderState.createVrm() } };
    }
  },
}));

vi.mock('@pixiv/three-vrm', async () => {
  const actual = await vi.importActual<typeof import('@pixiv/three-vrm')>('@pixiv/three-vrm');
  return {
    ...actual,
    VRMLoaderPlugin: class { },
    VRMUtils: {
      removeUnnecessaryVertices: vi.fn(),
      removeUnnecessaryJoints: vi.fn(),
      rotateVRM0: vi.fn(),
    },
  };
});

import { VRMExpressionPresetName, type VRM } from '@pixiv/three-vrm';
import * as THREE from 'three';
import { BehaviorCueProvider } from '../../src/avatar/behavior-cues.js';
import {
  VrmAvatarRenderer,
  clamp01,
  mapVisemeToPreset,
  smoothWeight,
  createRightArmWaveClip,
  suppressOutlierMeshes,
  applyBaseNeutralPose,
  applyPoseExpressions,
  renderedFootFraction,
    poseBonesForVrm,
} from '../../src/avatar/vrm-avatar-renderer.js';

describe('base pose coordinate conventions', () => {
  it('converts tagged legacy stances for VRM 1 without modifying the original pose or other avatars', () => {
    const pose = { sourceVrmVersion: '0' as const, bones: { leftUpperArm: { rotation: [0.1, 0.2, 0.3, 0.9] } } };
    const v1 = { meta: { metaVersion: '1' } } as unknown as import('@pixiv/three-vrm').VRM;
    const v0 = { meta: { metaVersion: '0' } } as unknown as import('@pixiv/three-vrm').VRM;
    expect(poseBonesForVrm(v1, pose).bones.leftUpperArm.rotation).toEqual([-0.1, 0.2, -0.3, 0.9]);
    expect(poseBonesForVrm(v0, pose).bones.leftUpperArm.rotation).toEqual([0.1, 0.2, 0.3, 0.9]);
    expect(poseBonesForVrm(v1, { bones: pose.bones }).bones.leftUpperArm.rotation).toEqual([0.1, 0.2, 0.3, 0.9]);
    expect(pose.bones.leftUpperArm.rotation).toEqual([0.1, 0.2, 0.3, 0.9]);
  });
});


import type { AvatarModelSummary } from '../../src/avatar/types.js';

describe('mapVisemeToPreset', () => {
  it('maps discrete indices to blend shape presets', () => {
    expect(mapVisemeToPreset(0)).toBe(VRMExpressionPresetName.Aa);
    expect(mapVisemeToPreset(4)).toBe(VRMExpressionPresetName.Oh);
  });

  it('returns null for unknown indices', () => {
    expect(mapVisemeToPreset(-1)).toBeNull();
    expect(mapVisemeToPreset(99)).toBeNull();
    expect(mapVisemeToPreset(undefined)).toBeNull();
  });
});

describe('clamp01', () => {
  it('forces values into the 0..1 range', () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(0.2)).toBe(0.2);
    expect(clamp01(12)).toBe(1);
    expect(clamp01(Number.NaN)).toBe(0);
  });
});

describe('smoothWeight', () => {
  it('smoothly approaches the target intensity', () => {
    const rising = smoothWeight(0, 1, 0.2, 10, 5);
    expect(rising).toBeGreaterThan(0);
    expect(rising).toBeLessThanOrEqual(1);

    const falling = smoothWeight(1, 0, 0.2, 10, 5);
    expect(falling).toBeLessThan(1);
    expect(falling).toBeGreaterThanOrEqual(0);
  });

  it('returns the current value when time does not progress', () => {
    expect(smoothWeight(0.4, 1, 0, 10, 5)).toBeCloseTo(0.4, 5);
  });
});

describe('createRightArmWaveClip', () => {
  it('returns null when humanoid mapping is missing', () => {
    const vrm = {
      scene: new THREE.Object3D(),
      humanoid: null,
    } as unknown as VRM;
    expect(createRightArmWaveClip(vrm)).toBeNull();
  });
});

describe('suppressOutlierMeshes', () => {
  it('uses world-space bounds when hiding oversized meshes', () => {
    const root = new THREE.Object3D();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(1000, 1000, 1000));
    root.add(mesh);
    root.scale.setScalar(0.01);
    root.updateWorldMatrix(true, true);

    const hidden = suppressOutlierMeshes(root, 50);

    expect(hidden).toBe(0);
    expect(mesh.visible).toBe(true);
  });

  it('hides meshes that exceed the max world-space size', () => {
    const root = new THREE.Object3D();
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(200, 200, 200));
    root.add(mesh);
    root.updateWorldMatrix(true, true);

    const hidden = suppressOutlierMeshes(root, 50);

    expect(hidden).toBe(1);
    expect(mesh.visible).toBe(false);
  });
});

describe('VrmAvatarRenderer behavior cues', () => {
  let originalGetContext: typeof HTMLCanvasElement.prototype.getContext;
  let originalGetBoundingClientRect: typeof HTMLCanvasElement.prototype.getBoundingClientRect;
  let originalRequestAnimationFrame: typeof window.requestAnimationFrame;
  let originalCancelAnimationFrame: typeof window.cancelAnimationFrame;
  let originalResizeObserver: typeof ResizeObserver | undefined;
  let cameraListener: ((event: { cue: string; timestamp?: number }) => void) | undefined;
  const defaultLoader = loaderState.createVrm;

  beforeEach(() => {
    loaderState.createVrm = () => {
      const upperArm = new THREE.Object3D();
      upperArm.name = 'upperArm';
      const lowerArm = new THREE.Object3D();
      lowerArm.name = 'lowerArm';
      const hand = new THREE.Object3D();
      hand.name = 'hand';
      const scene = new THREE.Object3D();
      return {
        scene,
        humanoid: {
          setNormalizedPose: vi.fn(),
          getNormalizedBoneNode: (bone: string) => {
            if (bone === 'rightUpperArm') {
              return upperArm;
            }
            if (bone === 'rightLowerArm') {
              return lowerArm;
            }
            if (bone === 'rightHand') {
              return hand;
            }
            return null;
          },
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
      observe() { }
      disconnect() { }
    } as unknown as typeof ResizeObserver;

    (window as unknown as { aiembodied?: unknown }).aiembodied = {
      camera: {
        onDetection: (listener: (event: { cue: string; timestamp?: number }) => void) => {
          cameraListener = listener;
          return () => {
            cameraListener = undefined;
          };
        },
        emitDetection: vi.fn(),
      },
      avatar: {
        loadModelBinary: vi.fn().mockResolvedValue(new ArrayBuffer(0)),
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

  it('plays a wave animation when a greet_face cue is emitted', async () => {
    const model: AvatarModelSummary = {
      id: 'vrm-1',
      name: 'Test',
      createdAt: Date.now(),
      version: '1.0',
      fileSha: 'abc',
      thumbnailDataUrl: null,
      description: null,
    };

    render(
      <BehaviorCueProvider>
        <VrmAvatarRenderer frame={null} model={model} />
      </BehaviorCueProvider>,
    );

    await waitFor(() => {
      expect(threeMockState.mixers.length).toBeGreaterThan(0);
      expect(threeMockState.mixers[0]?.actions.length).toBeGreaterThan(0);
      expect(typeof cameraListener).toBe('function');
    });

    cameraListener?.({ cue: 'greet_face', timestamp: Date.now() });

    const mixer = threeMockState.mixers[0];
    const action = mixer?.actions.at(-1);
    expect(action?.reset).toHaveBeenCalled();
    expect(action?.play).toHaveBeenCalled();
  });
});




describe('approved base poses', () => {
  it('anchors to solid rendered shoe pixels while ignoring stray antialiasing pixels', () => {
    const renderer = { getContext: () => ({
      drawingBufferWidth: 8, drawingBufferHeight: 8, RGBA: 1, UNSIGNED_BYTE: 2,
      readPixels: (_x: number, _y: number, _w: number, _h: number, _format: number, _type: number, pixels: Uint8Array) => {
        pixels[3] = 255;
        for (const column of [2, 3, 4]) pixels[(2 * 8 + column) * 4 + 3] = 255;
      },
    }) } as unknown as THREE.WebGLRenderer;
    expect(renderedFootFraction(renderer)).toBe(1 - 2.5 / 8);
  });

  it('starts with the calibrated neutral and resets the previous emotional expression', () => {
    const setNormalizedPose = vi.fn();
    const setValue = vi.fn();
    const vrm = { humanoid: { setNormalizedPose }, expressionManager: {
      expressions: ['happy', 'sad', 'angry', 'relaxed', 'Surprised'].map((expressionName) => ({ expressionName })), setValue,
    }} as unknown as import('@pixiv/three-vrm').VRM;
    applyBaseNeutralPose(vrm);
    expect(setNormalizedPose).toHaveBeenCalledOnce();
    expect(setNormalizedPose.mock.calls[0][0]).toHaveProperty('leftShoulder.rotation');
    expect(setValue).toHaveBeenCalledWith('happy', 0);
    expect(setValue).toHaveBeenCalledWith('relaxed', 0.16);
    expect(setValue).toHaveBeenCalledWith('Surprised', 0);
    applyPoseExpressions(vrm, { presets: { surprised: 0.75 } });
    expect(setValue).toHaveBeenLastCalledWith('Surprised', 0.75);
  });
});
