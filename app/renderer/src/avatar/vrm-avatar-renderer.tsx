import { memo, useEffect, useMemo, useRef, useState } from 'react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  VRM,
  VRMLoaderPlugin,
  VRMUtils,
  VRMExpressionPresetName,
  type VRMExpressionManager,
} from '@pixiv/three-vrm';
import type { VisemeFrame } from '../audio/viseme-driver.js';
import type { AvatarModelSummary } from './types.js';
import { getPreloadApi } from '../preload-api.js';

export interface VrmRendererStatus {
  status: 'idle' | 'loading' | 'ready' | 'error';
  message?: string;
}

export interface VrmAvatarRendererProps {
  frame: VisemeFrame | null;
  model: AvatarModelSummary | null | undefined;
  onStatusChange?: (status: VrmRendererStatus) => void;
  className?: string;
}

const VISEME_PRESETS: VRMExpressionPresetName[] = [
  VRMExpressionPresetName.Aa,
  VRMExpressionPresetName.Ih,
  VRMExpressionPresetName.Ou,
  VRMExpressionPresetName.Ee,
  VRMExpressionPresetName.Oh,
];

const BLINK_HOLD_SECONDS = 0.12;
const CAMERA_DISTANCE = 1.45;
const CAMERA_HEIGHT = 1.35;
const CAMERA_FOV = 35;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

export function mapVisemeToPreset(index: number | undefined): VRMExpressionPresetName | null {
  if (typeof index !== 'number' || !Number.isFinite(index)) {
    return null;
  }
  const preset = VISEME_PRESETS[index];
  return preset ?? null;
}

export function smoothWeight(
  current: number,
  target: number,
  deltaSeconds: number,
  attackRate = 14,
  releaseRate = 10,
): number {
  const clampedTarget = clamp01(target);
  const clampedCurrent = clamp01(current);
  const rate = clampedTarget > clampedCurrent ? attackRate : releaseRate;
  const factor = 1 - Math.exp(-Math.max(0, deltaSeconds) * rate);
  if (!Number.isFinite(factor) || factor <= 0) {
    return clampedCurrent;
  }
  const next = clampedCurrent + (clampedTarget - clampedCurrent) * Math.min(1, factor);
  return clamp01(next);
}

interface VisemeWeightState {
  weights: Map<VRMExpressionPresetName, number>;
}

interface BlinkState {
  value: number;
  target: number;
  hold: number;
}

function createDefaultVisemeState(): VisemeWeightState {
  const weights = new Map<VRMExpressionPresetName, number>();
  for (const preset of VISEME_PRESETS) {
    weights.set(preset, 0);
  }
  return { weights };
}

function createDefaultBlinkState(): BlinkState {
  return { value: 0, target: 0, hold: 0 };
}

function disposeVrm(vrm: VRM | null) {
  if (!vrm) {
    return;
  }

  try {
    vrm.expressionManager?.resetValues();
  } catch {
    // ignore expression reset errors
  }

  try {
    VRMUtils.deepDispose(vrm.scene);
  } catch {
    // ignore deep disposal errors
  }
}

export const VrmAvatarRenderer = memo(function VrmAvatarRenderer({
  frame,
  model,
  onStatusChange,
  className,
}: VrmAvatarRendererProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const rendererRef = useRef<THREE.WebGLRenderer | null>(null);
  const sceneRef = useRef<THREE.Scene | null>(null);
  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const currentVrmRef = useRef<VRM | null>(null);
  const expressionManagerRef = useRef<VRMExpressionManager | null>(null);
  const visemeStateRef = useRef<VisemeWeightState>(createDefaultVisemeState());
  const blinkStateRef = useRef<BlinkState>(createDefaultBlinkState());
  const frameRef = useRef<VisemeFrame | null>(frame);
  const animationFrameRef = useRef<number | null>(null);
  const clockRef = useRef(new THREE.Clock());
  const [rendererReady, setRendererReady] = useState(false);

  frameRef.current = frame;

  const setStatus = useMemo(() => {
    return (status: VrmRendererStatus) => {
      onStatusChange?.(status);
    };
  }, [onStatusChange]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) {
      return;
    }

    const isJsdom =
      typeof navigator !== 'undefined' && typeof navigator.userAgent === 'string'
        ? /jsdom/i.test(navigator.userAgent)
        : false;

    if (isJsdom && typeof (canvas as { getContext?: unknown }).getContext !== 'function') {
      // jsdom canvas stubs may not implement getContext; skip initialization for tests
      setStatus({ status: 'idle' });
      return;
    }

    let renderer: THREE.WebGLRenderer | null = null;

    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to initialize WebGL renderer.';
      console.error('[vrm-avatar-renderer] unable to create WebGLRenderer', error);
      setStatus({ status: 'error', message });
      return;
    }

    renderer.setClearColor(0x000000, 0);
    rendererRef.current = renderer;

    const scene = new THREE.Scene();
    sceneRef.current = scene;

    const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, 0.1, 20);
    camera.position.set(0, CAMERA_HEIGHT, CAMERA_DISTANCE);
    camera.lookAt(0, CAMERA_HEIGHT - 0.1, 0);
    cameraRef.current = camera;

    const ambient = new THREE.AmbientLight(0xffffff, 0.6);
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.1);
    keyLight.position.set(0.8, 1.6, 1.0);
    const fillLight = new THREE.DirectionalLight(0xffffff, 0.6);
    fillLight.position.set(-1.2, 1.2, 0.8);

    scene.add(ambient);
    scene.add(keyLight);
    scene.add(fillLight);

    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const pixelRatio = typeof window !== 'undefined' ? window.devicePixelRatio ?? 1 : 1;
      const width = Math.max(1, Math.floor(rect.width * pixelRatio));
      const height = Math.max(1, Math.floor(rect.height * pixelRatio));
      if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
      }
      renderer.setPixelRatio(pixelRatio);
      renderer.setSize(rect.width || 320, rect.height || 320, false);
      if (camera) {
        camera.aspect = rect.width > 0 && rect.height > 0 ? rect.width / rect.height : 1;
        camera.updateProjectionMatrix();
      }
    };

    resize();

    const resizeObserver = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(resize) : null;
    resizeObserver?.observe(canvas);

    clockRef.current = new THREE.Clock();

    const renderFrame = () => {
      const rendererInstance = rendererRef.current;
      const sceneInstance = sceneRef.current;
      const cameraInstance = cameraRef.current;
      const manager = expressionManagerRef.current;
      if (!rendererInstance || !sceneInstance || !cameraInstance) {
        return;
      }

      resize();
      const delta = clockRef.current.getDelta();

      if (manager) {
        const visemeState = visemeStateRef.current;
        const blinkState = blinkStateRef.current;
        const currentFrame = frameRef.current;
        const preset = mapVisemeToPreset(currentFrame?.index);
        const targetWeight = clamp01(currentFrame?.intensity ?? 0);

        for (const visemePreset of VISEME_PRESETS) {
          const target = visemePreset === preset ? targetWeight : 0;
          const current = visemeState.weights.get(visemePreset) ?? 0;
          const next = smoothWeight(current, target, delta);
          visemeState.weights.set(visemePreset, next);
          manager.setValue(visemePreset, next);
        }

        if (currentFrame?.blink) {
          blinkState.target = 1;
          blinkState.hold = BLINK_HOLD_SECONDS;
        } else if (blinkState.hold > 0) {
          blinkState.hold = Math.max(0, blinkState.hold - delta);
          if (blinkState.hold === 0) {
            blinkState.target = 0;
          }
        }

        blinkState.value = smoothWeight(blinkState.value, blinkState.target, delta, 22, 14);
        if (blinkState.target === 0 && blinkState.value < 0.01) {
          blinkState.value = 0;
        }
        manager.setValue(VRMExpressionPresetName.Blink, blinkState.value);
        manager.update();
      }

      currentVrmRef.current?.update(delta);
      rendererInstance.render(sceneInstance, cameraInstance);
      animationFrameRef.current = requestAnimationFrame(renderFrame);
    };

    animationFrameRef.current = requestAnimationFrame(renderFrame);
    setRendererReady(true);

    return () => {
      if (animationFrameRef.current !== null) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      animationFrameRef.current = null;
      resizeObserver?.disconnect();
      scene.remove(ambient);
      scene.remove(keyLight);
      scene.remove(fillLight);
      disposeVrm(currentVrmRef.current);
      renderer.dispose();
      rendererRef.current = null;
      sceneRef.current = null;
      cameraRef.current = null;
      expressionManagerRef.current = null;
      currentVrmRef.current = null;
      visemeStateRef.current = createDefaultVisemeState();
      blinkStateRef.current = createDefaultBlinkState();
    };
  }, [setStatus]);

  useEffect(() => {
    if (!rendererReady) {
      return;
    }

    const scene = sceneRef.current;
    if (!scene || !rendererRef.current) {
      return;
    }

    let cancelled = false;

    const unload = () => {
      if (currentVrmRef.current) {
        scene.remove(currentVrmRef.current.scene);
      }
      disposeVrm(currentVrmRef.current);
      currentVrmRef.current = null;
      expressionManagerRef.current = null;
      visemeStateRef.current = createDefaultVisemeState();
      blinkStateRef.current = createDefaultBlinkState();
    };

    const load = async () => {
      if (!model) {
        unload();
        setStatus({ status: 'idle' });
        return;
      }

      unload();
      setStatus({ status: 'loading' });

      try {
        const bridge = getPreloadApi();
        const binary = await bridge?.avatar?.loadModelBinary(model.id);
        if (!binary) {
          throw new Error('VRM binary payload is unavailable.');
        }

        const loader = new GLTFLoader();
        loader.register((parser) => new VRMLoaderPlugin(parser));
        const gltf = (await loader.parseAsync(binary, '/')) as { userData?: { vrm?: VRM } };
        const vrm = gltf.userData?.vrm;
        if (!vrm) {
          throw new Error('Parsed GLTF did not include a VRM extension.');
        }

        if (typeof VRMUtils.removeUnnecessaryVertices === 'function') {
          VRMUtils.removeUnnecessaryVertices(vrm.scene);
        }
        if (typeof VRMUtils.removeUnnecessaryJoints === 'function') {
          VRMUtils.removeUnnecessaryJoints(vrm.scene);
        }
        if (typeof VRMUtils.rotateVRM0 === 'function') {
          VRMUtils.rotateVRM0(vrm);
        }

        vrm.scene.traverse((object: THREE.Object3D) => {
          object.frustumCulled = false;
        });

        vrm.scene.position.set(0, -0.9, 0);
        vrm.scene.rotation.y = Math.PI / 14;

        if (cancelled) {
          disposeVrm(vrm);
          return;
        }

        scene.add(vrm.scene);
        currentVrmRef.current = vrm;
        expressionManagerRef.current = vrm.expressionManager ?? null;
        expressionManagerRef.current?.resetValues();
        setStatus({ status: 'ready' });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unable to load VRM model. Please check the console logs.';
        console.error('[vrm-avatar-renderer] failed to load VRM model', error);
        unload();
        setStatus({ status: 'error', message });
      }
    };

    void load();

    return () => {
      cancelled = true;
    };
  }, [model, model?.id, model?.fileSha, rendererReady, setStatus]);

  return <canvas ref={canvasRef} className={className} data-renderer="vrm" />;
});
