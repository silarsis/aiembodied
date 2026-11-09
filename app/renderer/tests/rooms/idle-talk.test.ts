import { beforeAll, describe, expect, it } from 'vitest';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { RoomStage } from '../../src/rooms/room-stage.js';
import { HOME_DISTANCE, TURN_THRESHOLD, talkStartActions } from '../../src/rooms/idle-talk.js';
import { INITIAL_STATE, type AvatarState, type PlanWorld } from '../../src/rooms/scene-actions.js';
import { builtInRoom } from './fixtures.js';

let room: RoomFile;
beforeAll(async () => {
  room = builtInRoom('reading-room');
  await RoomStage.create(room);
});

function world(x: number, z: number, yawDeg: number): PlanWorld {
  return {
    room,
    hasNavigation: true,
    findPath: () => null,
    closestWalkable: (p) => p,
    objectPosition: () => null,
    frame: { origin: { x, z, yaw: (yawDeg * Math.PI) / 180 }, scale: 1 },
    restHipsHeight: 0.95,
  };
}
const seated: AvatarState = { posture: 'seated', held: null, seat: { objectId: 'sofa', session: 's', frame: { origin: { x: 0, z: 0, yaw: 0 }, scale: 1 }, approach: [0, 0, 0], facing: 0 } };

describe('talkStartActions', () => {
  it('come back: walks home when more than a metre away, stands first when seated', () => {
    const home = room.home.position;
    expect(talkStartActions('come-back', world(home[0], home[2] + HOME_DISTANCE - 0.1, 0), INITIAL_STATE)).toEqual([]);
    expect(talkStartActions('come-back', world(-2, -1.5, 0), INITIAL_STATE)).toEqual([{ kind: 'come' }]);
    expect(talkStartActions('come-back', world(home[0], home[2], 0), seated)).toEqual([{ kind: 'stand' }, { kind: 'come' }]);
  });

  it('turn to me: looks at the camera only when facing more than 30 degrees away', () => {
    // The camera is at (0, 2.1); standing at (-2, -1) it is towards +x, +z: bearing about 32 degrees.
    const toCamera = (Math.atan2(2, 3.1) * 180) / Math.PI;
    expect(talkStartActions('turn', world(-2, -1, toCamera + 10), INITIAL_STATE)).toEqual([]);
    const away = talkStartActions('turn', world(-2, -1, toCamera + 40), INITIAL_STATE);
    expect(away).toEqual([{ kind: 'lookAtPoint', position: room.camera.position, label: 'the camera' }]);
    expect(talkStartActions('turn', world(-2, -1, toCamera - 40), INITIAL_STATE)).toHaveLength(1);
    expect(TURN_THRESHOLD).toBeCloseTo(Math.PI / 6);
  });

  it('turn to me leaves a seated avatar seated', () => {
    expect(talkStartActions('turn', world(0, 0, 180), seated)).toEqual([]);
  });
});
