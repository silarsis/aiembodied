/**
 * Hook for fast pose generation using pose library selection.
 * 
 * This is an alternate, faster approach that:
 * 1. Passes available poses to the LLM
 * 2. LLM picks the best matching preset (no structured output)
 * 3. Much faster than generating raw bone data (~500ms vs ~4s)
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AvatarAnimationBus } from '../avatar/animation-bus.js';
import type { FastPoseRequest, FastPoseResult } from '../avatar/types.js';
import { getPreloadApi } from '../preload-api.js';

export interface UseFastPoseOptions {
    /** Whether the hook is enabled */
    enabled?: boolean;
    /** Animation bus for applying poses */
    bus: AvatarAnimationBus | null;
    /** transition duration when applying poses */
    transitionDuration?: number;
    /** Initial window duration in ms (default: 500) */
    initialWindowMs?: number;
    /** Refractory period in ms (default: 1000) */
    refractoryMs?: number;
    /** Available pose slugs to choose from */
    availablePoses?: string[];
    /** Callback to load/apply a preset pose by slug */
    onApplyPreset?: (slug: string) => void;
    /** Callback when a pose is generated */
    onPoseGenerated?: (result: FastPoseResult) => void;
    /** Callback on error */
    onError?: (error: Error) => void;
}

export interface UseFastPoseResult {
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

export function useFastPoseGeneration(options: UseFastPoseOptions): UseFastPoseResult {
    const {
        enabled = true,
        bus,
        transitionDuration = 0.5,
        initialWindowMs = 500,
        refractoryMs = 1000,
        availablePoses = ['default'],
        onApplyPreset,
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
        if (!api?.avatar?.generateFastPose) {
            return null;
        }
        return api.avatar;
    }, []);

    const isAvailable = enabled && !!getAvatarBridge();

    // Debug log on mount
    useEffect(() => {
        const api = getPreloadApi();
        console.info('[useFastPose] Hook initialized:', {
            enabled,
            hasBus: !!bus,
            hasGenerateFastPose: !!api?.avatar?.generateFastPose,
            availablePosesCount: availablePoses.length,
            isAvailable,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);  // Intentionally run only on mount

    // Generate a pose
    const generatePose = useCallback(async () => {
        const avatar = getAvatarBridge();
        if (!avatar) {
            console.warn('[useFastPose] Cannot generate: API not available');
            return;
        }

        const recentText = currentWindowRef.current.trim();
        if (!recentText) {
            console.debug('[useFastPose] No recent text to process');
            return;
        }

        // Clear current window but keep full context
        currentWindowRef.current = '';

        setIsGenerating(true);
        const startTime = performance.now();
        console.info(`[useFastPose] 🎯 Generating: "${recentText.slice(0, 50)}..." (${recentText.length} chars)`);

        try {
            const request: FastPoseRequest = {
                recentText,
                availablePoses,
            };

            if (!avatar.generateFastPose) {
                throw new Error('generateFastPose not available');
            }
            const result = await avatar.generateFastPose(request);
            const elapsed = Math.round(performance.now() - startTime);

            console.info(`[useFastPose] ✅ Generated in ${elapsed}ms: type="${result.type}", preset="${result.presetSlug}", emotion="${result.emotion}"`);

            // Apply the pose
            if (result.type === 'preset' && result.presetSlug) {
                // Use preset callback if provided
                if (onApplyPreset) {
                    onApplyPreset(result.presetSlug);
                }
            } else if (result.type === 'raw' && result.pose && bus) {
                // Apply raw pose data
                bus.applyPose(result.pose, 'fast-pose', transitionDuration);
            }

            onPoseGenerated?.(result);
        } catch (error) {
            const err = error instanceof Error ? error : new Error(String(error));
            console.warn('[useFastPose] ❌ Generation failed:', err.message);
            onError?.(err);
        } finally {
            setIsGenerating(false);
        }
    }, [bus, getAvatarBridge, availablePoses, transitionDuration, onApplyPreset, onPoseGenerated, onError]);

    // Trigger pose generation with refractory handling
    const triggerGeneration = useCallback(() => {
        if (isInRefractoryRef.current) {
            pendingGenerationRef.current = currentWindowRef.current.length > 0;
            console.debug('[useFastPose] In refractory, pending:', pendingGenerationRef.current);
            return;
        }

        generatePose();

        isInRefractoryRef.current = true;
        refractoryTimerRef.current = setTimeout(() => {
            isInRefractoryRef.current = false;

            if (pendingGenerationRef.current && currentWindowRef.current.length > 0) {
                console.debug('[useFastPose] Refractory ended, triggering pending');
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

        fullTranscriptRef.current += text;
        currentWindowRef.current += text;
        setTranscript(fullTranscriptRef.current);

        console.debug(`[useFastPose] Text: "${text.slice(0, 30)}..." (${text.length} chars, window=${currentWindowRef.current.length})`);

        if (windowStartTimeRef.current === null) {
            windowStartTimeRef.current = Date.now();

            console.debug('[useFastPose] Starting initial window timer:', initialWindowMs);
            initialWindowTimerRef.current = setTimeout(() => {
                console.debug('[useFastPose] Initial window complete');
                triggerGeneration();
            }, initialWindowMs);
        }
    }, [isAvailable, initialWindowMs, triggerGeneration]);

    // Reset state
    const reset = useCallback(() => {
        console.debug('[useFastPose] Resetting state');

        if (initialWindowTimerRef.current) {
            clearTimeout(initialWindowTimerRef.current);
            initialWindowTimerRef.current = null;
        }
        if (refractoryTimerRef.current) {
            clearTimeout(refractoryTimerRef.current);
            refractoryTimerRef.current = null;
        }

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
