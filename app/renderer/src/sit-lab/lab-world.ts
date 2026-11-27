import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { AvatarActor } from '../avatar/avatar-actor.js';
import { JointLimits } from '../avatar/joint-limits.js';
import type { AvatarRestSkeleton } from '../avatar/types.js';
import { RoomSceneController } from '../rooms/room-scene-controller.js';
import type { RoomStage } from '../rooms/room-stage.js';
import type { PlanWorld } from '../rooms/scene-actions.js';
import { initPhysics } from '../rooms/room-physics.js';
import { LabRig } from './lab-rig.js';
import { STEP_S, type LabSpec, type Pose, type StartSpec } from './types.js';

const CANVAS_WIDTH = 960;
const CANVAS_HEIGHT = 720;

/**
 * One room with one avatar in it, built from the app's own pieces: `RoomSceneController` (room stage, physics,
 * placement and scale), `AvatarActor` (the VRM loading path) and the `JointLimits` the actor applies each frame.
 * Nothing here advances time; the trial steps the frames.
 */
export class LabWorld {
  private constructor(
    readonly controller: RoomSceneController,
    readonly stage: RoomStage,
    readonly renderer: THREE.WebGLRenderer,
    readonly scene: THREE.Scene,
    readonly camera: THREE.PerspectiveCamera,
    readonly vrm: VRM,
    readonly rig: LabRig,
    readonly limits: JointLimits,
    readonly restSkeleton: AvatarRestSkeleton,
    /** The avatar's pose as loaded (its relaxed neutral pose), which every trial starts from. */
    private readonly neutral: Pose,
    /** The root's height when the avatar stands on the floor (the soles' lift included). */
    private readonly groundY: number,
  ) {}

  static async create(spec: LabSpec, host: HTMLElement): Promise<LabWorld> {
    await initPhysics();
    host.style.width = `${CANVAS_WIDTH}px`;
    host.style.height = `${CANVAS_HEIGHT}px`;
    const canvas = document.createElement('canvas');
    host.replaceChildren(canvas);
    const renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      preserveDrawingBuffer: true,
    });
    renderer.setPixelRatio(1);
    renderer.setSize(CANVAS_WIDTH, CANVAS_HEIGHT, false);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(50, CANVAS_WIDTH / CANVAS_HEIGHT, 0.05, 50);
    const controller = new RoomSceneController({
      renderer,
      scene,
      camera,
      canvas,
      legacySize: { width: CANVAS_WIDTH, height: CANVAS_HEIGHT },
    });
    await controller.setRoom(spec.roomJson);
    const stage = controller.currentStage;
    if (!stage) throw new Error('The room did not load (see the console for why).');

    const response = await fetch(spec.avatarUrl);
    if (!response.ok)
      throw new Error(`Could not fetch the avatar ${spec.avatarUrl}: ${response.status}`);
    const actor = new AvatarActor({ id: 'echo', hasRoom: () => true });
    const attached: { rest: AvatarRestSkeleton | null } = { rest: null };
    const loaded = await actor.load({
      binary: await response.arrayBuffer(),
      modelId: 'sit-lab',
      parent: scene,
      onAttached: ({ vrm, restSkeleton }) => {
        attached.rest = restSkeleton;
        controller.attachAvatar(vrm.scene, vrm.humanoid, restSkeleton?.hips[1]);
      },
    });
    const vrm = actor.getVrm();
    if (!loaded || !vrm) throw new Error('The avatar did not load.');
    const rest = attached.rest;
    if (!rest)
      throw new Error('The avatar has no measurable rest skeleton (it needs an upper chest).');
    const restHipsHeight = rest.hips[1];
    const rig = new LabRig({ scene: vrm.scene, humanoid: vrm.humanoid, restHipsHeight });
    const limits = new JointLimits(vrm.humanoid, vrm.meta?.metaVersion === '0');
    return new LabWorld(
      controller,
      stage,
      renderer,
      scene,
      camera,
      vrm,
      rig,
      limits,
      rest,
      rig.readPose(),
      vrm.scene.position.y,
    );
  }

  /** Puts the avatar at `start` in its neutral pose, with the app's seat fit and contact solver back to rest. */
  placeAt(start: StartSpec): void {
    const env = this.controller.sceneEnv;
    env.clearSeat();
    env.setStreamPlaying(false);
    // The seat fit eases its offset away over a second or so.
    for (let i = 0; i < 120; i += 1) this.controller.step(STEP_S);
    env.disposeContact();
    this.rig.writePose(this.neutral);
    env.setRootPose({ x: start.x, z: start.z, yaw: (start.heading * Math.PI) / 180 });
    this.rig.scene.position.y = this.groundY;
    this.rig.captureBase();
    this.rig.updateWorld();
  }

  neutralPose(): Pose {
    return this.neutral;
  }

  planWorld(): PlanWorld {
    const world = this.controller.sceneEnv.planWorld();
    if (!world) throw new Error('The room or the avatar is not ready to plan.');
    return world;
  }

  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.controller.dispose();
    this.renderer.dispose();
  }
}
