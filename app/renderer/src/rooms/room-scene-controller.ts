import * as THREE from 'three';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { placeAtHome } from './avatar-placement.js';
import { RoomStage } from './room-stage.js';
import { createModelLoader } from './room-model-loader.js';
import { RoomSceneEnv, type AvatarRig } from './scene-env.js';

interface Deps {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  canvas: HTMLCanvasElement;
  /** The fixed canvas size used on a 2D backdrop. */
  legacySize: { width: number; height: number };
}

interface CameraState {
  position: THREE.Vector3;
  quaternion: THREE.Quaternion;
  fov: number;
  near: number;
  far: number;
}

function captureCamera(camera: THREE.PerspectiveCamera): CameraState {
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    fov: camera.fov,
    near: camera.near,
    far: camera.far,
  };
}

const NEUTRAL_CLEAR = '#17171d';

/**
 * Switches the avatar renderer between its 2D mode (transparent fixed-size canvas, avatar-fit
 * camera) and a 3D room (canvas fills the stage, room camera, opaque clear colour). The avatar
 * renderer owns the WebGL objects; this class only drives them, so the renderer file stays small.
 */
export class RoomSceneController {
  private stage: RoomStage | null = null;
  private room: RoomFile | null = null;
  private ticket = 0;
  private avatar: THREE.Object3D | null = null;
  private avatarBase: { position: THREE.Vector3; rotationY: number } | null = null;
  private observer: ResizeObserver | null = null;
  private debugNavmesh = false;
  private saved2d: CameraState | null = null;
  private rig: AvatarRig | null = null;
  private body: THREE.Object3D | null = null;
  /** What scene actions use to reach the room and the avatar; stable for the controller's life. */
  readonly sceneEnv = new RoomSceneEnv({ stage: () => this.stage, rig: () => this.rig, aspect: () => this.deps.camera.aspect });

  constructor(private readonly deps: Deps) {}

  /** True once a room has been requested; the 2D camera fit must not run while this is set. */
  get active(): boolean {
    return this.room !== null;
  }

  get currentStage(): RoomStage | null {
    return this.stage;
  }

  /**
   * A model loaded while a room is showing fits its 2D camera on a spare camera; hand that
   * camera here so leaving the room restores the right view. (In 2D mode the live camera is
   * captured when a room is entered, so nothing needs to be remembered.)
   */
  remember2dCamera(camera: THREE.PerspectiveCamera): void {
    this.saved2d = captureCamera(camera);
  }

  async setRoom(room: RoomFile | null): Promise<void> {
    const ticket = ++this.ticket;
    if (!room) {
      this.leaveRoom();
      return;
    }
    if (!this.room) this.saved2d = captureCamera(this.deps.camera);
    this.room = room;
    let next: RoomStage;
    try {
      next = await RoomStage.create(room, { loadModel: createModelLoader() });
    } catch (error) {
      console.error('[rooms] could not start the room', error);
      if (ticket === this.ticket) this.leaveRoom();
      return;
    }
    if (ticket !== this.ticket) {
      next.dispose();
      return;
    }
    const wasActive = this.stage !== null;
    this.disposeStage();
    this.stage = next;
    this.deps.scene.add(next.group);
    next.setDebugNavmesh(this.debugNavmesh);
    if (!wasActive) this.enterCanvasMode();
    this.applyCamera(room);
    this.deps.renderer.setClearColor(room.shell.outside?.color ?? NEUTRAL_CLEAR, 1);
    this.placeAvatar();
  }

  /**
   * Called when a VRM has been added to the scene (or removed, with null). The VRM's humanoid
   * gives scene actions the hands and the pelvis (the physics capsule follows it); `restHipsHeight`
   * is the standing pelvis height in the avatar's own metres.
   */
  attachAvatar(
    root: THREE.Object3D | null,
    humanoid?: AvatarRig['humanoid'] | null,
    restHipsHeight = 0,
  ): void {
    this.sceneEnv.releaseHeld();
    this.avatar = root;
    this.avatarBase = root ? { position: root.position.clone(), rotationY: root.rotation.y } : null;
    this.rig =
      root && humanoid ? { scene: root, baseRotationY: root.rotation.y, humanoid, restHipsHeight } : null;
    this.body = humanoid?.getNormalizedBoneNode('hips') ?? null;
    if (root && this.stage) this.placeAvatar();
  }

  /** Call once per frame after the animation mixer has run. */
  step(dt: number): void {
    this.sceneEnv.step(dt);
    this.stage?.step(dt, this.body ?? this.avatar);
  }

  setDebugNavmesh(on: boolean): void {
    this.debugNavmesh = on;
    this.stage?.setDebugNavmesh(on);
  }

  dispose(): void {
    this.ticket += 1;
    if (this.avatar && this.avatarBase) this.restoreAvatar();
    this.disposeStage();
    this.observer?.disconnect();
    this.observer = null;
    this.room = null;
    this.avatar = null;
    this.avatarBase = null;
    this.rig = null;
    this.body = null;
  }

  private leaveRoom(): void {
    const wasActive = this.room !== null;
    this.room = null;
    this.restoreAvatar();
    this.disposeStage();
    if (!wasActive) return;
    const { camera, renderer, canvas, legacySize } = this.deps;
    this.observer?.disconnect();
    this.observer = null;
    if (this.saved2d) {
      camera.position.copy(this.saved2d.position);
      camera.quaternion.copy(this.saved2d.quaternion);
      camera.fov = this.saved2d.fov;
      camera.near = this.saved2d.near;
      camera.far = this.saved2d.far;
    }
    this.saved2d = null;
    camera.aspect = legacySize.width / legacySize.height;
    camera.updateProjectionMatrix();
    renderer.setClearColor(0x000000, 0);
    canvas.style.width = `${legacySize.width}px`;
    canvas.style.height = `${legacySize.height}px`;
    renderer.setSize(legacySize.width, legacySize.height, false);
  }

  private disposeStage(): void {
    this.sceneEnv.releaseHeld();
    if (!this.stage) return;
    this.deps.scene.remove(this.stage.group);
    this.stage.dispose();
    this.stage = null;
  }

  private enterCanvasMode(): void {
    const { canvas } = this.deps;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    this.fitToContainer();
    const parent = canvas.parentElement;
    if (parent && typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.fitToContainer());
      this.observer.observe(parent);
    }
  }

  private fitToContainer(): void {
    const { canvas, renderer, camera } = this.deps;
    const parent = canvas.parentElement;
    const width = parent?.clientWidth ?? 0;
    const height = parent?.clientHeight ?? 0;
    if (width <= 0 || height <= 0) return;
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
  }

  private applyCamera(room: RoomFile): void {
    const { camera } = this.deps;
    camera.fov = room.camera.fov;
    camera.near = 0.05;
    camera.far = 50;
    camera.position.set(...room.camera.position);
    camera.lookAt(new THREE.Vector3(...room.camera.target));
    camera.updateProjectionMatrix();
    this.fitToContainer();
  }

  private placeAvatar(): void {
    if (!this.avatar || !this.avatarBase || !this.room) return;
    const placed = placeAtHome(
      { position: this.avatarBase.position.toArray() as [number, number, number], rotationY: this.avatarBase.rotationY },
      this.room.home,
    );
    this.avatar.position.set(...placed.position);
    this.avatar.rotation.y = placed.rotationY;
    this.avatar.updateWorldMatrix(true, true);
  }

  private restoreAvatar(): void {
    if (!this.avatar || !this.avatarBase) return;
    this.avatar.position.copy(this.avatarBase.position);
    this.avatar.rotation.y = this.avatarBase.rotationY;
    this.avatar.updateWorldMatrix(true, true);
  }
}
