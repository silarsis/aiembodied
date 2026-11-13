/**
 * Who is on this screen. The main process keeps the truth about where each avatar is (see
 * main/src/places); the renderer turns its snapshot into three lists:
 * - present: at this screen's place and not walking between places. They are on stage.
 * - incoming: walking here. Their body is loaded out of sight until the place lets them in.
 * - absent: everyone else, for the "Elsewhere" chip.
 * Without a snapshot (no bridge, or not read yet) everybody is present, as before places existed.
 */
import type { PlacesSnapshot } from '../../../main/src/places/place-manager.js';

export interface AbsentAvatar {
  id: string;
  /** 'away' is at another place; 'arriving' is on the way here; 'leaving' is on the way to another place. */
  state: 'away' | 'arriving' | 'leaving';
  /** The place it is at, or the one it is heading to. */
  placeId: string;
}

export interface StagePresence {
  present: string[];
  incoming: string[];
  absent: AbsentAvatar[];
}

export function stagePresence(snapshot: PlacesSnapshot | null | undefined, avatarIds: readonly string[]): StagePresence {
  if (!snapshot) return { present: [...avatarIds], incoming: [], absent: [] };
  const local = snapshot.localPlaceId;
  const moving = new Map(snapshot.transit.map((entry) => [entry.avatarId, entry]));
  const result: StagePresence = { present: [], incoming: [], absent: [] };
  for (const id of avatarIds) {
    const move = moving.get(id);
    if (move) {
      if (move.to === local) {
        result.incoming.push(id);
        result.absent.push({ id, state: 'arriving', placeId: move.to });
      } else {
        result.absent.push({ id, state: 'leaving', placeId: move.to });
      }
    } else {
      const placeId = snapshot.locations[id] ?? local;
      if (placeId === local) result.present.push(id);
      else result.absent.push({ id, state: 'away', placeId });
    }
  }
  return result;
}

/** One line for the Elsewhere chip: "Echo is next door", "Sage is on the way to the lounge". */
export function describeAbsent(entry: AbsentAvatar, nameOfAvatar: string, snapshot: PlacesSnapshot): string {
  const place = snapshot.places.find((candidate) => candidate.id === entry.placeId)?.name ?? entry.placeId;
  return entry.state === 'away' ? `${nameOfAvatar} is ${place}` : `${nameOfAvatar} is on the way to ${place}`;
}

/** Roughly how long a line takes to say, for hiding an avatar once it has finished talking (2D, where no clock tells). */
export function estimateSpeechMs(text: string): number {
  const spoken = text.replace(/\{[^}]*\}/g, ' ').replace(/\s+/g, ' ').trim();
  // About 15 characters a second; never longer than the longest sentence is likely to take.
  return Math.min(8000, Math.round((spoken.length / 15) * 1000));
}
