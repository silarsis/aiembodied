import { PresenceTracker, isVoicePhase } from './presence.js';
import { PlacePresence } from './place-presence.js';
import type { HandleIpc } from '../ipc/handle-ipc.js';

export interface PresenceIpcOptions {
  handle: HandleIpc;
  presence: PresenceTracker;
  placePresence: PlacePresence;
  placeOf: (event: unknown) => string;
  localPlaceId: () => string;
}

export function registerPresenceIpc(options: PresenceIpcOptions): void {
  const { handle, presence, placePresence, placeOf, localPlaceId } = options;

  handle('presence:update', (event, payload: unknown) => {
    const p = (typeof payload === 'object' && payload !== null ? payload : {}) as Record<
      string,
      unknown
    >;
    // A desktop room reports its own presence; bija's is left alone.
    const from = placeOf(event);
    if (from !== localPlaceId()) {
      // The face time is stamped with this PC's clock on arrival: a satellite's clock may differ, and the report is at most seconds old.
      placePresence.update(
        from,
        typeof p.faceSeenAt === 'number' ? { ...p, faceSeenAt: Date.now() } : p,
      );
      return true;
    }
    presence.update({
      listening: typeof p.listening === 'boolean' ? p.listening : undefined,
      voicePhase: isVoicePhase(p.voicePhase) ? p.voicePhase : undefined,
      faceSeenAt: typeof p.faceSeenAt === 'number' ? p.faceSeenAt : undefined,
      lastUserSpeechAt: typeof p.userSpokeAt === 'number' ? p.userSpokeAt : undefined,
      lastAssistantSpokeAt: typeof p.assistantSpokeAt === 'number' ? p.assistantSpokeAt : undefined,
    });
    return true;
  });
  handle('presence:get-dnd', () => presence.doNotDisturb);
  handle('presence:set-dnd', (_event, enabled: unknown) => {
    presence.update({ doNotDisturb: enabled === true });
    return presence.doNotDisturb;
  });
}
