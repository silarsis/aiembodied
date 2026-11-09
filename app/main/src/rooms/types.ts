/**
 * 3D room scene format. Metres, Y up. The avatar faces +Z at facing 0 and the default camera
 * sits on +Z looking back at it. A facing angle theta (degrees) points along (sin theta, 0, cos theta).
 */
export type Vec3 = [number, number, number];

export interface RoomOpening {
  wall: 'north' | 'south' | 'east' | 'west';
  kind: 'window' | 'door';
  /** Centre along the wall, measured from the wall centre, metres. */
  offset: number;
  width: number;
  height: number;
  /** Bottom height of a window. */
  sill?: number;
}

export interface RoomShell {
  /** Floor is centred on the origin; x = width, z = depth. */
  width: number;
  depth: number;
  height: number;
  floor: { color: string };
  walls: { color: string };
  ceiling?: { color: string } | null;
  openings?: RoomOpening[];
  /** Colour seen through windows. */
  outside?: { color: string };
}

export type PartShape =
  | { shape: 'box'; size: Vec3 }
  | { shape: 'cylinder'; radius: number; height: number }
  | { shape: 'sphere'; radius: number };

export type RoomPart = PartShape & {
  /** Relative to the object origin (the floor contact centre). */
  offset: Vec3;
  color: string;
  /** Degrees. */
  rotation?: Vec3;
};

export interface SitTag {
  position: Vec3;
  /** Degrees, 0 = +Z. */
  facing: number;
}
export interface StandTag {
  position: Vec3;
  facing: number;
}
export interface RoomObjectTags {
  sit?: SitTag;
  stand?: StandTag;
  grab?: { position: Vec3 };
  surface?: { height: number };
  look?: { position: Vec3 };
  idle?: string;
}

export interface RoomModelRef {
  file: string;
  /** Asset-cache folder, e.g. "polyhaven/ArmChair_01" or "generated/rocking-chair-3fa91c2e". */
  asset?: string;
  /** Uniform scale applied to the model as downloaded. */
  scale?: number;
}

export interface RoomObject {
  /** Slug, unique within the room. */
  id: string;
  /** Human name, e.g. "armchair". */
  name: string;
  description?: string;
  /** World position in metres; y is the floor contact. */
  position: Vec3;
  /** Degrees. */
  rotationY?: number;
  /** Bounding box width, height, depth in metres (colliders and navmesh obstacles). */
  size: Vec3;
  parts?: RoomPart[];
  /**
   * A 3D model for the object. With `asset` ("polyhaven/<id>" or "generated/<folder>") the file is relative to that folder
   * of the asset cache and `scale` is the uniform scale that makes it match `size`; without it,
   * the file is relative to the room's folder (reserved, never fetched).
   */
  model?: RoomModelRef | null;
  /** Default 'box'. */
  collider?: 'box' | 'none';
  /** Small props that physics can move. Default false. */
  dynamic?: boolean;
  /** Tag positions are in object-local space and rotate with the object. */
  tags?: RoomObjectTags;
}

export interface RoomLight {
  type: 'ambient' | 'directional' | 'point' | 'hemisphere';
  color: string;
  intensity: number;
  position?: Vec3;
  groundColor?: string;
}

export interface RoomCamera {
  position: Vec3;
  target: Vec3;
  fov: number;
}

export interface RoomFile {
  version: 1;
  id: string;
  name: string;
  description?: string;
  shell: RoomShell;
  lights: RoomLight[];
  camera: RoomCamera;
  /** Where the avatar stands for conversation, normally facing the camera. */
  home: { position: Vec3; facing: number };
  objects: RoomObject[];
}

export interface RoomSummary {
  id: string;
  name: string;
  builtIn: boolean;
  description?: string;
}

/** What the renderer asks the "Idle thoughts" model: the whole prompt, built in the renderer. */
export interface IdlePickContext {
  system: string;
  user: string;
}

/** The model's reply (action tags as text), or null when it could not be reached or answered nothing. */
export interface IdlePickResult {
  text: string;
}
