/**
 * useSpeechMovement - React hook for integrating speech-driven avatar movements.
 * 
 * This hook orchestrates: 
 * 1. Calling the backend to generate a movement timeline from speech transcript
 * 2. Playing back the timeline using MovementAnimator
 * 3. Managing playback state and configuration
 * 
 * @example
 * const { generateAndPlay, isGenerating, isPlaying, stop } = useSpeechMovement({ 
 *   delayMode: 'short',
 *   delayMs: 300,
 * });
 * 
 * // When speech transcript is available:
 * await generateAndPlay(transcript, speechDuration);
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useAvatarAnimationBus } from '../avatar/animation-bus.js';
import { MovementAnimator } from '../avatar/movement-animator.js';
import type { MovementTimeline } from '../avatar/types.js';
import type { PoseTransitionConfig } from '../avatar/animation-bus.js';
import { getPreloadApi } from '../preload-api.js';

export type SpeechMovementDelayMode = 'none' | 'short' | 'full';

export interface UseSpeechMovementOptions {
    /** Whether the feature is enabled. Default true. */
    enabled?: boolean;
    /** Delay strategy for synchronizing speech with movements. Default 'short'. */
    delayMode?: SpeechMovementDelayMode;
    /** Delay duration in ms when mode is 'short'. Default 300. */
    delayMs?: number;
    /** Duration for pose transitions. Default 0.5 seconds. */
    transitionDuration?: number;
    /** Configuration for easing and staggering. */
    transitionConfig?: PoseTransitionConfig;
    /** Callback when timeline generation completes. */
    onTimelineGenerated?: (timeline: MovementTimeline) => void;
    /** Callback when playback completes. */
    onPlaybackComplete?: () => void;
    /** Callback on error. */
    onError?: (error: Error) => void;
}

export interface UseSpeechMovementResult {
    /** Generate timeline from transcript and immediately play it. */
    generateAndPlay: (transcript: string, speechDuration?: number) => Promise<{
        timeline: MovementTimeline;
        startPlayback: () => void;
    }>;
    /** Generate timeline without playing. */
    generateTimeline: (transcript: string, speechDuration?: number) => Promise<MovementTimeline>;
    /** Play a previously generated timeline. */
    playTimeline: (timeline: MovementTimeline) => void;
    /** Stop current playback. */
    stop: () => void;
    /** Pause current playback. */
    pause: () => void;
    /** Resume paused playback. */
    resume: () => void;
    /** Whether currently generating a timeline. */
    isGenerating: boolean;
    /** Whether currently playing. */
    isPlaying: boolean;
    /** Current timeline if any. */
    currentTimeline: MovementTimeline | null;
    /** Whether the feature is available (API exists). */
    isAvailable: boolean;
}

/**
 * Hook for speech-driven avatar movements.
 */
export function useSpeechMovement(options: UseSpeechMovementOptions = {}): UseSpeechMovementResult {
    const {
        enabled = true,
        transitionDuration = 0.5,
        transitionConfig,
        onTimelineGenerated,
        onPlaybackComplete,
        onError,
    } = options;

    const bus = useAvatarAnimationBus();
    const animatorRef = useRef<MovementAnimator | null>(null);

    const [isGenerating, setIsGenerating] = useState(false);
    const [isPlaying, setIsPlaying] = useState(false);
    const [currentTimeline, setCurrentTimeline] = useState<MovementTimeline | null>(null);

    // Check if API is available - use getPreloadApi for proper typing
    const getAvatarBridge = () => {
        const api = getPreloadApi();
        if (!api?.avatar?.generateMovementTimeline) {
            return null;
        }
        return api.avatar;
    };

    // isAvailable only checks if the API is ready - bus is needed for playback but not availability
    const isAvailable = Boolean(enabled && getAvatarBridge());

    // Debug logging - only on mount
    useEffect(() => {
        const api = getPreloadApi();
        console.info('[useSpeechMovement] Hook initialized:', {
            enabled,
            hasBus: !!bus,
            hasApi: !!api,
            hasAvatar: !!api?.avatar,
            hasGenerateMovementTimeline: !!api?.avatar?.generateMovementTimeline,
            isAvailable,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);  // Only run once on mount

    const generateTimeline = useCallback(async (
        transcript: string,
        speechDuration?: number
    ): Promise<MovementTimeline> => {
        const avatar = getAvatarBridge();
        if (!isAvailable || !avatar || !avatar.generateMovementTimeline) {
            throw new Error('Speech movement API is not available');
        }

        setIsGenerating(true);
        try {
            const timeline = await avatar.generateMovementTimeline({
                transcript,
                speechDuration,
            });
            setCurrentTimeline(timeline);
            onTimelineGenerated?.(timeline);
            return timeline;
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            onError?.(err);
            throw err;
        } finally {
            setIsGenerating(false);
        }
    }, [isAvailable, onTimelineGenerated, onError]);

    const playTimeline = useCallback((timeline: MovementTimeline) => {
        console.info('[useSpeechMovement] playTimeline called', {
            hasTimeline: !!timeline,
            keyframeCount: timeline?.keyframes?.length ?? 0,
            duration: timeline?.duration ?? 0,
            hasBus: !!bus,
        });

        if (!bus) {
            console.warn('[useSpeechMovement] Cannot play: animation bus not available');
            return;
        }

        // Stop any existing playback
        if (animatorRef.current) {
            animatorRef.current.stop();
        }

        // Create new animator
        animatorRef.current = new MovementAnimator({
            bus,
            timeline,
            transitionDuration,
            transitionConfig,
            onComplete: () => {
                console.info('[useSpeechMovement] Playback complete');
                setIsPlaying(false);
                onPlaybackComplete?.();
            },
        });

        setIsPlaying(true);
        console.info('[useSpeechMovement] Starting playback...');
        animatorRef.current.play();
    }, [bus, transitionDuration, transitionConfig, onPlaybackComplete]);

    const generateAndPlay = useCallback(async (
        transcript: string,
        speechDuration?: number
    ) => {
        const timeline = await generateTimeline(transcript, speechDuration);

        return {
            timeline,
            startPlayback: () => playTimeline(timeline),
        };
    }, [generateTimeline, playTimeline]);

    const stop = useCallback(() => {
        if (animatorRef.current) {
            animatorRef.current.stop();
            setIsPlaying(false);
        }
    }, []);

    const pause = useCallback(() => {
        if (animatorRef.current) {
            animatorRef.current.pause();
            setIsPlaying(false);
        }
    }, []);

    const resume = useCallback(() => {
        if (animatorRef.current) {
            animatorRef.current.play();
            setIsPlaying(true);
        }
    }, []);

    return {
        generateAndPlay,
        generateTimeline,
        playTimeline,
        stop,
        pause,
        resume,
        isGenerating,
        isPlaying,
        currentTimeline,
        isAvailable,
    };
}
