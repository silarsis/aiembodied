import type OpenAI from 'openai';
import type { ResponseInput } from 'openai/resources/responses/responses';
import type {
    AvatarPoseData,
    AvatarPoseUploadResult,
    PoseEvaluationRequest,
    PoseEvaluationResult,
} from './types.js';
import type { AvatarPoseService } from './avatar-pose-service.js';

export interface PoseEvaluationServiceOptions {
    client: OpenAI;
    poseService: AvatarPoseService;
    logger?: {
        info?: (message: string, meta?: Record<string, unknown>) => void;
        warn?: (message: string, meta?: Record<string, unknown>) => void;
        error?: (message: string, meta?: Record<string, unknown>) => void;
    };
}

const POSE_EVALUATOR_SYSTEM_PROMPT = [
    'You are an expert VRM pose evaluator and movement analyst.',
    '',
    'Your task is to evaluate whether a VRM character pose effectively represents the described intent.',
    'You will receive:',
    '1. An image of the current pose',
    '2. The JSON data describing the pose rotations',
    '3. The original prompt describing what the pose should look like',
    '4. Optional user feedback about what to improve',
    '',
    'Analyze the pose and provide:',
    '- Whether the pose meets the requirement (true/false)',
    '- Detailed feedback on what works and what does not',
    '- Specific improvement suggestions if the pose needs refinement',
    '',
    'Be specific about anatomical issues, expressiveness, and whether the pose matches the intent.',
    'Focus on practical improvements that can be achieved through bone rotations.',
].join('\n');

const POSE_REFINER_SYSTEM_PROMPT = [
    'You are a VRM pose refinement specialist.',
    '',
    'Your task is to take an existing pose and feedback, then generate an improved version.',
    'You will receive:',
    '1. The current pose JSON with bone rotations',
    '2. Feedback on what needs to be improved',
    '3. The original intent/prompt for the pose',
    '',
    'Generate a new pose JSON that addresses the feedback while maintaining the original intent.',
    'Use the same bone structure as the input pose.',
    'All rotations should be quaternions [x, y, z, w] relative to T-pose.',
    '',
    'IMPORTANT:',
    '- Apply the symmetry rule: for left/right pairs, negate Y and Z between sides',
    '- Ensure anatomically plausible rotations',
    '- Preserve any successful aspects of the original pose',
].join('\n');

const POSE_EVALUATION_SCHEMA = {
    type: 'object' as const,
    additionalProperties: false,
    required: ['meetsRequirement', 'feedback', 'suggestedImprovements'],
    properties: {
        meetsRequirement: {
            type: 'boolean' as const,
            description: 'Whether the pose effectively represents the intended prompt',
        },
        feedback: {
            type: 'string' as const,
            description: 'Detailed assessment of the pose quality and how well it matches the intent',
        },
        suggestedImprovements: {
            type: 'array' as const,
            items: { type: 'string' as const },
            description: 'Specific improvements to make the pose better match the intent',
        },
    },
};

export class PoseEvaluationService {
    private readonly client: OpenAI;
    private readonly poseService: AvatarPoseService;
    private readonly logger?: PoseEvaluationServiceOptions['logger'];

    constructor(options: PoseEvaluationServiceOptions) {
        this.client = options.client;
        this.poseService = options.poseService;
        this.logger = options.logger;
    }

    /**
     * Evaluate a pose using vision LLM to assess how well it matches the intent.
     */
    async evaluatePose(request: PoseEvaluationRequest): Promise<PoseEvaluationResult> {
        const { poseData, imageDataUrl, originalPrompt, userFeedback } = request;

        if (!imageDataUrl || !imageDataUrl.startsWith('data:image/')) {
            throw new Error('Valid image data URL is required for pose evaluation.');
        }

        if (!originalPrompt?.trim()) {
            throw new Error('Original prompt is required for pose evaluation.');
        }

        const poseJsonStr = JSON.stringify(poseData, null, 2);

        // Build user message with image and context
        let userContent = [
            `Original pose request: "${originalPrompt}"`,
            '',
            'Current pose data:',
            '```json',
            poseJsonStr,
            '```',
        ].join('\n');

        if (userFeedback?.trim()) {
            userContent += `\n\nUser feedback: "${userFeedback}"`;
        }

        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: POSE_EVALUATOR_SYSTEM_PROMPT }],
            },
            {
                type: 'message',
                role: 'user',
                content: [
                    {
                        type: 'input_image',
                        image_url: imageDataUrl,
                    },
                    {
                        type: 'input_text',
                        text: userContent,
                    },
                ],
            },
        ];

        this.logger?.info?.('Evaluating pose with vision LLM', {
            promptLength: originalPrompt.length,
            hasFeedback: !!userFeedback,
            boneCount: Object.keys(poseData.bones).length,
        });

        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: 'gpt-4o',
            input: messages,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'pose_evaluation',
                    schema: POSE_EVALUATION_SCHEMA as unknown,
                    strict: true,
                },
            },
        });

        const outputText = response.output_text;
        if (!outputText) {
            throw new Error('Empty response from pose evaluator');
        }

        let parsed: {
            meetsRequirement?: boolean;
            feedback?: string;
            suggestedImprovements?: string[];
        };

        try {
            parsed = JSON.parse(outputText) as typeof parsed;
        } catch (parseError) {
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            this.logger?.error?.('Failed to parse evaluation response', { message, preview: outputText.slice(0, 200) });
            throw new Error(`Pose evaluation returned invalid JSON: ${message}`);
        }

        const result: PoseEvaluationResult = {
            meetsRequirement: parsed.meetsRequirement ?? false,
            feedback: parsed.feedback ?? 'Unable to evaluate pose.',
            suggestedImprovements: parsed.suggestedImprovements,
        };

        this.logger?.info?.('Pose evaluation complete', {
            meetsRequirement: result.meetsRequirement,
            feedbackLength: result.feedback.length,
            suggestionCount: result.suggestedImprovements?.length ?? 0,
        });

        return result;
    }

    /**
     * Generate a refined pose based on evaluation feedback.
     */
    async refinePose(request: PoseEvaluationRequest): Promise<AvatarPoseUploadResult> {
        const { poseData, originalPrompt, userFeedback, bones, boneHierarchy, modelDescription } = request;

        if (!originalPrompt?.trim()) {
            throw new Error('Original prompt is required for pose refinement.');
        }

        const feedback = userFeedback?.trim();
        if (!feedback) {
            throw new Error('Feedback is required for pose refinement.');
        }

        const poseJsonStr = JSON.stringify(poseData, null, 2);

        // Build the refinement prompt
        let refinementContext = [
            `Original pose request: "${originalPrompt}"`,
            '',
            'Current pose that needs improvement:',
            '```json',
            poseJsonStr,
            '```',
            '',
            `Feedback to address: "${feedback}"`,
        ].join('\n');

        if (modelDescription) {
            refinementContext += `\n\nCharacter description: ${modelDescription}`;
        }

        const messages: ResponseInput = [
            {
                type: 'message',
                role: 'system',
                content: [{ type: 'input_text', text: POSE_REFINER_SYSTEM_PROMPT }],
            },
            {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: refinementContext }],
            },
        ];

        // Build pose schema for structured output
        const boneList = bones ?? Object.keys(poseData.bones);
        const boneSchema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['rotation', 'position'],
            properties: {
                rotation: {
                    type: 'array' as const,
                    items: { type: 'number' as const },
                    minItems: 4,
                    maxItems: 4,
                },
                position: {
                    anyOf: [
                        { type: 'null' as const },
                        {
                            type: 'array' as const,
                            items: { type: 'number' as const },
                            minItems: 3,
                            maxItems: 3,
                        },
                    ],
                },
            },
        };

        const boneProperties: Record<string, typeof boneSchema> = {};
        for (const bone of boneList) {
            boneProperties[bone] = boneSchema;
        }

        const expressionPresetNames = ['happy', 'angry', 'sad', 'relaxed', 'surprised', 'neutral'] as const;
        const expressionPresetProperties: Record<string, { type: 'number' }> = {};
        for (const preset of expressionPresetNames) {
            expressionPresetProperties[preset] = { type: 'number' as const };
        }

        const schema = {
            type: 'object' as const,
            additionalProperties: false,
            required: ['bones', 'expressions'],
            properties: {
                bones: {
                    type: 'object' as const,
                    additionalProperties: false,
                    required: boneList,
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
        };

        this.logger?.info?.('Refining pose with LLM', {
            promptLength: originalPrompt.length,
            feedbackLength: feedback.length,
            boneCount: boneList.length,
        });

        const response = await (
            this.client as unknown as {
                responses: { create: (args: unknown) => Promise<{ output_text: string }> };
            }
        ).responses.create({
            model: 'gpt-4o',
            input: messages,
            text: {
                format: {
                    type: 'json_schema',
                    name: 'vrm_pose',
                    schema: schema as unknown,
                    strict: true,
                },
            },
        });

        const outputText = response.output_text;
        if (!outputText) {
            throw new Error('Empty response from pose refiner');
        }

        let parsed: {
            bones?: Record<string, unknown>;
            expressions?: { presets?: Record<string, unknown> };
        };

        try {
            parsed = JSON.parse(outputText) as typeof parsed;
        } catch (parseError) {
            const message = parseError instanceof Error ? parseError.message : String(parseError);
            this.logger?.error?.('Failed to parse refinement response', { message, preview: outputText.slice(0, 200) });
            throw new Error(`Pose refinement returned invalid JSON: ${message}`);
        }

        // Validate and build result pose
        const resultBones: Record<string, { rotation: number[]; position?: number[] | null }> = {};
        const bonesData = parsed.bones ?? {};

        for (const [boneName, boneData] of Object.entries(bonesData)) {
            if (typeof boneData !== 'object' || boneData === null) {
                continue;
            }

            const data = boneData as { rotation?: unknown; position?: unknown };

            if (!Array.isArray(data.rotation) || data.rotation.length !== 4) {
                continue;
            }

            const rotation = data.rotation as number[];
            if (!rotation.every((n) => typeof n === 'number' && Number.isFinite(n))) {
                continue;
            }

            const entry: { rotation: number[]; position?: number[] | null } = { rotation };

            if (data.position !== null && data.position !== undefined) {
                if (Array.isArray(data.position) && data.position.length === 3) {
                    const position = data.position as number[];
                    if (position.every((n) => typeof n === 'number' && Number.isFinite(n))) {
                        entry.position = position;
                    }
                }
            }

            resultBones[boneName] = entry;
        }

        if (Object.keys(resultBones).length === 0) {
            throw new Error('Pose refinement produced no valid bones.');
        }

        // Parse expressions
        const expressionsData = parsed.expressions ?? {};
        const resultExpressions: AvatarPoseData['expressions'] = {};

        if (expressionsData.presets && typeof expressionsData.presets === 'object') {
            const presets: Partial<Record<string, number>> = {};
            for (const [name, weight] of Object.entries(expressionsData.presets)) {
                if (typeof weight === 'number' && Number.isFinite(weight)) {
                    presets[name] = Math.max(0, Math.min(1, weight));
                }
            }
            if (Object.keys(presets).length > 0) {
                resultExpressions.presets = presets as AvatarPoseData['expressions']['presets'];
            }
        }

        const refinedPose: AvatarPoseData = {
            bones: resultBones,
            expressions: Object.keys(resultExpressions).length > 0 ? resultExpressions : undefined,
        };

        // Save the refined pose
        const fileName = `refined-${Date.now()}.pose.json`;
        const data = JSON.stringify(refinedPose, null, 2);

        const result = await this.poseService.uploadPose({
            fileName,
            data,
            name: `${originalPrompt} (refined)`,
        });

        this.logger?.info?.('Pose refinement complete', {
            poseId: result.pose.id,
            boneCount: Object.keys(resultBones).length,
            hasExpressions: !!refinedPose.expressions,
        });

        return result;
    }
}
