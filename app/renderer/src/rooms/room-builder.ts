import * as THREE from 'three';
import type { RoomFile, RoomLight, RoomObject, RoomOpening, RoomPart } from '../../../main/src/rooms/types.js';
import { WALL_THICKNESS, degToRad, wallPieces, type WallName } from './room-geometry.js';

export interface BuiltRoom {
  group: THREE.Group;
  objectNodes: Map<string, THREE.Object3D>;
  dispose(): void;
}

export interface BuildRoomOptions {
  /**
   * TODO(later step): objects with `model.file` are skipped for now. When given, this hook is
   * asked for the object's model (a GLB inside the room's folder, scaled to `size` by the caller)
   * and the result is added to the object's node. The builder never fetches files itself.
   */
  loadModel?: (object: RoomObject) => Promise<THREE.Object3D>;
}

const WALLS: WallName[] = ['north', 'south', 'east', 'west'];

export function buildRoom(room: RoomFile, options: BuildRoomOptions = {}): BuiltRoom {
  const group = new THREE.Group();
  group.name = `room:${room.id}`;
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Map<string, THREE.Material>();
  let disposed = false;

  const material = (color: string, kind: 'lit' | 'flat' = 'lit', side: THREE.Side = THREE.FrontSide) => {
    const key = `${kind}:${color}:${side}`;
    let found = materials.get(key);
    if (!found) {
      found =
        kind === 'flat'
          ? new THREE.MeshBasicMaterial({ color, side })
          : new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0.02, side });
      materials.set(key, found);
    }
    return found;
  };
  const geometry = <T extends THREE.BufferGeometry>(created: T): T => {
    geometries.add(created);
    return created;
  };
  const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material) => {
    const result = new THREE.Mesh(geo, mat);
    result.castShadow = true;
    result.receiveShadow = true;
    return result;
  };

  const { shell } = room;
  const shellGroup = new THREE.Group();
  shellGroup.name = 'shell';
  group.add(shellGroup);

  // Floor and ceiling.
  const floor = mesh(geometry(new THREE.PlaneGeometry(shell.width, shell.depth)), material(shell.floor.color));
  floor.rotation.x = -Math.PI / 2;
  floor.name = 'floor';
  shellGroup.add(floor);
  if (shell.ceiling) {
    const ceiling = mesh(
      geometry(new THREE.PlaneGeometry(shell.width + 2 * WALL_THICKNESS, shell.depth + 2 * WALL_THICKNESS)),
      material(shell.ceiling.color),
    );
    ceiling.rotation.x = Math.PI / 2;
    ceiling.position.y = shell.height;
    ceiling.name = 'ceiling';
    shellGroup.add(ceiling);
  }

  // Walls, built from boxes around each opening.
  for (const wall of WALLS) {
    for (const piece of wallPieces(shell, wall)) {
      const wallMesh = mesh(geometry(new THREE.BoxGeometry(...piece.size)), material(shell.walls.color));
      wallMesh.position.set(...piece.center);
      wallMesh.name = `wall:${wall}`;
      shellGroup.add(wallMesh);
    }
  }

  // Flat colour just behind each window so the room doesn't open onto the void.
  const outsideColor = shell.outside?.color ?? '#9fc4e6';
  for (const opening of shell.openings ?? []) {
    if (opening.kind !== 'window') continue;
    const plane = new THREE.Mesh(
      geometry(new THREE.PlaneGeometry(opening.width + 4, opening.height + 4)),
      material(outsideColor, 'flat'),
    );
    placeOutside(plane, room, opening);
    plane.name = 'outside';
    shellGroup.add(plane);
  }

  // Objects.
  const objectNodes = new Map<string, THREE.Object3D>();
  for (const object of room.objects) {
    const node = new THREE.Group();
    node.name = `object:${object.id}`;
    node.position.set(...object.position);
    node.rotation.y = degToRad(object.rotationY ?? 0);
    node.userData.roomObjectId = object.id;
    for (const part of object.parts ?? []) {
      const partMesh = mesh(geometry(partGeometry(part)), material(part.color));
      partMesh.position.set(...part.offset);
      if (part.rotation) {
        partMesh.rotation.set(degToRad(part.rotation[0]), degToRad(part.rotation[1]), degToRad(part.rotation[2]));
      }
      node.add(partMesh);
    }
    if (object.model?.file && options.loadModel) {
      options
        .loadModel(object)
        .then((model) => {
          if (disposed) return;
          node.add(model);
        })
        .catch((error: unknown) => {
          console.warn('[rooms] could not load model for', object.id, error);
        });
    }
    objectNodes.set(object.id, node);
    group.add(node);
  }

  for (const light of room.lights) group.add(buildLight(light));

  return {
    group,
    objectNodes,
    dispose() {
      disposed = true;
      group.removeFromParent();
      for (const geo of geometries) geo.dispose();
      for (const mat of materials.values()) mat.dispose();
      geometries.clear();
      materials.clear();
      group.clear();
      objectNodes.clear();
    },
  };
}

function partGeometry(part: RoomPart): THREE.BufferGeometry {
  switch (part.shape) {
    case 'box':
      return new THREE.BoxGeometry(...part.size);
    case 'cylinder':
      return new THREE.CylinderGeometry(part.radius, part.radius, part.height, 24);
    case 'sphere':
      return new THREE.SphereGeometry(part.radius, 24, 16);
  }
}

function placeOutside(plane: THREE.Mesh, room: RoomFile, opening: RoomOpening): void {
  const { shell } = room;
  const gap = WALL_THICKNESS + 0.4;
  const y = (opening.sill ?? 0) + opening.height / 2;
  switch (opening.wall) {
    case 'north':
      plane.position.set(opening.offset, y, -shell.depth / 2 - gap);
      break; // faces +Z already
    case 'south':
      plane.position.set(opening.offset, y, shell.depth / 2 + gap);
      plane.rotation.y = Math.PI;
      break;
    case 'east':
      plane.position.set(shell.width / 2 + gap, y, opening.offset);
      plane.rotation.y = -Math.PI / 2;
      break;
    case 'west':
      plane.position.set(-shell.width / 2 - gap, y, opening.offset);
      plane.rotation.y = Math.PI / 2;
      break;
  }
}

function buildLight(light: RoomLight): THREE.Light {
  let result: THREE.Light;
  switch (light.type) {
    case 'ambient':
      result = new THREE.AmbientLight(light.color, light.intensity);
      break;
    case 'hemisphere':
      result = new THREE.HemisphereLight(light.color, light.groundColor ?? '#444444', light.intensity);
      break;
    case 'directional':
      result = new THREE.DirectionalLight(light.color, light.intensity);
      break;
    case 'point':
      result = new THREE.PointLight(light.color, light.intensity, 0, 2);
      break;
  }
  if (light.position) result.position.set(...light.position);
  return result;
}
