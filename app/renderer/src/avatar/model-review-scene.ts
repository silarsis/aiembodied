import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { applyPoseToVrm, setupLighting } from './pose-snapshot-generator.js';
import baseNeutralPose from '../../../main/src/avatar/base-poses/relaxed-neutral.pose.json';

export interface ModelReviewScene {
  view(direction: 'front' | 'side' | 'back'): void;
  expression(name: string): void;
  expressions: string[];
  dispose(): void;
}

/** An isolated review scene: never uses the active-avatar animation bus or settings. */
export async function createModelReviewScene(
  host: HTMLElement,
  modelData: ArrayBuffer,
): Promise<ModelReviewScene> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101c30);
  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));
  const url = URL.createObjectURL(new Blob([modelData], { type: 'model/gltf-binary' }));
  let vrm: VRM | undefined;
  let renderer: THREE.WebGLRenderer | undefined;
  let controls: OrbitControls | undefined;
  let observer: ResizeObserver | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    controls?.dispose();
    if (vrm) VRMUtils.deepDispose(vrm.scene);
    scene.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
  };
  try {
    const gltf = await loader.loadAsync(url);
    vrm = gltf.userData.vrm as VRM | undefined;
    if (!vrm) {
      VRMUtils.deepDispose(gltf.scene);
      throw new Error('This file does not contain a usable VRM avatar.');
    }
    VRMUtils.rotateVRM0(vrm);
    scene.add(vrm.scene);
    applyPoseToVrm(vrm, baseNeutralPose);
    for (const expression of vrm.expressionManager?.expressions ?? []) {
      vrm.expressionManager?.setValue(expression.expressionName, 0);
    }
    vrm.update(0);
    vrm.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(vrm.scene, true);
    if (bounds.isEmpty()) throw new Error('The model has no visible geometry to inspect.');
    const center = bounds.getCenter(new THREE.Vector3());
    const size = bounds.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.1);
    const camera = new THREE.PerspectiveCamera(35, 1, extent / 1000, extent * 100);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    const webgl = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute(
      'aria-label',
      'Interactive avatar: drag to rotate, scroll to zoom',
    );
    host.append(renderer.domElement);
    setupLighting(scene);
    controls = new OrbitControls(camera, renderer.domElement);
    const orbit = controls;
    const avatar = vrm;
    controls.target.copy(center);
    controls.minDistance = extent * 0.1;
    controls.maxDistance = extent * 12;
    controls.listenToKeyEvents(renderer.domElement);
    const render = () => {
      if (!disposed) webgl.render(scene, camera);
    };
    controls.addEventListener('change', render);
    const fittedDistance = () => {
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      return (
        1.2 * Math.max(size.y / (2 * tangent), size.x / (2 * tangent * camera.aspect)) + size.z / 2
      );
    };
    const view = (direction: 'front' | 'side' | 'back') => {
      orbit.target.copy(center);
      const distance = Math.max(fittedDistance(), extent);
      const offset =
        direction === 'side'
          ? new THREE.Vector3(distance, 0, 0)
          : new THREE.Vector3(0, 0, direction === 'back' ? -distance : distance);
      camera.position.copy(center).add(offset);
      camera.up.set(0, 1, 0);
      orbit.update();
      render();
    };
    const resize = () => {
      const width = Math.max(host.clientWidth, 1),
        height = Math.max(host.clientHeight, 1);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      webgl.setSize(width, height);
      render();
    };
    resize();
    view('front');
    observer = new ResizeObserver(resize);
    observer.observe(host);
    const expressions =
      vrm.expressionManager?.expressions.map((expression) => expression.expressionName) ?? [];
    return {
      view,
      expressions,
      expression: (name) => {
        for (const expression of expressions)
          avatar.expressionManager?.setValue(expression, expression === name ? 1 : 0);
        avatar.update(0);
        render();
      },
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
