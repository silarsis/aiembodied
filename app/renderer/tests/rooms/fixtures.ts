import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { RoomFile } from '../../../main/src/rooms/types.js';
import { validateRoomFile } from '../../../main/src/rooms/validate.js';

export function builtInRoom(stem: 'reading-room' | 'studio-flat'): RoomFile {
  const file = path.resolve(__dirname, '../../../main/assets/rooms', `${stem}.json`);
  return validateRoomFile(JSON.parse(readFileSync(file, 'utf8')));
}
