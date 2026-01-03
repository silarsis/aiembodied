import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';

const THUMBNAIL_WIDTH = 256;
const THUMBNAIL_HEIGHT = 256;
const CAMERA_FOV = 30;
const CAMERA_DISTANCE = 0.6;
const CAMERA_HEIGHT_OFFSET = 0.08;

export interface ThumbnailGenerationResult {
  dataUrl: string;
  width: number;
  height: number;
}

function createOffscreenRenderer(width: number, height: number): THREE.WebGLRenderer {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    preserveDrawingBuffer: true,
  });
  renderer.setSize(width, height);
  renderer.setClearColor(0x000000, 0);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  return renderer;
}

function computeHeadBoundingBox(vrm: VRM): THREE.Box3 | null {
  const headNode = vrm.humanoid?.getNormalizedBoneNode('head');
  if (!headNode) {
    return null;
  }

  const box = new THREE.Box3();
  headNode.traverse((child) => {
    if (child instanceof THREE.Mesh) {
      const mesh = child as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.computeBoundingBox();
        const meshBox = mesh.geometry.boundingBox;
        if (meshBox) {
          const worldBox = meshBox.clone().applyMatrix4(mesh.matrixWorld);
          box.union(worldBox);
        }
      }
    }
  });

  if (box.isEmpty()) {
    const worldPos = new THREE.Vector3();
    headNode.getWorldPosition(worldPos);
    box.setFromCenterAndSize(worldPos, new THREE.Vector3(0.25, 0.3, 0.25));
  }

  return box;
}

function setupCamera(vrm: VRM, scene: THREE.Scene): THREE.PerspectiveCamera {
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.01, 10);

  vrm.scene.updateMatrixWorld(true);

  const headBox = computeHeadBoundingBox(vrm);
  if (headBox) {
    const center = new THREE.Vector3();
    headBox.getCenter(center);
    const size = new THREE.Vector3();
    headBox.getSize(size);

    const maxDim = Math.max(size.x, size.y, size.z);
    const distance = maxDim / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360)) * 1.5;

    camera.position.set(center.x, center.y + CAMERA_HEIGHT_OFFSET, center.z + distance);
    camera.lookAt(center.x, center.y + CAMERA_HEIGHT_OFFSET, center.z);
  } else {
    const headNode = vrm.humanoid?.getNormalizedBoneNode('head');
    if (headNode) {
      const worldPos = new THREE.Vector3();
      headNode.getWorldPosition(worldPos);
      camera.position.set(worldPos.x, worldPos.y + CAMERA_HEIGHT_OFFSET, worldPos.z + CAMERA_DISTANCE);
      camera.lookAt(worldPos.x, worldPos.y + CAMERA_HEIGHT_OFFSET, worldPos.z);
    } else {
      camera.position.set(0, 1.5, CAMERA_DISTANCE);
      camera.lookAt(0, 1.5, 0);
    }
  }

  scene.add(camera);
  return camera;
}

function setupLighting(scene: THREE.Scene): void {
  const ambient = new THREE.AmbientLight(0xffffff, 0.6);
  scene.add(ambient);

  const keyLight = new THREE.DirectionalLight(0xffffff, 0.8);
  keyLight.position.set(1, 1.5, 2);
  scene.add(keyLight);

  const fillLight = new THREE.DirectionalLight(0xffffff, 0.3);
  fillLight.position.set(-1, 1, 1);
  scene.add(fillLight);

  const rimLight = new THREE.DirectionalLight(0xffffff, 0.2);
  rimLight.position.set(0, 1, -1);
  scene.add(rimLight);
}

export async function generateVrmThumbnail(
  modelData: ArrayBuffer,
): Promise<ThumbnailGenerationResult> {
  const renderer = createOffscreenRenderer(THUMBNAIL_WIDTH, THUMBNAIL_HEIGHT);
  const scene = new THREE.Scene();

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  const blob = new Blob([modelData], { type: 'model/gltf-binary' });
  const url = URL.createObjectURL(blob);

  let vrm: VRM;
  try {
    const gltf = await loader.loadAsync(url);
    vrm = gltf.userData.vrm as VRM;
    if (!vrm) {
      throw new Error('VRM data not found in loaded model.');
    }
  } finally {
    URL.revokeObjectURL(url);
  }

  VRMUtils.rotateVRM0(vrm);
  scene.add(vrm.scene);

  setupLighting(scene);
  const camera = setupCamera(vrm, scene);

  vrm.scene.updateMatrixWorld(true);
  renderer.render(scene, camera);

  const dataUrl = renderer.domElement.toDataURL('image/png');

  VRMUtils.deepDispose(vrm.scene);
  scene.clear();
  renderer.dispose();

  return {
    dataUrl,
    width: THUMBNAIL_WIDTH,
    height: THUMBNAIL_HEIGHT,
  };
}
