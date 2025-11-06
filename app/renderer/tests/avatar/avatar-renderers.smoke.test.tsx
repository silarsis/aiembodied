import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarRenderer } from '../../src/avatar/avatar-renderer.js';
import { VrmAvatarRenderer } from '../../src/avatar/vrm-avatar-renderer.js';
import { IdleAnimationScheduler } from '../../src/avatar/animations/idle-scheduler.js';

vi.mock('three', () => {
  const noop = () => {};

  class Euler {
    constructor(public x = 0, public y = 0, public z = 0) {}
  }

  class Quaternion {
    constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

    clone(): Quaternion {
      return new Quaternion(this.x, this.y, this.z, this.w);
    }

    setFromEuler(euler: Euler): Quaternion {
      this.x = euler.x;
      this.y = euler.y;
      this.z = euler.z;
      this.w = 1;
      return this;
    }

    multiply(quaternion: Quaternion): Quaternion {
      this.x += quaternion.x;
      this.y += quaternion.y;
      this.z += quaternion.z;
      this.w += quaternion.w - 1;
      return this;
    }
  }

  class NumberKeyframeTrack {
    constructor(public name: string, public times: number[], public values: number[]) {}

    clone(): NumberKeyframeTrack {
      return new NumberKeyframeTrack(this.name, [...this.times], [...this.values]);
    }
  }

  class QuaternionKeyframeTrack extends NumberKeyframeTrack {}

  class AnimationClip {
    constructor(public name: string, public duration: number, public tracks: unknown[]) {}

    clone(): AnimationClip {
      return new AnimationClip(this.name, this.duration, [...this.tracks]);
    }
  }

  const MathUtils = {
    degToRad: (degrees: number) => (degrees * Math.PI) / 180,
  } as const;

  const LoopRepeat = 'loop-repeat';
  const LoopOnce = 'loop-once';

  class MockScene {
    children: MockScene[] = [];
    position = { set: noop };
    rotation = { y: 0 };
    quaternion = new Quaternion();
    frustumCulled = false;

    add(child: MockScene) {
      this.children.push(child);
    }

    remove(child: MockScene) {
      this.children = this.children.filter((item) => item !== child);
    }

    traverse(callback: (node: MockScene) => void) {
      callback(this);
      for (const child of this.children) {
        child.traverse(callback);
      }
    }
  }

  class Object3D extends MockScene {}
  class Scene extends Object3D {}
  class PerspectiveCamera extends Object3D {
    aspect = 1;
    lookAt = noop;
    updateProjectionMatrix = noop;
  }
  class AmbientLight extends Object3D {}
  class DirectionalLight extends Object3D {
    position = { set: noop };
  }
  class Clock {
    getDelta() {
      return 1 / 60;
    }
  }
  class WebGLRenderer {
    domElement: unknown;
    constructor(options: { canvas?: HTMLCanvasElement } = {}) {
      this.domElement = options.canvas ?? {};
    }
    setClearColor = noop;
    setPixelRatio = noop;
    setSize = noop;
    render = noop;
    dispose = noop;
    getContext() {
      return { canvas: this.domElement };
    }
  }
  class AnimationMixer {
    actions: Array<{ clip: AnimationClip; play: () => unknown; stop: () => unknown }> = [];
    listeners = new Map<string, Set<(event: unknown) => void>>();

    constructor(public readonly root?: unknown) {}

    clipAction(clip: AnimationClip) {
      const action: any = {
        clip,
        clampWhenFinished: false,
        enabled: false,
        setLoop: () => action,
        setEffectiveWeight: () => action,
        setEffectiveTimeScale: () => action,
        reset: () => action,
        play: () => action,
        stop: () => action,
        fadeIn: () => action,
        fadeOut: () => action,
      };
      this.actions.push(action);
      return action;
    }

    addEventListener(type: string, handler: (event: unknown) => void) {
      if (!this.listeners.has(type)) {
        this.listeners.set(type, new Set());
      }
      this.listeners.get(type)?.add(handler);
    }

    removeEventListener(type: string, handler: (event: unknown) => void) {
      this.listeners.get(type)?.delete(handler);
    }

    stopAllAction = noop;
    update = noop;
  }
  class Mesh extends Object3D {
    isMesh = true;
    geometry = { dispose: noop };
    material = { dispose: noop };
  }

  return {
    Scene,
    PerspectiveCamera,
    AmbientLight,
    DirectionalLight,
    Clock,
    WebGLRenderer,
    AnimationMixer,
    Mesh,
    Object3D,
    Quaternion,
    Euler,
    NumberKeyframeTrack,
    QuaternionKeyframeTrack,
    AnimationClip,
    MathUtils,
    LoopRepeat,
    LoopOnce,
    MockScene,
  };
});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => {
  const noop = () => {};

  class MockScene {
    children: MockScene[] = [];
    position = { set: noop };
    rotation = { y: 0 };
    quaternion = {
      x: 0,
      y: 0,
      z: 0,
      w: 1,
      clone() {
        return { ...this };
      },
    };
    frustumCulled = false;

    add(child: MockScene) {
      this.children.push(child);
    }

    remove(child: MockScene) {
      this.children = this.children.filter((item) => item !== child);
    }

    traverse(callback: (node: MockScene) => void) {
      callback(this);
      for (const child of this.children) {
        child.traverse(callback);
      }
    }
  }

  class MockLoader {
    setCrossOrigin() {}
    register() {}
    async parseAsync() {
      const vrm = {
        scene: new MockScene(),
        expressionManager: {
          setValue: noop,
          update: noop,
          resetValues: noop,
          getExpressionTrackName: (name: string) => name,
        },
        humanoid: {
          getNormalizedBoneNode: (name: string) => {
            const node = new MockScene();
            (node as unknown as { name?: string }).name = name;
            return node;
          },
          normalizedRestPose: {
            hips: { position: [0, 1, 0] as [number, number, number] },
          },
        },
        meta: { metaVersion: '1' },
        update: noop,
      };
      return { scene: new MockScene(), parser: {}, userData: { vrm } };
    }
  }

  return {
    GLTFLoader: MockLoader,
  };
});

vi.mock('@pixiv/three-vrm', () => {
  const noop = () => {};

  class MockScene {
    children: MockScene[] = [];
    position = { set: noop };
    rotation = { y: 0 };
    frustumCulled = false;

    add(child: MockScene) {
      this.children.push(child);
    }

    remove(child: MockScene) {
      this.children = this.children.filter((item) => item !== child);
    }

    traverse(callback: (node: MockScene) => void) {
      callback(this);
      for (const child of this.children) {
        child.traverse(callback);
      }
    }
  }

  const VRMExpressionPresetName = {
    Aa: 'aa',
    Ih: 'ih',
    Ou: 'ou',
    Ee: 'ee',
    Oh: 'oh',
    Blink: 'blink',
  } as const;

  class MockExpressionManager {
    setValue = noop;
    update = noop;
    resetValues = noop;
    getExpressionTrackName = (name: string) => name;
  }

  class MockVRM {
    scene = new MockScene();
    expressionManager = new MockExpressionManager();
    humanoid = {
      getNormalizedBoneNode: (name: string) => {
        const node = new MockScene();
        (node as unknown as { name?: string }).name = name;
        return node;
      },
      normalizedRestPose: {
        hips: { position: [0, 1, 0] as [number, number, number] },
      },
    };
    meta = { metaVersion: '1' };
    update = noop;
  }

  return {
    VRMExpressionPresetName,
    VRM: MockVRM,
    VRMLoaderPlugin: class {},
    VRMUtils: {
      removeUnnecessaryVertices: noop,
      removeUnnecessaryJoints: noop,
      rotateVRM0: noop,
      deepDispose: noop,
    },
  };
});

let cleanup: typeof import('@testing-library/react')['cleanup'];
let render: typeof import('@testing-library/react')['render'];
let waitFor: typeof import('@testing-library/react')['waitFor'];

beforeAll(async () => {
  const testingLibrary = await import('@testing-library/react');
  cleanup = testingLibrary.cleanup;
  render = testingLibrary.render;
  waitFor = testingLibrary.waitFor;
});

afterAll(() => {
  cleanup = undefined as never;
  render = undefined as never;
  waitFor = undefined as never;
});

describe('avatar renderer smoke tests', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      return setTimeout(() => callback(performance.now()), 16) as unknown as number;
    });
    vi.stubGlobal('cancelAnimationFrame', (handle: number) => {
      clearTimeout(handle as unknown as NodeJS.Timeout);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    delete (window as { aiembodied?: unknown }).aiembodied;
  });

  it('mounts the 2D sprite renderer', () => {
    const { container } = render(<AvatarRenderer frame={null} assets={null} />);
    expect(container.querySelector('canvas')).toBeTruthy();
  });

  it('mounts the VRM renderer when a model is available', async () => {
    const loadModelBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    (window as { aiembodied?: unknown }).aiembodied = {
      avatar: { loadModelBinary },
    };

    const { container } = render(
      <VrmAvatarRenderer
        frame={null}
        model={{ id: 'vrm-1', name: 'Model', createdAt: Date.now(), version: '1.0', fileSha: 'abc', thumbnailDataUrl: null }}
      />,
    );

    expect(container.querySelector('canvas[data-renderer="vrm"]')).toBeTruthy();
    await waitFor(() => {
      expect(loadModelBinary).toHaveBeenCalledWith('vrm-1');
    });
  });

  it('starts idle animation scheduling after the VRM model loads', async () => {
    const loadModelBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    (window as { aiembodied?: unknown }).aiembodied = {
      avatar: { loadModelBinary },
    };

    const updateSpy = vi.spyOn(IdleAnimationScheduler.prototype, 'update');
    const configSpy = vi.spyOn(IdleAnimationScheduler.prototype, 'updateConfig');

    render(
      <VrmAvatarRenderer
        frame={null}
        model={{ id: 'vrm-2', name: 'Idle Model', createdAt: Date.now(), version: '1.0', fileSha: 'def', thumbnailDataUrl: null }}
      />,
    );

    await waitFor(() => {
      expect(loadModelBinary).toHaveBeenCalledWith('vrm-2');
    });

    await waitFor(() => {
      expect(configSpy).toHaveBeenCalled();
      expect(updateSpy).toHaveBeenCalled();
    });
  });
});
