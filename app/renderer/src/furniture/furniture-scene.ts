import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { setupLighting } from '../avatar/pose-snapshot-generator.js';

/** The person next to the piece, so its scale reads at a glance. */
export const HUMAN_HEIGHT = 1.7;
const HUMAN_RADIUS = 0.22;

export interface FurnitureScene {
  /** Back to the starting view. */
  reset(): void;
  dispose(): void;
}

function labelSprite(text: string): THREE.Sprite {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 96;
  const context = canvas.getContext('2d');
  if (context) {
    context.fillStyle = '#e2e8f0';
    context.font = '56px sans-serif';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, 128, 48);
  }
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false, transparent: true }));
  sprite.scale.set(0.5, 0.1875, 1);
  return sprite;
}

/**
 * An isolated scene for one furniture GLB (which is already in metres, standing on y=0): a floor grid with
 * 0.5 m squares, a 1.7 m person beside it, orbit/zoom/pan like the avatar review. Not tied to any room.
 */
export async function createFurnitureScene(host: HTMLElement, modelData: ArrayBuffer): Promise<FurnitureScene> {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x101c30);
  const url = URL.createObjectURL(new Blob([modelData], { type: 'model/gltf-binary' }));
  let renderer: THREE.WebGLRenderer | undefined;
  let controls: OrbitControls | undefined;
  let observer: ResizeObserver | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    controls?.dispose();
    scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Sprite || object instanceof THREE.LineSegments)) return;
      const { geometry, material: materials } = object as { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[] };
      geometry.dispose();
      for (const material of [materials].flat() as THREE.MeshStandardMaterial[]) {
        material.map?.dispose();
        material.dispose();
      }
    });
    scene.clear();
    renderer?.dispose();
    renderer?.forceContextLoss();
    renderer?.domElement.remove();
  };
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    scene.add(gltf.scene);
    scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    if (bounds.isEmpty()) throw new Error('The model has no visible geometry.');

    const grid = new THREE.GridHelper(6, 12, 0x475569, 0x27364d);
    scene.add(grid);
    // The person stands to the left of the piece, out of its way.
    const personX = bounds.min.x - 0.6;
    const person = new THREE.Mesh(
      new THREE.CapsuleGeometry(HUMAN_RADIUS, HUMAN_HEIGHT - 2 * HUMAN_RADIUS, 6, 16),
      new THREE.MeshStandardMaterial({ color: 0x7dd3fc, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    person.position.set(personX, HUMAN_HEIGHT / 2, 0);
    const label = labelSprite('1.7 m');
    label.position.set(personX, HUMAN_HEIGHT + 0.15, 0);
    scene.add(person, label);
    setupLighting(scene);

    const frame = new THREE.Box3().union(bounds).expandByPoint(new THREE.Vector3(personX - HUMAN_RADIUS, HUMAN_HEIGHT + 0.3, 0));
    const center = frame.getCenter(new THREE.Vector3());
    const size = frame.getSize(new THREE.Vector3());
    const extent = Math.max(size.x, size.y, size.z, 0.5);
    const camera = new THREE.PerspectiveCamera(35, 1, extent / 1000, extent * 100);
    renderer = new THREE.WebGLRenderer({ antialias: true });
    const webgl = renderer;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', 'Interactive furniture: drag to rotate, scroll to zoom');
    host.append(renderer.domElement);
    controls = new OrbitControls(camera, renderer.domElement);
    const orbit = controls;
    controls.minDistance = extent * 0.3;
    controls.maxDistance = extent * 8;
    controls.maxPolarAngle = Math.PI / 2 + 0.1;
    controls.listenToKeyEvents(renderer.domElement);
    const render = () => {
      if (!disposed) webgl.render(scene, camera);
    };
    controls.addEventListener('change', render);
    const reset = () => {
      orbit.target.copy(center);
      const tangent = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
      const distance = 1.2 * Math.max(size.y / (2 * tangent), size.x / (2 * tangent * camera.aspect)) + size.z / 2;
      // Three-quarter view from the front and a little above.
      camera.position.copy(center).add(new THREE.Vector3(distance * 0.5, distance * 0.3, distance * 0.85));
      camera.up.set(0, 1, 0);
      orbit.update();
      render();
    };
    const resize = () => {
      camera.aspect = Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1);
      camera.updateProjectionMatrix();
      webgl.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1));
      render();
    };
    resize();
    reset();
    observer = new ResizeObserver(resize);
    observer.observe(host);
    return { reset, dispose };
  } catch (error) {
    dispose();
    throw error;
  } finally {
    URL.revokeObjectURL(url);
  }
}
