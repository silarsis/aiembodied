import { useEffect, useMemo, useState } from 'react';
import type { WakeWordBridge } from '../preload-api.js';

type ListeningPhase = 'off' | 'on' | 'starting' | 'stopping' | 'error';

/** Acknowledge microphone release before displaying off; stale replies cannot undo newer intent. */
export function useWakeWordListening(bridge: WakeWordBridge | undefined, enabled: boolean) {
  const request = useMemo(() => ({ bridge, enabled }), [bridge, enabled]);
  const [acknowledgement, setAcknowledgement] = useState<{
    request: typeof request;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (!request.bridge?.setListeningEnabled) return;
    void request.bridge
      .setListeningEnabled(request.enabled)
      .then(() => {
        if (!cancelled) setAcknowledgement({ request, error: null });
      })
      .catch((error: unknown) => {
        if (!cancelled)
          setAcknowledgement({
            request,
            error: `Could not ${request.enabled ? 'start' : 'stop'} listening: ${error instanceof Error ? error.message : String(error)}`,
          });
      });
    return () => {
      cancelled = true;
    };
  }, [request]);

  useEffect(
    () => () => {
      void bridge?.setListeningEnabled?.(false).catch((error: unknown) => {
        console.error('Failed to stop wake-word capture after renderer cleanup', error);
      });
    },
    [bridge],
  );
  const acknowledged = acknowledgement?.request === request;
  const error = acknowledged ? acknowledgement.error : null;
  const phase: ListeningPhase = error
    ? 'error'
    : acknowledged || !bridge?.setListeningEnabled
      ? enabled
        ? 'on'
        : 'off'
      : enabled
        ? 'starting'
        : 'stopping';
  return { phase, error };
}
