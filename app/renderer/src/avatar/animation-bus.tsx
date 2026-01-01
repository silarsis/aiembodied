import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';

export type AvatarAnimationIntent = 'play' | 'pose';

export interface AvatarAnimationTiming {
  startAt?: number;
  onStart?: (startAt: number) => void;
}

export interface VRMPoseData {
  [boneName: string]: { rotation: number[]; position?: number[] };
}

export interface AvatarAnimationRequest {
  slug: string;
  intent: AvatarAnimationIntent;
  source?: string;
  timing?: AvatarAnimationTiming;
}

export type AvatarAnimationEvent =
  | { type: 'enqueue'; request: AvatarAnimationRequest }
  | { type: 'applyPose'; pose: VRMPoseData; source?: string }
  | { type: 'response' };

type AnimationListener = (event: AvatarAnimationEvent) => void;

type Unsubscribe = () => void;

export interface AvatarAnimationBus {
  enqueue(request: AvatarAnimationRequest): void;
  applyPose(pose: VRMPoseData, source?: string): void;
  signalResponse(): void;
  subscribe(listener: AnimationListener): Unsubscribe;
}

class AnimationBus implements AvatarAnimationBus {
  private readonly listeners = new Set<AnimationListener>();

  enqueue(request: AvatarAnimationRequest) {
    this.emit({ type: 'enqueue', request });
  }

  applyPose(pose: VRMPoseData, source?: string) {
    this.emit({ type: 'applyPose', pose, source });
  }

  signalResponse() {
    this.emit({ type: 'response' });
  }

  subscribe(listener: AnimationListener): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AvatarAnimationEvent) {
    for (const listener of [...this.listeners]) {
      try {
        listener(event);
      } catch (error) {
        console.error('[avatar-animation-bus] listener threw an error', error);
      }
    }
  }
}

const AnimationBusContext = createContext<AvatarAnimationBus | null>(null);

export interface AnimationBusProviderProps {
  children: ReactNode;
  bus?: AvatarAnimationBus;
}

export function createAvatarAnimationBus(): AvatarAnimationBus {
  return new AnimationBus();
}

export function AnimationBusProvider({ children, bus }: AnimationBusProviderProps) {
  const resolvedBus = useMemo(() => bus ?? new AnimationBus(), [bus]);
  return <AnimationBusContext.Provider value={resolvedBus}>{children}</AnimationBusContext.Provider>;
}

export function useAvatarAnimationBus(): AvatarAnimationBus | null {
  return useContext(AnimationBusContext);
}

export function useAvatarAnimationQueue(listener: AnimationListener | null | undefined) {
  const bus = useContext(AnimationBusContext);

  useEffect(() => {
    if (!bus || !listener) {
      return;
    }

    return bus.subscribe(listener);
  }, [bus, listener]);
}
