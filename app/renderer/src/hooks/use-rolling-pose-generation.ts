/**
 * Hook for rolling window pose generation.
 * 
 * Instead of waiting for the full transcript, this hook:
 * 1. Collects text for an initial 500ms window
 * 2. Triggers single pose generation
 * 3. Applies 1 second refractory period
 * 4. Continues generating poses every ~1 second during speech
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvatarAnimationBus } from '../avatar/animation-bus.js';
import type { SinglePoseResult, StreamingPoseRequest } from '../avatar/types.js';
import { getPreloadApi } from '../preload-api.js';

export interface UseRollingPoseOptions {
    /** Whether the hook is enabled */
    enabled?: boolean;
    /** Animation bus for applying poses */
    bus: AvatarAnimationBus | null;
    /** Transition duration when applying poses */
    transitionDuration?: number;
    /** Initial window duration in ms (default: 500) */
    initialWindowMs?: number;
    /** Refractory period in ms (default: 1000) */
    refractoryMs?: number;
    /** Callback when a pose is generated */
    onPoseGenerated?: (result: SinglePoseResult) => void;
    /** Callback on error */
    onError?: (error: Error) => void;
}

export interface UseRollingPoseResult {
    /** Whether the API is available */
    isAvailable: boolean;
    /** Whether currently generating a pose */
    isGenerating: boolean;
    /** Process incoming text content from speech stream */
    processText: (text: string) => void;
    /** Reset state (e.g., when speech ends or session restarts) */
    reset: () => void;
    /** Current accumulated transcript */
    transcript: string;
}

export function useRollingPoseGeneration(options: UseRollingPoseOptions): UseRollingPoseResult {
    const {
        enabled = true,
        bus,
        transitionDuration = 0.5,
        initialWindowMs = 500,
        refractoryMs = 1000,
        onPoseGenerated,
        onError,
    } = options;

    // State
    const [isGenerating, setIsGenerating] = useState(false);
    const [transcript, setTranscript] = useState('');

    // Refs for timing
    const fullTranscriptRef = useRef<string>('');
    const currentWindowRef = useRef<string>('');
    const windowStartTimeRef = useRef<number | null>(null);
    const initialWindowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const refractoryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const isInRefractoryRef = useRef(false);
    const pendingGenerationRef = useRef(false);

    // Check API availability
    const getAvatarBridge = useCallback(() => {
        const api = getPreloadApi();
        if (!api?.avatar?.generateSinglePose) {
            return null;
        }
        return api.avatar;
    }, []);

    const isAvailable = enabled && !!bus && !!getAvatarBridge();

    // Debug log on mount
    useEffect(() => {
        const api = getPreloadApi();
        console.info('[useRollingPose] Hook initialized:', {
            enabled,
            hasBus: !!bus,
            hasGenerateSinglePose: !!api?.avatar?.generateSinglePose,
            isAvailable,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);  // Intentionally run only on mount

    // Generate a single pose
    const generatePose = useCallback(async () => {
        const avatar = getAvatarBridge();
        if (!avatar || !bus) {
            console.warn('[useRollingPose] Cannot generate: API or bus not available');
            return;
        }

        const recentText = currentWindowRef.current.trim();
        if (!recentText) {
            console.debug('[useRollingPose] No recent text to process');
            return;
        }

        // Clear current window but keep full context
        currentWindowRef.current = '';

        setIsGenerating(true);
        const startTime = performance.now();
        console.info(`[useRollingPose] 🎯 Generating pose for: recentText="${recentText.slice(0, 100)}..." (${recentText.length} chars), context=${fullTranscriptRef.current.length} chars`);

        try {
            const request: StreamingPoseRequest = {
                recentText,
                fullContext: fullTranscriptRef.current,
            };

            if (!avatar.generateSinglePose) {
                throw new Error('generateSinglePose not available');
            }
            const result = await avatar.generateSinglePose(request);
            const elapsed = Math.round(performance.now() - startTime);

            console.info(`[useRollingPose] ✅ Pose generated in ${elapsed}ms: emotion="${result.emotion}", bones=${Object.keys(result.pose.bones).length}`);

            // Apply the pose to the avatar
            if (result.pose && Object.keys(result.pose.bones).length > 0) {
                bus.applyPose(result.pose, 'rolling-pose', transitionDuration);
                console.debug('[useRollingPose] Pose applied to avatar');
            }

            onPoseGenerated?.(result);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.warn('[useRollingPose] ❌ Generation failed:', err.message);
            onError?.(err);
        } finally {
            setIsGenerating(false);
        }
    }, [bus, getAvatarBridge, transitionDuration, onPoseGenerated, onError]);

    // Trigger pose generation with refractory handling
    const triggerGeneration = useCallback(() => {
        if (isInRefractoryRef.current) {
            // In refractory period, mark that we have pending text
            pendingGenerationRef.current = currentWindowRef.current.length > 0;
            console.debug('[useRollingPose] In refractory, pending:', pendingGenerationRef.current);
            return;
        }

        // Generate pose
        generatePose();

        // Start refractory period
        isInRefractoryRef.current = true;
        refractoryTimerRef.current = setTimeout(() => {
            isInRefractoryRef.current = false;

            // If we accumulated text during refractory, trigger another generation
            if (pendingGenerationRef.current && currentWindowRef.current.length > 0) {
                console.debug('[useRollingPose] Refractory ended, triggering pending generation');
                pendingGenerationRef.current = false;
                triggerGeneration();
            }
        }, refractoryMs);
    }, [generatePose, refractoryMs]);

    // Process incoming text
    const processText = useCallback((text: string) => {
        if (!isAvailable || !text.trim()) {
            return;
        }

        // Accumulate text
        fullTranscriptRef.current += text;
        currentWindowRef.current += text;
        setTranscript(fullTranscriptRef.current);

        console.debug(`[useRollingPose] Text received: "${text.slice(0, 30)}..." (${text.length} chars, window=${currentWindowRef.current.length} chars)`);

        // If this is the first text, start the initial window timer
        if (windowStartTimeRef.current === null) {
            windowStartTimeRef.current = Date.now();

            console.debug('[useRollingPose] Starting initial window timer:', initialWindowMs);
            initialWindowTimerRef.current = setTimeout(() => {
                console.debug('[useRollingPose] Initial window complete, triggering generation');
                triggerGeneration();
            }, initialWindowMs);
        }
    }, [isAvailable, initialWindowMs, triggerGeneration]);

    // Reset state
    const reset = useCallback(() => {
        console.debug('[useRollingPose] Resetting state');

        // Clear timers
        if (initialWindowTimerRef.current) {
            clearTimeout(initialWindowTimerRef.current);
            initialWindowTimerRef.current = null;
        }
        if (refractoryTimerRef.current) {
            clearTimeout(refractoryTimerRef.current);
            refractoryTimerRef.current = null;
        }

        // Reset all state
        fullTranscriptRef.current = '';
        currentWindowRef.current = '';
        windowStartTimeRef.current = null;
        isInRefractoryRef.current = false;
        pendingGenerationRef.current = false;
        setTranscript('');
        setIsGenerating(false);
    }, []);

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            if (initialWindowTimerRef.current) {
                clearTimeout(initialWindowTimerRef.current);
            }
            if (refractoryTimerRef.current) {
                clearTimeout(refractoryTimerRef.current);
            }
        };
    }, []);

    return {
        isAvailable,
        isGenerating,
        processText,
        reset,
        transcript,
    };
}
