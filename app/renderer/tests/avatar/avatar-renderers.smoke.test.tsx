import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

    copy(other: Quaternion): Quaternion {
      this.x = other.x;
      this.y = other.y;
      this.z = other.z;
      this.w = other.w;
      return this;
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
    position = { x: 0, y: 0, z: 0, set: noop };
    rotation = { y: 0 };
    quaternion = new Quaternion();
    frustumCulled = false;
    updateWorldMatrix = noop;
    scale = { setScalar: noop };
    matrixWorld = {};

    getWorldPosition(target: { x: number; y: number; z: number }) {
      target.x = this.position.x;
      target.y = this.position.y;
      target.z = this.position.z;
      return target;
    }

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
    position = { x: 0, y: 0, z: 0, set: noop };
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
    geometry = {
      boundingBox: null as Box3 | null,
      dispose: noop,
      computeBoundingBox() {
        this.boundingBox = new Box3(new Vector3(0, 0, 0), new Vector3(1, 1, 1));
      },
    };
    material = { dispose: noop };
    matrixWorld = {};
  }

  class Vector3 {
    constructor(public x = 0, public y = 0, public z = 0) {}

    add(other: Vector3) {
      this.x += other.x;
      this.y += other.y;
      this.z += other.z;
      return this;
    }

    multiplyScalar(scalar: number) {
      this.x *= scalar;
      this.y *= scalar;
      this.z *= scalar;
      return this;
    }

    setFromMatrixPosition() {
      return this;
    }

    clone() {
      return new Vector3(this.x, this.y, this.z);
    }
  }

  class Box3 {
    constructor(public min = new Vector3(), public max = new Vector3(1, 1, 1)) {}

    clone() {
      return new Box3(this.min.clone(), this.max.clone());
    }

    applyMatrix4() {
      return this;
    }

    copy(box: Box3) {
      this.min = box.min.clone();
      this.max = box.max.clone();
      return this;
    }

    union(box: Box3) {
      this.min.x = Math.min(this.min.x, box.min.x);
      this.min.y = Math.min(this.min.y, box.min.y);
      this.min.z = Math.min(this.min.z, box.min.z);
      this.max.x = Math.max(this.max.x, box.max.x);
      this.max.y = Math.max(this.max.y, box.max.y);
      this.max.z = Math.max(this.max.z, box.max.z);
      return this;
    }

    getSize(target: Vector3) {
      target.x = this.max.x - this.min.x;
      target.y = this.max.y - this.min.y;
      target.z = this.max.z - this.min.z;
      return target;
    }

    getCenter(target: Vector3) {
      target.x = (this.min.x + this.max.x) / 2;
      target.y = (this.min.y + this.max.y) / 2;
      target.z = (this.min.z + this.max.z) / 2;
      return target;
    }
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
    Vector3,
    Box3,
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

  class MockQuaternion {
    constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

    clone() {
      return new MockQuaternion(this.x, this.y, this.z, this.w);
    }

    copy(other: MockQuaternion) {
      this.x = other.x;
      this.y = other.y;
      this.z = other.z;
      this.w = other.w;
      return this;
    }

    multiply(quaternion: MockQuaternion) {
      this.x += quaternion.x;
      this.y += quaternion.y;
      this.z += quaternion.z;
      this.w += quaternion.w - 1;
      return this;
    }
  }

  class MockScene {
    children: MockScene[] = [];
    position = { x: 0, y: 0, z: 0, set: noop };
    rotation = { y: 0 };
    quaternion = new MockQuaternion();
    frustumCulled = false;
    updateWorldMatrix = noop;
    scale = { setScalar: noop };
    matrixWorld = {};

    getWorldPosition(target: { x: number; y: number; z: number }) {
      target.x = this.position.x;
      target.y = this.position.y;
      target.z = this.position.z;
      return target;
    }

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

  class MockQuaternion {
    constructor(public x = 0, public y = 0, public z = 0, public w = 1) {}

    clone() {
      return new MockQuaternion(this.x, this.y, this.z, this.w);
    }

    copy(other: MockQuaternion) {
      this.x = other.x;
      this.y = other.y;
      this.z = other.z;
      this.w = other.w;
      return this;
    }

    multiply(quaternion: MockQuaternion) {
      this.x += quaternion.x;
      this.y += quaternion.y;
      this.z += quaternion.z;
      this.w += quaternion.w - 1;
      return this;
    }
  }

  class MockScene {
    children: MockScene[] = [];
    position = { x: 0, y: 0, z: 0, set: noop };
    rotation = { y: 0 };
    frustumCulled = false;
    scale = { setScalar: noop };
    matrixWorld = {};
    quaternion = new MockQuaternion();

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

    getWorldPosition(target: { x: number; y: number; z: number }) {
      target.x = this.position.x;
      target.y = this.position.y;
      target.z = this.position.z;
      return target;
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

  it('mounts the VRM renderer when a model is available', async () => {
    const loadModelBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    (window as { aiembodied?: unknown }).aiembodied = {
      avatar: { loadModelBinary },
    };

    const { container } = render(
      <VrmAvatarRenderer
        frame={null}
        model={{ id: 'vrm-1', name: 'Model', createdAt: Date.now(), version: '1.0', fileSha: 'abc', thumbnailDataUrl: null, description: null }}
      />,
    );

    expect(container.querySelector('canvas[data-renderer="vrm"]')).toBeTruthy();
    await waitFor(() => {
      expect(loadModelBinary).toHaveBeenCalledWith('vrm-1');
    });
  });

  it('loads the VRM model binary when the component mounts', async () => {
    const loadModelBinary = vi.fn().mockResolvedValue(new ArrayBuffer(8));
    (window as { aiembodied?: unknown }).aiembodied = {
      avatar: { loadModelBinary },
    };

    const { container } = render(
      <VrmAvatarRenderer
        frame={null}
        model={{ id: 'vrm-2', name: 'Idle Model', createdAt: Date.now(), version: '1.0', fileSha: 'def', thumbnailDataUrl: null, description: null }}
      />,
    );

    expect(container.querySelector('canvas[data-renderer="vrm"]')).toBeTruthy();
    
    await waitFor(() => {
      expect(loadModelBinary).toHaveBeenCalledWith('vrm-2');
    });
  });
});
