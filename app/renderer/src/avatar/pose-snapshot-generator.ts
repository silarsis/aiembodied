import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { VRM, VRMLoaderPlugin, VRMUtils, VRMHumanBoneName } from '@pixiv/three-vrm';
import { normalizePoseData } from './vrm-avatar-renderer.js';

const SNAPSHOT_WIDTH = 512;
const SNAPSHOT_HEIGHT = 768;
const CAMERA_FOV = 35;
const FULL_BODY_PADDING = 1.3;

export interface PoseSnapshotOptions {
    modelData: ArrayBuffer;
    poseData?: Record<string, unknown>; // Accepts both legacy flat format and new nested format
    width?: number;
    height?: number;
}

export interface PoseSnapshotResult {
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
    renderer.setClearColor(0x1a1a2e, 1); // Dark background for better visibility
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    return renderer;
}

function computeFullBodyBoundingBox(vrm: VRM): THREE.Box3 {
    const box = new THREE.Box3();

    vrm.scene.traverse((child) => {
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
        // Fallback to estimated humanoid bounds
        const hips = vrm.humanoid?.getNormalizedBoneNode('hips');
        if (hips) {
            const hipsPos = new THREE.Vector3();
            hips.getWorldPosition(hipsPos);
            // Estimate 1.8m tall humanoid
            box.setFromCenterAndSize(
                new THREE.Vector3(hipsPos.x, hipsPos.y + 0.4, hipsPos.z),
                new THREE.Vector3(0.8, 1.8, 0.5)
            );
        } else {
            box.setFromCenterAndSize(
                new THREE.Vector3(0, 0.9, 0),
                new THREE.Vector3(0.8, 1.8, 0.5)
            );
        }
    }

    return box;
}

function setupFullBodyCamera(vrm: VRM, scene: THREE.Scene, aspectRatio: number): THREE.PerspectiveCamera {
    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, aspectRatio, 0.01, 20);

    vrm.scene.updateMatrixWorld(true);

    const box = computeFullBodyBoundingBox(vrm);
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);

    // Calculate distance to fit full body in frame with padding
    const maxDim = Math.max(size.x, size.y / aspectRatio, size.z);
    const distance = (maxDim * FULL_BODY_PADDING) / (2 * Math.tan((CAMERA_FOV * Math.PI) / 360));

    camera.position.set(center.x, center.y, center.z + distance);
    camera.lookAt(center.x, center.y, center.z);

    scene.add(camera);
    return camera;
}

function setupLighting(scene: THREE.Scene): void {
    const ambient = new THREE.AmbientLight(0xffffff, 0.7);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffffff, 0.9);
    keyLight.position.set(2, 3, 4);
    scene.add(keyLight);

    const fillLight = new THREE.DirectionalLight(0xffffff, 0.4);
    fillLight.position.set(-2, 2, 2);
    scene.add(fillLight);

    const rimLight = new THREE.DirectionalLight(0xffffff, 0.3);
    rimLight.position.set(0, 2, -2);
    scene.add(rimLight);
}

function applyPoseToVrm(
    vrm: VRM,
    rawPoseData: PoseSnapshotOptions['poseData']
): void {
    if (!rawPoseData || !vrm.humanoid) {
        return;
    }

    // Normalize pose data to handle both legacy flat format and new nested format
    const { bones, expressions } = normalizePoseData(rawPoseData as Parameters<typeof normalizePoseData>[0]);
    const humanoid = vrm.humanoid;

    // Apply bone rotations
    for (const [boneName, boneData] of Object.entries(bones)) {
        const rotation = boneData.rotation;
        if (!rotation || rotation.length !== 4) {
            continue;
        }

        const node = humanoid.getNormalizedBoneNode(boneName as VRMHumanBoneName);
        if (!node) {
            continue;
        }

        node.quaternion.set(rotation[0], rotation[1], rotation[2], rotation[3]);

        // Apply position if present (e.g., for hips)
        if (boneData.position && boneData.position.length === 3) {
            node.position.set(boneData.position[0], boneData.position[1], boneData.position[2]);
        }
    }

    // Apply expressions
    if (expressions && vrm.expressionManager) {
        const expressionManager = vrm.expressionManager;

        if (expressions.presets) {
            for (const [name, weight] of Object.entries(expressions.presets)) {
                if (typeof weight === 'number' && Number.isFinite(weight)) {
                    expressionManager.setValue(name, Math.max(0, Math.min(1, weight)));
                }
            }
        }
    }
}

/**
 * Generate a full-body snapshot of a VRM model in a specific pose.
 * Uses offscreen canvas rendering similar to thumbnail generation.
 */
export async function generatePoseSnapshot(
    options: PoseSnapshotOptions
): Promise<PoseSnapshotResult> {
    const width = options.width ?? SNAPSHOT_WIDTH;
    const height = options.height ?? SNAPSHOT_HEIGHT;
    const aspectRatio = width / height;

    const renderer = createOffscreenRenderer(width, height);
    const scene = new THREE.Scene();

    const loader = new GLTFLoader();
    loader.register((parser) => new VRMLoaderPlugin(parser));

    const blob = new Blob([options.modelData], { type: 'model/gltf-binary' });
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

    // Apply pose before rendering
    if (options.poseData) {
        applyPoseToVrm(vrm, options.poseData);
    }

    setupLighting(scene);
    const camera = setupFullBodyCamera(vrm, scene, aspectRatio);

    vrm.scene.updateMatrixWorld(true);
    renderer.render(scene, camera);

    const dataUrl = renderer.domElement.toDataURL('image/png');

    VRMUtils.deepDispose(vrm.scene);
    scene.clear();
    renderer.dispose();

    return {
        dataUrl,
        width,
        height,
    };
}
