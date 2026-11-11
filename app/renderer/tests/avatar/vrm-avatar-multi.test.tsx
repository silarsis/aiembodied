import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  vrms: [] as Array<{ scene: { position: { x: number } }; setValue: ReturnType<typeof vi.fn> }>,
  frameCallbacks: [] as Array<() => void>,
}));

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three');
  class MockWebGLRenderer {
    constructor(public readonly options: unknown) {}
    setClearColor() {}
    setPixelRatio() {}
    setSize = vi.fn();
    render() {}
    dispose() {}
  }
  class MockTimer {
    connect = vi.fn();
    update = vi.fn();
    dispose = vi.fn();
    getDelta = vi.fn(() => 1 / 60);
  }
  class MockAnimationMixer {
    clipAction = vi.fn(() => ({
      reset: vi.fn().mockReturnThis(),
      play: vi.fn().mockReturnThis(),
      stop: vi.fn().mockReturnThis(),
      setLoop: vi.fn().mockReturnThis(),
      setEffectiveWeight: vi.fn().mockReturnThis(),
      setEffectiveTimeScale: vi.fn().mockReturnThis(),
      fadeIn: vi.fn().mockReturnThis(),
      fadeOut: vi.fn().mockReturnThis(),
    }));
    stopAllAction = vi.fn();
    update = vi.fn();
    addEventListener = vi.fn();
    removeEventListener = vi.fn();
    constructor(public readonly root: unknown) {}
  }
  return { ...actual, WebGLRenderer: MockWebGLRenderer, Timer: MockTimer, AnimationMixer: MockAnimationMixer };
});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
  GLTFLoader: class {
    register() {
      return this;
    }
    async parseAsync() {
      return { userData: { vrm: createVrm() } };
    }
  },
}));

vi.mock('@pixiv/three-vrm', async () => {
  const actual = await vi.importActual<typeof import('@pixiv/three-vrm')>('@pixiv/three-vrm');
  return {
    ...actual,
    VRMLoaderPlugin: class {},
    VRMUtils: { removeUnnecessaryVertices: vi.fn(), removeUnnecessaryJoints: vi.fn(), rotateVRM0: vi.fn() },
  };
});

const roomState = vi.hoisted(() => ({ active: false }));
vi.mock('../../src/rooms/room-scene-controller.js', () => ({
  RoomSceneController: class {
    get active() {
      return roomState.active;
    }
    sceneEnv = {};
    envFor = vi.fn(() => null);
    attachAvatar = vi.fn();
    attachCompanion = vi.fn();
    detachCompanion = vi.fn();
    dispose = vi.fn();
    setRoom = vi.fn(async () => undefined);
    setAvatarHeight = vi.fn();
    setDebugNavmesh = vi.fn();
    remember2dCamera = vi.fn();
    step = vi.fn();
  },
}));

import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { VrmAvatarRenderer, layoutOffsets } from '../../src/avatar/vrm-avatar-renderer.js';
import type { AvatarModelSummary } from '../../src/avatar/types.js';
import type { RoomFile } from '../../../main/src/rooms/types.js';

function createVrm(): VRM {
  const scene = new THREE.Object3D();
  scene.add(new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.6, 0.3)));
  const setValue = vi.fn();
  state.vrms.push({ scene: scene as unknown as { position: { x: number } }, setValue });
  return {
    scene,
    humanoid: {
      setNormalizedPose: vi.fn(),
      getNormalizedBoneNode: () => null,
      normalizedRestPose: { hips: { position: [0, 1, 0] as [number, number, number] } },
    },
    expressionManager: { resetValues: vi.fn(), setValue, update: vi.fn(), getExpressionTrackName: vi.fn((name: string) => name) },
    meta: { metaVersion: '1' },
    update: vi.fn(),
  } as unknown as VRM;
}

const models = new Map<string, AvatarModelSummary>();
/** Stable per id, like the model objects App keeps in state. */
const model = (id: string): AvatarModelSummary => {
  if (!models.has(id)) {
    models.set(id, { id, name: id, createdAt: 1, version: '1.0', fileSha: id, thumbnailDataUrl: null, description: null });
  }
  return models.get(id) as AvatarModelSummary;
};

describe('layoutOffsets', () => {
  it('leaves one avatar where it is and centres several symmetrically', () => {
    expect(layoutOffsets([0.6])).toEqual([0]);
    const two = layoutOffsets([0.6, 0.6]);
    expect(two[0]).toBeCloseTo(-(two[1] as number));
    expect(two[1]).toBeGreaterThan(0.3);
    const three = layoutOffsets([0.5, 0.8, 0.5]);
    expect(three[1]).toBeCloseTo(0);
    expect(three[0]).toBeCloseTo(-(three[2] as number));
  });
});

describe('VrmAvatarRenderer with several avatars', () => {
  const saved: Record<string, unknown> = {};
  let loadModelBinary: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    state.vrms.length = 0;
    state.frameCallbacks.length = 0;
    roomState.active = false;
    saved.getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({})) as unknown as typeof HTMLCanvasElement.prototype.getContext;
    saved.raf = window.requestAnimationFrame;
    window.requestAnimationFrame = vi.fn((callback: FrameRequestCallback) => {
      state.frameCallbacks.push(() => callback(0));
      return state.frameCallbacks.length;
    });
    saved.caf = window.cancelAnimationFrame;
    window.cancelAnimationFrame = vi.fn();
    loadModelBinary = vi.fn().mockResolvedValue(new ArrayBuffer(0));
    (window as unknown as { aiembodied?: unknown }).aiembodied = {
      camera: { onDetection: () => () => undefined, emitDetection: vi.fn() },
      avatar: { loadModelBinary },
    };
  });

  afterEach(() => {
    HTMLCanvasElement.prototype.getContext = saved.getContext as typeof HTMLCanvasElement.prototype.getContext;
    window.requestAnimationFrame = saved.raf as typeof window.requestAnimationFrame;
    window.cancelAnimationFrame = saved.caf as typeof window.cancelAnimationFrame;
    delete (window as unknown as { aiembodied?: unknown }).aiembodied;
  });

  it('keeps one avatar exactly as before when no avatars prop is given', async () => {
    render(<VrmAvatarRenderer frame={null} model={model('m1')} />);
    await waitFor(() => expect(state.vrms).toHaveLength(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(loadModelBinary).toHaveBeenCalledTimes(1);
    expect(loadModelBinary).toHaveBeenCalledWith('m1');
    expect(state.vrms).toHaveLength(1);
    expect(state.vrms[0]?.scene.position.x).toBe(0);
    expect(document.querySelector('.stageAvatarLabels')).toBeNull();
  });

  it('loads one actor per entry, side by side, each with its own frame and a name label', async () => {
    const frame = (intensity: number) => ({ t: 0, index: 0, intensity });
    const entries = (echoIntensity: number, sageIntensity: number) => [
      { id: 'echo', name: 'Echo', model: model('m1'), frame: frame(echoIntensity) },
      { id: 'sage', name: 'Sage', model: model('m1'), frame: frame(sageIntensity) },
    ];
    const { container, rerender } = render(<VrmAvatarRenderer frame={null} model={model('m1')} avatars={entries(0.9, 0)} />);
    await waitFor(() => expect(state.vrms).toHaveLength(2));
    await waitFor(() => {
      const [a, b] = state.vrms;
      expect(a?.scene.position.x).toBeLessThan(0);
      expect(b?.scene.position.x).toBeGreaterThan(0);
    });
    const [echoVrm, sageVrm] = state.vrms;
    expect(echoVrm?.scene.position.x).toBeCloseTo(-(sageVrm?.scene.position.x ?? 0));
    // A shared body is loaded once per actor.
    expect(loadModelBinary).toHaveBeenCalledTimes(2);

    // Run frames: each actor's mouth follows its own frame.
    for (let i = 0; i < 10; i += 1) state.frameCallbacks.splice(0).forEach((run) => run());
    const mouth = (vrm?: { setValue: ReturnType<typeof vi.fn> }) =>
      Math.max(0, ...(vrm?.setValue.mock.calls ?? []).filter(([name]) => name === 'aa').map(([, value]) => Number(value)));
    expect(mouth(echoVrm)).toBeGreaterThan(0.1);
    expect(mouth(sageVrm)).toBe(0);

    const labels = [...container.querySelectorAll('.stageAvatarLabel')];
    expect(labels.map((label) => label.textContent)).toEqual(['Echo', 'Sage']);
    expect(labels.map((label) => label.getAttribute('data-speaking'))).toEqual(['true', 'false']);

    rerender(<VrmAvatarRenderer frame={null} model={model('m1')} avatars={entries(0, 0.9)} />);
    expect([...container.querySelectorAll('.stageAvatarLabel')].map((label) => label.getAttribute('data-speaking'))).toEqual(['false', 'true']);
    // Frames changing does not reload anybody.
    expect(loadModelBinary).toHaveBeenCalledTimes(2);
  });

  it('loads an avatar that wears its own model', async () => {
    render(
      <VrmAvatarRenderer
        frame={null}
        model={model('m1')}
        avatars={[
          { id: 'echo', model: model('m1'), frame: null },
          { id: 'rex', model: model('m2'), frame: null },
        ]}
      />,
    );
    await waitFor(() => expect(loadModelBinary).toHaveBeenCalledTimes(2));
    expect(loadModelBinary.mock.calls.map(([id]) => id).sort()).toEqual(['m1', 'm2']);
  });

  it('loads the other avatars in a 3D room and hands them to the room as companions', async () => {
    const room = { id: 'room-1' } as unknown as RoomFile;
    const { container } = render(
      <VrmAvatarRenderer
        frame={null}
        model={model('m1')}
        room={room}
        avatars={[
          { id: 'echo', name: 'Echo', model: model('m1'), frame: null },
          { id: 'sage', name: 'Sage', model: model('m1'), frame: null },
        ]}
      />,
    );
    await waitFor(() => expect(state.vrms).toHaveLength(2));
    expect(loadModelBinary).toHaveBeenCalledTimes(2);
    expect(container.querySelector('.stageAvatarLabels')).toBeNull();
  });
});
