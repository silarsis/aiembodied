/**
 * MovementAnimator - Plays back a movement timeline by scheduling pose applications.
 * 
 * @example
 * const animator = new MovementAnimator({
 *   bus: animationBus,
 *   timeline: generatedTimeline,
 *   transitionDuration: 0.4,
 * });
 * animator.play();
 */

import type {
    AvatarAnimationBus,
    VRMPoseData,
    PoseTransitionConfig,
} from './animation-bus.js';
import type { MovementKeyframe, MovementTimeline } from './types.js';

export type { MovementKeyframe, MovementTimeline } from './types.js';

export interface MovementAnimatorOptions {
    /** The animation bus to emit poses to */
    bus: AvatarAnimationBus;
    /** The timeline to play back */
    timeline: MovementTimeline;
    /** When to start playback (performance.now() timestamp). Defaults to now. */
    startTime?: number;
    /** Duration for transitions between keyframes (seconds). Default 0.5 */
    transitionDuration?: number;
    /** Configuration for easing/staggering */
    transitionConfig?: PoseTransitionConfig;
    /** Callback when playback completes */
    onComplete?: () => void;
    /** Callback on each keyframe applied */
    onKeyframe?: (index: number, keyframe: MovementKeyframe) => void;
}

export type MovementAnimatorState = 'idle' | 'playing' | 'paused' | 'stopped';

const DEFAULT_TRANSITION_DURATION = 0.5;

/**
 * Plays back a movement timeline by emitting pose events at scheduled times.
 */
export class MovementAnimator {
    private readonly bus: AvatarAnimationBus;
    private readonly timeline: MovementTimeline;
    private readonly transitionDuration: number;
    private readonly transitionConfig?: PoseTransitionConfig;
    private readonly onComplete?: () => void;
    private readonly onKeyframe?: (index: number, keyframe: MovementKeyframe) => void;

    private state: MovementAnimatorState = 'idle';
    private startTime: number = 0;
    private pausedAt: number = 0;
    private currentKeyframeIndex: number = 0;
    private animationFrameId: number | null = null;

    constructor(options: MovementAnimatorOptions) {
        this.bus = options.bus;
        this.timeline = options.timeline;
        this.transitionDuration = options.transitionDuration ?? DEFAULT_TRANSITION_DURATION;
        this.transitionConfig = options.transitionConfig;
        this.onComplete = options.onComplete;
        this.onKeyframe = options.onKeyframe;

        if (options.startTime) {
            this.startTime = options.startTime;
        }
    }

    /**
     * Get current playback state.
     */
    getState(): MovementAnimatorState {
        return this.state;
    }

    /**
     * Get current playback time in seconds since start.
     */
    getCurrentTime(): number {
        if (this.state === 'idle' || this.state === 'stopped') {
            return 0;
        }
        if (this.state === 'paused') {
            return (this.pausedAt - this.startTime) / 1000;
        }
        return (performance.now() - this.startTime) / 1000;
    }

    /**
     * Start or resume playback.
     */
    play(): void {
        if (this.timeline.keyframes.length === 0) {
            this.state = 'stopped';
            this.onComplete?.();
            return;
        }

        if (this.state === 'playing') {
            return; // Already playing
        }

        if (this.state === 'paused') {
            // Resume from paused position
            const pauseDuration = performance.now() - this.pausedAt;
            this.startTime += pauseDuration;
        } else {
            // Fresh start
            this.startTime = performance.now();
            this.currentKeyframeIndex = 0;
        }

        this.state = 'playing';
        this.scheduleNextFrame();
    }

    /**
     * Pause playback. Can be resumed with play().
     */
    pause(): void {
        if (this.state !== 'playing') {
            return;
        }

        this.state = 'paused';
        this.pausedAt = performance.now();
        this.cancelScheduledFrame();
    }

    /**
     * Stop playback and reset to beginning.
     */
    stop(): void {
        this.state = 'stopped';
        this.currentKeyframeIndex = 0;
        this.cancelScheduledFrame();
    }

    /**
     * Reset to idle state for reuse with a new timeline.
     */
    reset(): void {
        this.stop();
        this.state = 'idle';
    }

    private scheduleNextFrame(): void {
        if (this.state !== 'playing') {
            return;
        }

        this.animationFrameId = requestAnimationFrame(() => this.tick());
    }

    private cancelScheduledFrame(): void {
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
    }

    private tick(): void {
        if (this.state !== 'playing') {
            return;
        }

        const currentTime = this.getCurrentTime();
        const keyframes = this.timeline.keyframes;

        // Apply any keyframes that should have triggered
        while (this.currentKeyframeIndex < keyframes.length) {
            const keyframe = keyframes[this.currentKeyframeIndex];
            if (!keyframe) break;

            if (keyframe.time <= currentTime) {
                this.applyKeyframe(this.currentKeyframeIndex, keyframe);
                this.currentKeyframeIndex++;
            } else {
                // Next keyframe is in the future
                break;
            }
        }

        // Check if we've finished
        if (this.currentKeyframeIndex >= keyframes.length) {
            this.state = 'stopped';
            this.onComplete?.();
            return;
        }

        // Continue playback
        this.scheduleNextFrame();
    }

    private applyKeyframe(index: number, keyframe: MovementKeyframe): void {
        // Convert keyframe pose to VRMPoseData format
        const poseData: VRMPoseData = {
            bones: keyframe.pose.bones,
            expressions: keyframe.pose.expressions as VRMPoseData['expressions'],
        };

        // Calculate transition duration - use time to next keyframe if available
        let duration = this.transitionDuration;
        const nextKeyframe = this.timeline.keyframes[index + 1];
        if (nextKeyframe) {
            const timeToNext = nextKeyframe.time - keyframe.time;
            // Use 80% of time to next keyframe, capped at our default
            duration = Math.min(timeToNext * 0.8, this.transitionDuration);
        }

        this.bus.applyPose(
            poseData,
            'movement-animator',
            duration,
            this.transitionConfig
        );

        this.onKeyframe?.(index, keyframe);
    }
}
