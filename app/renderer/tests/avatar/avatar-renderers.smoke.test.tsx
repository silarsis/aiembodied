import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AvatarRenderer } from '../../src/avatar/avatar-renderer.js';
import { VrmAvatarRenderer } from '../../src/avatar/vrm-avatar-renderer.js';

vi.mock('three', () => {
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
    constructor(public readonly root?: unknown) {}
    clipAction() {
      return {
        clampWhenFinished: false,
        enabled: false,
        setLoop: noop,
        setEffectiveWeight: noop,
        setEffectiveTimeScale: noop,
        reset: noop,
        play: noop,
        stop: noop,
        fadeIn: noop,
        fadeOut: noop,
      };
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
    MockScene,
  };
});

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => {
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
        },
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
  }

  class MockVRM {
    scene = new MockScene();
    expressionManager = new MockExpressionManager();
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
});
