import * as THREE from 'three';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { DEFAULT_ROOM_AVATAR_HEIGHT, measureAvatarHeight, measureSoleLift, placeAtHome } from './avatar-placement.js';
import { RoomCompanions } from './room-companions.js';
import { RoomOccupancy } from './room-occupancy.js';
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
  private avatarBase: { position: THREE.Vector3; rotationY: number; scale: number } | null = null;
  /** Raise from the 2D normalisation (ankles on y = 0) to soles on the floor; see measureSoleLift. */
  private soleLift = 0;
  /** Sole-to-crown height of the avatar as the 2D stage sizes it, in metres. */
  private naturalHeight = 0;
  /** How tall the avatar stands in a room, in metres (the room's furniture is real size). */
  private targetHeight = DEFAULT_ROOM_AVATAR_HEIGHT;
  /** The room scale applied to the avatar now (1 outside rooms). */
  private currentScale = 1;
  private readonly companions = new RoomCompanions();
  private observer: ResizeObserver | null = null;
  private debugNavmesh = false;
  private saved2d: CameraState | null = null;
  private rig: AvatarRig | null = null;
  private body: THREE.Object3D | null = null;
  /** What scene actions use to reach the room and the avatar; stable for the controller's life. */
  /** Spots, seats, objects and the walking turn shared by the avatars in the room. */
  readonly occupancy = new RoomOccupancy();
  readonly sceneEnv = new RoomSceneEnv({
    stage: () => this.stage,
    rig: () => this.rig,
    aspect: () => this.deps.camera.aspect,
    avatarId: 'echo',
    // Echo only takes part while a companion is attached; alone she plans exactly as before.
    occupancy: () => (this.companionEnvs.size > 0 ? this.occupancy : null),
  });

  /** Scene action envs of the companions, by avatar id; each lives as long as its companion stays attached. */
  private readonly companionEnvs = new Map<string, RoomSceneEnv>();

  constructor(private readonly deps: Deps) {}

  /** The env scene actions of this avatar run in: Echo's `sceneEnv`, a companion's own, or null when it has none (yet). */
  envFor(avatarId: string): RoomSceneEnv | null {
    if (avatarId === 'echo') return this.sceneEnv;
    return this.companionEnvs.get(avatarId) ?? null;
  }

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
    // The same room loaded again (an object was made for it): the avatar stays where it is.
    const reload = this.stage !== null && this.room?.id === room.id;
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
    if (!reload) this.occupancy.clear();
    this.disposeStage();
    this.stage = next;
    this.deps.scene.add(next.group);
    next.setDebugNavmesh(this.debugNavmesh);
    if (!wasActive) this.enterCanvasMode();
    this.applyCamera(room);
    this.deps.renderer.setClearColor(room.shell.outside?.color ?? NEUTRAL_CLEAR, 1);
    if (!reload) {
      this.placeAvatar();
      this.placeCompanions();
    }
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
    this.avatarBase = root ? { position: root.position.clone(), rotationY: root.rotation.y, scale: root.scale.x } : null;
    // Measured before placement, while the avatar still stands at its normalised spot.
    this.soleLift = root ? measureSoleLift(root) : 0;
    this.naturalHeight = root ? measureAvatarHeight(root) : 0;
    this.rig =
      root && humanoid ? { scene: root, baseRotationY: root.rotation.y, humanoid, restHipsHeight } : null;
    this.body = humanoid?.getNormalizedBoneNode('hips') ?? null;
    if (root && this.stage) this.placeAvatar();
  }

  /** An extra avatar (not Echo) was added to the scene, or removed with a null root. It stands beside Echo in rooms. */
  attachCompanion(
    id: string,
    root: THREE.Object3D | null,
    humanoid?: AvatarRig['humanoid'] | null,
    restHipsHeight = 0,
  ): void {
    if (!root) {
      this.detachCompanion(id);
      return;
    }
    // A reloaded model: whatever the old body carried goes back before the rig changes.
    this.companionEnvs.get(id)?.releaseHeld();
    this.companions.attach(id, root, humanoid, restHipsHeight);
    if (humanoid && !this.companionEnvs.has(id)) {
      this.companionEnvs.set(
        id,
        new RoomSceneEnv({
          stage: () => this.stage,
          rig: () => this.companions.rigOf(id),
          aspect: () => this.deps.camera.aspect,
          avatarId: id,
          occupancy: () => this.occupancy,
        }),
      );
    } else if (!humanoid) {
      this.companionEnvs.delete(id);
    }
    this.placeCompanions(false);
  }

  detachCompanion(id: string): void {
    this.companionEnvs.get(id)?.releaseHeld();
    this.companionEnvs.delete(id);
    this.occupancy.forget(id);
    this.companions.detach(id);
    this.stage?.removeAvatar(id);
    // The others keep their slots and stay where they are.
  }

  /**
   * How tall the avatar should stand in rooms, in metres. The 2D stage sizes avatars to fill the
   * frame, which makes them giants next to real-size furniture. Applied at once if in a room,
   * keeping the avatar where it stands.
   */
  setAvatarHeight(metres: number): void {
    if (!(metres > 0) || metres === this.targetHeight) return;
    this.targetHeight = metres;
    this.placeCompanions();
    if (!this.avatar || !this.avatarBase || !this.room) return;
    const before = this.currentScale;
    const factor = this.roomScaleFor(metres);
    const delta = factor - before;
    const [bx, by, bz] = this.avatarBase.position.toArray();
    // Keep the soles on the floor and the body where it stands: the root's offset from both scales.
    const yaw = this.avatar.rotation.y - this.avatarBase.rotationY;
    const cos = Math.cos(yaw);
    const sin = Math.sin(yaw);
    this.avatar.position.x += delta * (bx * cos + bz * sin);
    this.avatar.position.z += delta * (-bx * sin + bz * cos);
    this.avatar.position.y += delta * (by + this.soleLift);
    this.avatar.scale.setScalar(this.avatarBase.scale * factor);
    this.currentScale = factor;
    this.avatar.updateWorldMatrix(true, true);
  }

  /** Call once per frame after the animation mixer has run. */
  step(dt: number): void {
    this.sceneEnv.step(dt);
    for (const env of this.companionEnvs.values()) env.step(dt);
    this.stage?.step(dt, this.body ?? this.avatar, this.companions.bodies());
  }

  setDebugNavmesh(on: boolean): void {
    this.debugNavmesh = on;
    this.stage?.setDebugNavmesh(on);
  }

  dispose(): void {
    this.ticket += 1;
    if (this.avatar && this.avatarBase) this.restoreAvatar();
    this.companions.restore();
    this.companions.clear();
    this.companionEnvs.clear();
    this.occupancy.clear();
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
    this.companions.restore();
    this.occupancy.clear();
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
    for (const env of this.companionEnvs.values()) env.releaseHeld();
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

  /** Room size over 2D size; 1 when the avatar's height couldn't be measured. */
  private roomScaleFor(metres: number): number {
    return this.naturalHeight > 0.3 ? metres / this.naturalHeight : 1;
  }

  private placeAvatar(): void {
    if (!this.avatar || !this.avatarBase || !this.room) return;
    // Scaling the root scales its offset from the body centre and the sole depth with it.
    const factor = this.roomScaleFor(this.targetHeight);
    const [bx, by, bz] = this.avatarBase.position.toArray();
    const placed = placeAtHome(
      { position: [bx * factor, by * factor, bz * factor], rotationY: this.avatarBase.rotationY },
      { position: [this.room.home.position[0], this.room.home.position[1] + this.soleLift * factor, this.room.home.position[2]], facing: this.room.home.facing },
    );
    this.avatar.scale.setScalar(this.avatarBase.scale * factor);
    this.currentScale = factor;
    this.avatar.position.set(...placed.position);
    this.avatar.rotation.y = placed.rotationY;
    this.avatar.updateWorldMatrix(true, true);
  }

  private placeCompanions(all = true): void {
    if (this.room && this.stage) this.companions.place(this.room.home, this.targetHeight, all);
  }

  private restoreAvatar(): void {
    if (!this.avatar || !this.avatarBase) return;
    this.avatar.position.copy(this.avatarBase.position);
    this.avatar.rotation.y = this.avatarBase.rotationY;
    this.avatar.scale.setScalar(this.avatarBase.scale);
    this.currentScale = 1;
    this.avatar.updateWorldMatrix(true, true);
  }
}
