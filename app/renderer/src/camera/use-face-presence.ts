import { useCallback, useEffect, useRef, useState } from 'react';
import type { CameraBridge } from '../preload-api.js';
import type { CameraDetectionEvent } from '../avatar/behavior-cues.js';
import { FacePresence, type FacePresenceDeps } from './face-presence.js';
import { createMediapipeDetector } from './mediapipe-detector.js';

export interface UseFacePresenceOptions {
  /** The camera runs only while this is true. The caller derives it from the privacy gate and the place's setting. */
  enabled: boolean;
  /** The camera Kevin picked, or empty for the default. */
  deviceId?: string;
  camera: CameraBridge | undefined;
  /** A face is in view (throttled): the presence reporter sends it to bija. */
  onFaceSeen?: (at: number) => void;
  /** Replaces the real camera and detector (tests). */
  makeDeps?: (base: Pick<FacePresenceDeps, 'emit' | 'onFaceSeen' | 'onLive'>) => FacePresenceDeps;
}

export interface UseFacePresenceResult {
  /** The camera is open and looking. */
  live: boolean;
  /** Why it is not running although it was asked to, in words. Null otherwise. */
  error: string | null;
  /** Stops and releases the camera now, without waiting for a render. The privacy gate calls this the moment it closes. */
  stopNow: () => Promise<void>;
}

/**
 * Runs `FacePresence` while `enabled`. Turning `enabled` off, changing the camera and unmounting all stop it and
 * release the camera. If the camera cannot start (no camera, the gate said no, the model is missing) the reason is
 * logged and `error` says why; it never throws into the page.
 */
export function useFacePresence({ enabled, deviceId, camera, onFaceSeen, makeDeps }: UseFacePresenceOptions): UseFacePresenceResult {
  const [live, setLive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const presenceRef = useRef<FacePresence | null>(null);
  const onFaceSeenRef = useRef(onFaceSeen);
  const cameraRef = useRef(camera);
  const makeDepsRef = useRef(makeDeps);
  useEffect(() => {
    onFaceSeenRef.current = onFaceSeen;
    cameraRef.current = camera;
    makeDepsRef.current = makeDeps;
  }, [onFaceSeen, camera, makeDeps]);

  const instance = useCallback((): FacePresence => {
    if (!presenceRef.current) {
      const base = {
        emit: (event: CameraDetectionEvent) => cameraRef.current?.emitDetection(event),
        onFaceSeen: (at: number) => onFaceSeenRef.current?.(at),
        onLive: (next: boolean) => setLive(next),
      };
      const deps: FacePresenceDeps = makeDepsRef.current?.(base) ?? {
        ...base,
        getStream: (constraints) => navigator.mediaDevices.getUserMedia(constraints),
        createVideo: () => document.createElement('video'),
        createDetector: createMediapipeDetector,
        logger: console,
      };
      presenceRef.current = new FacePresence(deps);
    }
    return presenceRef.current;
  }, []);

  const stopNow = useCallback(async () => {
    presenceRef.current?.stop();
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    const presence = instance();
    let cancelled = false;
    void presence.start(deviceId || undefined).then((result) => {
      if (cancelled) return;
      setError(result.ok ? null : result.reason);
    });
    return () => {
      cancelled = true;
      presence.stop();
      setError(null);
    };
  }, [enabled, deviceId, instance]);

  return { live: enabled && live, error: enabled ? error : null, stopNow };
}
