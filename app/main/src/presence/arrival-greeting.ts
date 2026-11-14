/**
 * When an avatar walks into a place and a face was seen there a moment ago, it waves. The camera cue
 * (`greet_face`) carries the avatar's id, so any avatar can wave, not only Echo. The cue is sent to the screen
 * that draws the place: bija's window, or the desktop room's link. Nothing else about the face is used.
 */
import { FACE_FRESH_MS } from './place-presence.js';

export interface ArrivalGreetingDeps {
  /** When a face was last seen at a place (bija's clock), or null. */
  faceSeenAt: (placeId: string) => number | null;
  /** Sends the camera cue to the screen that shows the avatar. */
  send: (avatarId: string, payload: { cue: 'greet_face'; timestamp: number; confidence: number; provider: string; payload: { avatarId: string; origin: string } }) => void;
  now?: () => number;
  freshMs?: number;
}

/** Returns the arrival listener. It answers true when it sent a greeting. */
export function createArrivalGreeting(deps: ArrivalGreetingDeps): (avatarId: string, placeId: string) => boolean {
  return (avatarId, placeId) => {
    const now = (deps.now ?? Date.now)();
    const seen = deps.faceSeenAt(placeId);
    if (seen === null || now - seen > (deps.freshMs ?? FACE_FRESH_MS)) return false;
    deps.send(avatarId, { cue: 'greet_face', timestamp: now, confidence: 1, provider: 'arrival', payload: { avatarId, origin: 'places:arrival' } });
    return true;
  };
}
