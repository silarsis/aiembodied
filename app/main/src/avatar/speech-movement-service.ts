/**
 * Service for generating movement timelines from speech transcripts.
 * Uses a fast LLM to analyze speech and produce synchronized gestures.
 */

import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type {
    MovementTimeline,
    MovementKeyframe,
    SpeechMovementRequest,
    StreamingPoseRequest,
    SinglePoseResult,
    FastPoseRequest,
    FastPoseResult,
    AvatarPoseData,
    PoseExpressionState,
} from './types.js';
import {
    POSE_AXIS_MAPPING,
    POSE_EXPRESSION_GUIDANCE,
    POSE_MAGNITUDE_GUIDE,
    POSE_ROTATION_GUIDANCE,
    POSE_SYMMETRY_RULE,
    formatBoneHierarchy,
} from './pose-prompts.js';

export interface SpeechMovementServiceOptions {
    client: OpenAI;
    model?: string;
    logger?: {
        info?: (message: string, meta?: Record<string, unknown>) => void;
        warn?: (message: string, meta?: Record<string, unknown>) => void;
        error?: (message: string, meta?: Record<string, unknown>) => void;
    };
}

const MOVEMENT_SYSTEM_PROMPT = [
    'You are an expert character animator specializing in gesture and body language.',
    '',
    'Your task is to analyze a speech transcript and generate a timeline of body poses',
    'that naturally accompany the spoken content.',
    '',
    'Guidelines for gesture timing:',
    '- Gestures should slightly LEAD or COINCIDE with the speech they emphasize',
    '- Use poses to punctuate important words or emotional moments',
    '- Include subtle movements during pauses (weight shifts, head tilts)',
    '- Keep movements natural and not overly theatrical',
    '- Space keyframes 0.5-2 seconds apart for fluid motion',
    '',
    'Output format:',
    '- Return a timeline with keyframes at specific time offsets',
    '- Each keyframe has a target pose with bone rotations',
    '- Include emotion hints (happy, neutral, surprised, etc.)',
    '- First keyframe should be at time 0.0 or close to it',
    '',
    'Pose data format (VRM humanoid):',
    '- Each bone has a rotation as quaternion [x, y, z, w]',
    '- Identity rotation [0, 0, 0, 1] means T-pose (no change)',
    '- Focus on expressive bones: head, neck, chest, arms, hands',
    '- Keep leg rotations minimal unless walking/shifting weight',
].join('\n');

const MOVEMENT_OUTPUT_REQUIREMENTS = [
    'IMPORTANT - Output Requirements:',
    '- Output ONLY valid JSON matching the schema',
    '- Provide 2-5 keyframes depending on speech length',
    '- Times must be in ascending order',
    '- All rotations must be valid quaternions [x, y, z, w]',
    '- Use identity [0, 0, 0, 1] for bones that should not move',
    '- Include expressions that match the emotional tone',
].join('\n');

/**
 * Service that converts speech transcripts into animated movement timelines.
 */
export class SpeechMovementService {
    private readonly client: OpenAI;
    private readonly model: string;
    private readonly logger?: SpeechMovementServiceOptions['logger'];

    constructor(options: SpeechMovementServiceOptions) {
        this.client = options.client;
        this.model = options.model ?? 'gpt-4o-mini';
        this.logger = options.logger;
    }

    /**
     * Generate a movement timeline from a speech transcript.
     */
    async generateTimeline(request: SpeechMovementRequest): Promise<MovementTimeline> {
        const transcript = typeof request?.transcript === 'string' ? request.transcript.trim() : '';
        if (!transcript) {
            this.logger?.warn?.('Empty transcript provided for movement generation');
            return { duration: 0, keyframes: [] };
        }

        const bones = this.normalizeBones(request?.bones);
        const boneHierarchy = request?.boneHierarchy ?? {};
        const speechDuration = typeof request?.speechDuration === 'number' ? request.speechDuration : undefined;

        // Build system prompt with all guidance
        const hierarchyText = formatBoneHierarchy(boneHierarchy);
        const systemPrompt = [
            MOVEMENT_SYSTEM_PROMPT,
            '',
            hierarchyText,
            '',
            POSE_ROTATION_GUIDANCE,
            '',
            POSE_AXIS_MAPPING,
            '',
            POSE_MAGNITUDE_GUIDE,
            '',
            POSE_SYMMETRY_RULE,
            '',
            POSE_EXPRESSION_GUIDANCE,
            '',
            MOVEMENT_OUTPUT_REQUIREMENTS,
        ].join('\n');

        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: systemPrompt }],
            },
        ];

        if (request?.modelDescription) {
            messages.push({
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: `Character: ${request.modelDescription}` }],
            });
        }

        if (bones.length > 0) {
            messages.push({
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: `Available bones: ${bones.join(', ')}` }],
            });
        }

        // Build the user request
        const userContent = speechDuration !== undefined
            ? `Speech transcript (estimated ${speechDuration.toFixed(1)}s):\n"${transcript}"`
            : `Speech transcript:\n"${transcript}"`;

        messages.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: userContent }],
        });

        // Build JSON schema for the response
        const schema = this.buildTimelineSchema(bones);

        this.logger?.info?.('Generating movement timeline', {
            transcriptLength: transcript.length,
            boneCount: bones.length,
            speechDuration,
        });

        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: this.model,
            input: messages,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'movement_timeline',
                    schema: schema as unknown,
                    strict: true,
                },
            },
        });

        const outputText = response.output_text;
        if (!outputText) {
            this.logger?.error?.('Empty response from movement generator');
            return { duration: 0, keyframes: [] };
        }

        return this.parseTimeline(outputText, bones, speechDuration);
    }

    /**
     * Generate a single pose from a streaming text segment.
     * Faster than generateTimeline - designed for real-time rolling window approach.
     */
    async generateSinglePose(request: StreamingPoseRequest): Promise<SinglePoseResult> {
        const recentText = typeof request?.recentText === 'string' ? request.recentText.trim() : '';
        if (!recentText) {
            this.logger?.warn?.('Empty recent text provided for single pose generation');
            return { pose: { bones: {} } };
        }

        // OPTIMIZATION: Use only expressive bones to minimize schema size and generation time
        // Full skeleton has 54+ bones, but we only need ~10 for expressive poses
        const expressiveBones = [
            'head', 'neck', 'chest', 'spine',
            'leftShoulder', 'leftUpperArm',
            'rightShoulder', 'rightUpperArm',
        ];
        const bones = expressiveBones;

        // OPTIMIZATION: Short, focused prompt for speed
        const systemPrompt = `You are animating a character based on speech. Output ONE pose.

Bones: ${bones.join(', ')}
Each bone needs rotation as quaternion [x, y, z, w]. Identity=[0,0,0,1].
Small rotations (~0.1-0.2) create subtle movements. Head tilts, shoulder shrugs, chest lean.

expressions.presets: happy (0-1), neutral (0-1). Should sum to ~1.

Match the emotional tone of the speech.`;

        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: systemPrompt }],
            },
        ];

        // OPTIMIZATION: Minimal user message - just the recent speech
        // Skip full context to reduce tokens
        const userContent = `Speech: "${recentText}"`;

        messages.push({
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: userContent }],
        });

        // Build simpler schema for single pose
        const schema = this.buildSinglePoseSchema(bones);

        this.logger?.info?.('Generating single pose', {
            recentTextLength: recentText.length,
            boneCount: bones.length,
        });

        const llmStartTime = Date.now();
        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: this.model,
            input: messages,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'single_pose',
                    schema: schema as unknown,
                    strict: true,
                },
            },
        });
        const llmElapsed = Date.now() - llmStartTime;

        const outputText = response.output_text;
        if (!outputText) {
            this.logger?.error?.('Empty response from single pose generator');
            return { pose: { bones: {} } };
        }

        const parseStartTime = Date.now();
        const result = this.parseSinglePose(outputText, new Set(bones));
        const parseElapsed = Date.now() - parseStartTime;

        this.logger?.info?.('Single pose timing', {
            llmMs: llmElapsed,
            parseMs: parseElapsed,
            totalMs: llmElapsed + parseElapsed,
            outputLength: outputText.length,
        });

        return result;
    }

    /**
     * Fast pose generation using pose library selection.
     * Does NOT use structured output for faster response.
     * LLM picks from available presets or generates simple raw pose.
     */
    async generateFastPose(request: FastPoseRequest): Promise<FastPoseResult> {
        const recentText = typeof request?.recentText === 'string' ? request.recentText.trim() : '';
        if (!recentText) {
            this.logger?.warn?.('Empty recent text provided for fast pose generation');
            return { type: 'preset', presetSlug: 'default', emotion: 'neutral' };
        }

        const availablePoses = Array.isArray(request.availablePoses) && request.availablePoses.length > 0
            ? request.availablePoses
            : ['default'];

        // Short, focused prompt for speed
        const systemPrompt = `Pick the best pose for the speech from the list. Respond with ONLY JSON.

Available poses: ${availablePoses.join(', ')}

Response format:
{"type":"preset","pose":"<slug>","emotion":"<mood>"}

If no pose fits well, use "default".`;

        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: systemPrompt }],
            },
            {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: `Speech: "${recentText}"` }],
            },
        ];

        this.logger?.info?.('Generating fast pose', {
            recentTextLength: recentText.length,
            availablePosesCount: availablePoses.length,
        });

        const llmStartTime = Date.now();
        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: this.model,
            input: messages,
            // NO structured output - let it respond freely for speed
        });
        const llmElapsed = Date.now() - llmStartTime;

        const outputText = response.output_text?.trim() ?? '';
        this.logger?.info?.('Fast pose timing', {
            llmMs: llmElapsed,
            outputLength: outputText.length,
            output: outputText.slice(0, 100),
        });

        if (!outputText) {
            this.logger?.warn?.('Empty response from fast pose generator');
            return { type: 'preset', presetSlug: 'default', emotion: 'neutral' };
        }

        // Parse the JSON response
        return this.parseFastPoseResponse(outputText, availablePoses);
    }

    private parseFastPoseResponse(outputText: string, availablePoses: string[]): FastPoseResult {
        // Try to extract JSON from the response
        const jsonMatch = outputText.match(/\{[^}]+\}/);
        if (!jsonMatch) {
            this.logger?.warn?.('No JSON found in fast pose response', { outputText: outputText.slice(0, 100) });
            return { type: 'preset', presetSlug: 'default', emotion: 'neutral' };
        }

        try {
            const parsed = JSON.parse(jsonMatch[0]) as {
                type?: string;
                pose?: string;
                emotion?: string;
            };

            const poseSlug = parsed.pose?.toLowerCase().trim() ?? 'default';
            const emotion = parsed.emotion ?? 'neutral';

            // Validate the pose is in the available list
            if (availablePoses.includes(poseSlug)) {
                return { type: 'preset', presetSlug: poseSlug, emotion };
            }

            // Try fuzzy match
            const fuzzyMatch = availablePoses.find(p =>
                p.includes(poseSlug) || poseSlug.includes(p)
            );
            if (fuzzyMatch) {
                return { type: 'preset', presetSlug: fuzzyMatch, emotion };
            }

            this.logger?.warn?.('Pose not in available list, using default', { requested: poseSlug, available: availablePoses });
            return { type: 'preset', presetSlug: 'default', emotion };
        } catch (parseError) {
            this.logger?.warn?.('Failed to parse fast pose JSON', { error: String(parseError), outputText: outputText.slice(0, 100) });
            return { type: 'preset', presetSlug: 'default', emotion: 'neutral' };
        }
    }

    private buildSinglePoseSchema(bones: string[]): object {
        // Simpler bone schema for faster generation
        const boneSchema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['rotation'],
            properties: {
                rotation: {
                    type: 'array' as const,
                    items: { type: 'number' as const },
                    minItems: 4,
                    maxItems: 4,
                },
            },
        };

        const boneProperties: Record<string, typeof boneSchema> = {};
        for (const bone of bones) {
            boneProperties[bone] = boneSchema;
        }

        // OPTIMIZATION: Simplified expression - just happy and neutral weights
        // This reduces output tokens significantly
        const expressionPresetNames = ['happy', 'neutral'] as const;
        const expressionPresetProperties: Record<string, { type: 'number' }> = {};
        for (const preset of expressionPresetNames) {
            expressionPresetProperties[preset] = { type: 'number' as const };
        }

        return {
            type: 'object' as const,
            additionalProperties: false,
            required: ['emotion', 'pose'],
            properties: {
                emotion: { type: 'string' as const },
                pose: {
                    type: 'object' as const,
                    additionalProperties: false,
                    required: ['bones', 'expressions'],
                    properties: {
                        bones: {
                            type: 'object' as const,
                            additionalProperties: false,
                            required: bones,
                            properties: boneProperties,
                        },
                        expressions: {
                            type: 'object' as const,
                            additionalProperties: false,
                            required: ['presets'],
                            properties: {
                                presets: {
                                    type: 'object' as const,
                                    additionalProperties: false,
                                    required: expressionPresetNames as unknown as string[],
                                    properties: expressionPresetProperties,
                                },
                            },
                        },
                    },
                },
            },
        };
    }

    private parseSinglePose(outputText: string, validBones: Set<string>): SinglePoseResult {
        let parsed: { emotion?: string; pose?: unknown };
        try {
            parsed = JSON.parse(outputText) as typeof parsed;
        } catch (parseError) {
            const preview = outputText.slice(0, 200);
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            this.logger?.error?.('Failed to parse single pose JSON', { message, preview });
            return { pose: { bones: {} } };
        }

        const emotion = typeof parsed.emotion === 'string' ? parsed.emotion : undefined;
        const warnings: string[] = [];
        const pose = this.parsePose(parsed.pose, validBones, warnings, 0);

        if (warnings.length > 0) {
            this.logger?.warn?.('Single pose parsing had issues', { warnings });
        }

        if (!pose) {
            return { pose: { bones: {} }, emotion };
        }

        this.logger?.info?.('Single pose generated', { emotion, boneCount: Object.keys(pose.bones).length });
        return { pose, emotion };
    }
    private buildTimelineSchema(bones: string[]): object {
        // Build bone properties for the schema
        const boneSchema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['rotation'],
            properties: {
                rotation: {
                    type: 'array' as const,
                    items: { type: 'number' as const },
                    minItems: 4,
                    maxItems: 4,
                },
            },
        };

        const boneProperties: Record<string, typeof boneSchema> = {};
        for (const bone of bones) {
            boneProperties[bone] = boneSchema;
        }

        // Expression presets
        const expressionPresetNames = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'] as const;
        const expressionPresetProperties: Record<string, { type: 'number' }> = {};
        for (const preset of expressionPresetNames) {
            expressionPresetProperties[preset] = { type: 'number' as const };
        }

        // Keyframe schema
        const keyframeSchema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['time', 'pose', 'emotion'],  // All properties must be in required for strict mode
            properties: {
                time: { type: 'number' as const },
                emotion: { type: 'string' as const },
                pose: {
                    type: 'object' as const,
                    additionalProperties: false,
                    required: ['bones', 'expressions'],
                    properties: {
                        bones: {
                            type: 'object' as const,
                            additionalProperties: false,
                            required: bones,
                            properties: boneProperties,
                        },
                        expressions: {
                            type: 'object' as const,
                            additionalProperties: false,
                            required: ['presets'],
                            properties: {
                                presets: {
                                    type: 'object' as const,
                                    additionalProperties: false,
                                    required: expressionPresetNames as unknown as string[],
                                    properties: expressionPresetProperties,
                                },
                            },
                        },
                    },
                },
            },
        };

        return {
            type: 'object' as const,
            additionalProperties: false,
            required: ['duration', 'keyframes'],
            properties: {
                duration: { type: 'number' as const },
                keyframes: {
                    type: 'array' as const,
                    items: keyframeSchema,
                },
            },
        };
    }

    private parseTimeline(outputText: string, validBones: string[], estimatedDuration?: number): MovementTimeline {
        let parsed: { duration?: number; keyframes?: unknown[] };
        try {
            parsed = JSON.parse(outputText) as typeof parsed;
        } catch (parseError) {
            const preview = outputText.slice(0, 200);
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            this.logger?.error?.('Failed to parse movement timeline JSON', { message, preview });
            return { duration: 0, keyframes: [] };
        }

        const duration = typeof parsed.duration === 'number' ? parsed.duration : (estimatedDuration ?? 0);
        const rawKeyframes = Array.isArray(parsed.keyframes) ? parsed.keyframes : [];
        const keyframes: MovementKeyframe[] = [];
        const warnings: string[] = [];
        const validBoneSet = new Set(validBones);

        for (const [index, rawKeyframe] of rawKeyframes.entries()) {
            if (typeof rawKeyframe !== 'object' || rawKeyframe === null) {
                warnings.push(`Keyframe ${index}: invalid format`);
                continue;
            }

            const kf = rawKeyframe as { time?: unknown; pose?: unknown; emotion?: unknown };
            const time = typeof kf.time === 'number' ? kf.time : null;
            if (time === null) {
                warnings.push(`Keyframe ${index}: missing or invalid time`);
                continue;
            }

            const pose = this.parsePose(kf.pose, validBoneSet, warnings, index);
            if (!pose) {
                continue;
            }

            const emotion = typeof kf.emotion === 'string' ? kf.emotion : undefined;

            keyframes.push({ time, pose, emotion });
        }

        // Sort keyframes by time
        keyframes.sort((a, b) => a.time - b.time);

        if (warnings.length > 0) {
            this.logger?.warn?.('Movement timeline parsing had issues', { warnings, keyframeCount: keyframes.length });
        }

        this.logger?.info?.('Movement timeline generated', {
            duration,
            keyframeCount: keyframes.length,
        });

        return { duration, keyframes };
    }

    private parsePose(
        rawPose: unknown,
        validBones: Set<string>,
        warnings: string[],
        keyframeIndex: number
    ): AvatarPoseData | null {
        if (typeof rawPose !== 'object' || rawPose === null) {
            warnings.push(`Keyframe ${keyframeIndex}: missing pose`);
            return null;
        }

        const poseObj = rawPose as { bones?: unknown; expressions?: unknown };
        const rawBones = typeof poseObj.bones === 'object' && poseObj.bones !== null ? poseObj.bones : {};
        const rawExpressions = typeof poseObj.expressions === 'object' && poseObj.expressions !== null ? poseObj.expressions : {};

        const bones: Record<string, { rotation: number[]; position?: number[] | null }> = {};

        for (const [boneName, boneData] of Object.entries(rawBones as Record<string, unknown>)) {
            if (!validBones.has(boneName)) {
                continue; // Silently skip unknown bones
            }

            if (typeof boneData !== 'object' || boneData === null) {
                continue;
            }

            const rotation = (boneData as { rotation?: unknown }).rotation;
            if (!Array.isArray(rotation) || rotation.length !== 4) {
                continue;
            }

            if (!rotation.every(n => typeof n === 'number' && Number.isFinite(n))) {
                continue;
            }

            bones[boneName] = { rotation: rotation as number[] };
        }

        if (Object.keys(bones).length === 0) {
            warnings.push(`Keyframe ${keyframeIndex}: no valid bones`);
            return null;
        }

        // Parse expressions
        const expressions: PoseExpressionState = {};
        const presetsObj = (rawExpressions as { presets?: unknown }).presets;
        if (typeof presetsObj === 'object' && presetsObj !== null) {
            const presets: Partial<Record<string, number>> = {};
            const validPresetNames = new Set(['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral']);
            for (const [name, weight] of Object.entries(presetsObj as Record<string, unknown>)) {
                if (!validPresetNames.has(name)) continue;
                if (typeof weight === 'number' && Number.isFinite(weight)) {
                    presets[name] = Math.max(0, Math.min(1, weight));
                }
            }
            if (Object.keys(presets).length > 0) {
                expressions.presets = presets as PoseExpressionState['presets'];
            }
        }

        return {
            bones,
            expressions: Object.keys(expressions).length > 0 ? expressions : undefined,
        };
    }

    private normalizeBones(bones?: string[]): string[] {
        if (!Array.isArray(bones)) {
            // Default to common expressive bones if none provided
            return [
                'hips', 'spine', 'chest', 'upperChest',
                'neck', 'head',
                'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand',
                'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
            ];
        }
        return Array.from(new Set(
            bones.filter(b => typeof b === 'string' && b.length > 0).map(b => b.trim())
        )).sort();
    }
}
