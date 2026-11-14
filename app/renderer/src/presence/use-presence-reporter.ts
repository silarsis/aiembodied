import { useCallback, useEffect, useRef } from 'react';
import type { PresenceBridge, PresenceUpdatePayload } from '../../../main/src/presence/bridge-types.js';
import type { CameraBridge } from '../preload-api.js';

export const PRESENCE_THROTTLE_MS = 1000;
export const FACE_REPORT_MS = 5000;

/** A greeting that bija sent for an avatar that walked in (it carries the avatar's id). It is not a sighting. */
function isArrivalGreeting(event: { provider?: string; payload?: Record<string, unknown> | null }): boolean {
  return event.provider === 'arrival' || typeof event.payload?.avatarId === 'string';
}

/**
 * Tells main whether the mic is on, which voice phase we are in and when the camera last saw a
 * face, so Echo's decision step knows if Kevin is around. Changes are sent at most once a second.
 */
export function usePresenceReporter(
  api: PresenceBridge | undefined,
  camera: CameraBridge | undefined,
  state: { listening: boolean; voicePhase: NonNullable<PresenceUpdatePayload['voicePhase']> },
): { reportFace: (at: number) => void } {
  const last = useRef<string>('');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSentAt = useRef(0);
  const pending = useRef<PresenceUpdatePayload | null>(null);

  const apiRef = useRef(api);
  useEffect(() => {
    apiRef.current = api;
  }, [api]);

  const send = useCallback((payload: PresenceUpdatePayload) => {
    if (!apiRef.current) return;
    pending.current = { ...pending.current, ...payload };
    if (timer.current) return;
    const wait = Math.max(0, PRESENCE_THROTTLE_MS - (Date.now() - lastSentAt.current));
    timer.current = setTimeout(() => {
      timer.current = null;
      const body = pending.current;
      pending.current = null;
      lastSentAt.current = Date.now();
      if (body && apiRef.current) void Promise.resolve(apiRef.current.update(body)).catch(() => undefined);
    }, wait);
  }, []);

  useEffect(() => {
    const key = `${state.listening}|${state.voicePhase}`;
    if (key === last.current) return;
    last.current = key;
    send({ listening: state.listening, voicePhase: state.voicePhase });
  }, [send, state.listening, state.voicePhase]);

  // The camera reports a face directly (already throttled); the rest of the page just forwards it.
  const reportFace = useCallback((at: number) => send({ faceSeenAt: at }), [send]);

  useEffect(() => {
    if (!api || !camera?.onDetection) return undefined;
    let lastFace = 0;
    const unsubscribe = camera.onDetection((event) => {
      if (event?.cue !== 'greet_face' || isArrivalGreeting(event)) return;
      const at = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp) ? event.timestamp : Date.now();
      if (at - lastFace < FACE_REPORT_MS) return;
      lastFace = at;
      send({ faceSeenAt: at });
    });
    return () => {
      try {
        unsubscribe?.();
      } catch {
        // ignore
      }
    };
  }, [api, camera, send]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return { reportFace };
}
