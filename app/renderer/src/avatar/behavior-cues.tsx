import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { getPreloadApi } from '../preload-api.js';

export type BehaviorCueName = 'greet_face';

export type BehaviorCueSource = 'camera';

export interface CameraDetectionEvent {
  cue: string;
  timestamp?: number;
  confidence?: number;
  provider?: string;
  payload?: Record<string, unknown> | null;
}

export interface BehaviorCueEvent {
  name: BehaviorCueName;
  source: BehaviorCueSource;
  timestamp: number;
  confidence?: number;
  provider?: string;
  raw: CameraDetectionEvent;
}

type BehaviorCueListener = (event: BehaviorCueEvent) => void;

type Unsubscribe = () => void;

class BehaviorCueBus {
  private readonly listeners = new Set<BehaviorCueListener>();

  emit(event: BehaviorCueEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[behavior-cues] listener threw an error', error);
      }
    }
  }

  subscribe(listener: BehaviorCueListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const BehaviorCueContext = createContext<BehaviorCueBus | null>(null);

function normalizeCameraEvent(event: CameraDetectionEvent | null | undefined): BehaviorCueEvent | null {
  if (!event || typeof event.cue !== 'string') {
    return null;
  }

  const cueName = event.cue.trim();
  if (cueName !== 'greet_face') {
    console.debug('[behavior-cues] ignoring unsupported camera cue', { cue: cueName });
    return null;
  }

  const timestamp = typeof event.timestamp === 'number' && Number.isFinite(event.timestamp)
    ? event.timestamp
    : Date.now();

  return {
    name: 'greet_face',
    source: 'camera',
    timestamp,
    confidence: typeof event.confidence === 'number' ? event.confidence : undefined,
    provider: typeof event.provider === 'string' ? event.provider : undefined,
    raw: event,
  };
}

export interface BehaviorCueProviderProps {
  children: ReactNode;
}

export function BehaviorCueProvider({ children }: BehaviorCueProviderProps) {
  const bus = useMemo(() => new BehaviorCueBus(), []);

  useEffect(() => {
    const bridge = getPreloadApi();
    const cameraBridge = bridge?.camera;
    if (!cameraBridge?.onDetection) {
      console.warn('[behavior-cues] camera detection bridge is unavailable.');
      return;
    }

    const unsubscribe = cameraBridge.onDetection((event) => {
      const normalized = normalizeCameraEvent(event);
      if (normalized) {
        bus.emit(normalized);
      }
    });

    return () => {
      try {
        unsubscribe?.();
      } catch (error) {
        console.warn('[behavior-cues] failed to unsubscribe from camera detections', error);
      }
    };
  }, [bus]);

  return <BehaviorCueContext.Provider value={bus}>{children}</BehaviorCueContext.Provider>;
}

export function useBehaviorCues(listener: BehaviorCueListener | null | undefined) {
  const bus = useContext(BehaviorCueContext);

  useEffect(() => {
    if (!bus || !listener) {
      return;
    }

    return bus.subscribe(listener);
  }, [bus, listener]);
}

export function useBehaviorCueBus(): BehaviorCueBus | null {
  return useContext(BehaviorCueContext);
}
